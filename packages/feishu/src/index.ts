import type {
  TesseraAgentIdentity,
  TesseraFeishuDocument,
  TesseraFeishuDocumentReference,
  TesseraFeishuReader,
  TesseraFeishuSearchResult,
} from "@open-tessera/agent";
import { createHash } from "node:crypto";
import { z } from "zod";

export type FeishuTokenProvider = Readonly<{
  getAccessToken(input: Readonly<{ identity: TesseraAgentIdentity; signal: AbortSignal }>): Promise<string>;
}>;

export type FeishuApiReaderOptions = Readonly<{
  tokenProvider: FeishuTokenProvider;
  baseUrl?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  maxResponseBytes?: number;
}>;

export type FeishuOAuthOptions = Readonly<{
  appId: string;
  redirectUri: string;
  state: string;
  scope?: string;
  baseUrl?: string;
  codeChallenge?: string;
}>;

export type FeishuOAuthTokenResponse = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  openId?: string;
  tenantKey?: string;
}>;

const searchResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z.object({
    docs_entities: z.array(z.record(z.string(), z.unknown())).optional(),
    has_more: z.boolean().optional(),
  }).optional(),
}).passthrough();

const rawContentResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z.object({
    content: z.string().optional(),
  }).optional(),
}).passthrough();

const DEFAULT_BASE_URL = "https://open.feishu.cn";
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Creates the OAuth authorization URL; state must be generated and checked by the host. */
export function createFeishuOAuthUrl(options: FeishuOAuthOptions): string {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const url = new URL("/open-apis/authen/v1/authorize", baseUrl);
  url.searchParams.set("client_id", options.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  if (options.scope) url.searchParams.set("scope", options.scope);
  if (options.codeChallenge) {
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Exchanges a one-time OAuth code. The app secret remains in the host process. */
export async function exchangeFeishuOAuthCode(input: Readonly<{
  appId: string;
  appSecret: string;
  code: string;
  redirectUri?: string;
  codeVerifier?: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  baseUrl?: string;
  signal?: AbortSignal;
}>): Promise<FeishuOAuthTokenResponse> {
  const request = input.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL);
  const response = await request(new URL("/open-apis/authen/v2/oauth/token", baseUrl), {
    method: "POST",
    signal: input.signal,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      client_id: input.appId,
      client_secret: input.appSecret,
      code: input.code,
      grant_type: "authorization_code",
      ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
    }),
  });
  const body = await readJsonBounded(response, DEFAULT_MAX_RESPONSE_BYTES);
  const parsed = z.object({
    code: z.number().int().default(0),
    msg: z.string().optional(),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive().optional(),
    refresh_expires_in: z.number().int().positive().optional(),
    open_id: z.string().optional(),
    tenant_key: z.string().optional(),
  }).passthrough().safeParse(body);
  const data = parsed.success && parsed.data.code === 0 ? parsed.data : undefined;
  if (!response.ok || !parsed.success || data === undefined) {
    throw new Error("Feishu OAuth token exchange failed.");
  }
  return {
    accessToken: data.access_token,
    ...(data.refresh_token === undefined ? {} : { refreshToken: data.refresh_token }),
    ...(data.expires_in === undefined ? {} : { expiresIn: data.expires_in }),
    ...(data.refresh_expires_in === undefined ? {} : { refreshTokenExpiresIn: data.refresh_expires_in }),
    ...(data.open_id === undefined ? {} : { openId: data.open_id }),
    ...(data.tenant_key === undefined ? {} : { tenantKey: data.tenant_key }),
  };
}

/** Refreshes the user token; callers must persist a rotated refresh token. */
export async function refreshFeishuOAuthToken(input: Readonly<{
  appId: string;
  appSecret: string;
  refreshToken: string;
  signal?: AbortSignal;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}>): Promise<FeishuOAuthTokenResponse> {
  const response = await (input.fetch ?? globalThis.fetch)("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST", signal: input.signal,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: input.appId, client_secret: input.appSecret, refresh_token: input.refreshToken }),
  });
  const parsed = z.object({
    code: z.number().default(0), access_token: z.string().min(1),
    refresh_token: z.string().optional(), expires_in: z.number().positive(),
    refresh_token_expires_in: z.number().positive().optional(),
  }).safeParse(await readJsonBounded(response, DEFAULT_MAX_RESPONSE_BYTES));
  if (!response.ok || !parsed.success || parsed.data.code !== 0) throw new Error("Feishu authorization expired. Please reconnect Feishu.");
  return { accessToken: parsed.data.access_token, expiresIn: parsed.data.expires_in,
    refreshToken: parsed.data.refresh_token ?? input.refreshToken,
    refreshTokenExpiresIn: parsed.data.refresh_token_expires_in };
}

/**
 * Creates a read-only Feishu provider. Access is delegated to the supplied
 * token provider and rechecked by Feishu on every request.
 */
export function createFeishuApiReader(options: FeishuApiReaderOptions): TesseraFeishuReader {
  const request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    async search(input, context): Promise<TesseraFeishuSearchResult> {
      const offset = input.cursor === undefined ? 0 : Number(input.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 199) {
        return { status: "unavailable", documents: [], message: "The search cursor is invalid or exceeds Feishu's search window." };
      }
      const count = Math.min(input.limit, 199 - offset);
      const token = await options.tokenProvider.getAccessToken(context);
      const response = await request(new URL("/open-apis/suite/docs-api/search/object", baseUrl), {
        method: "POST",
        signal: context.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          search_key: input.query,
          count,
          offset,
        }),
      });
      const body = await readJsonBounded(response, maxResponseBytes);
      if (!response.ok) return { status: "unavailable", documents: [], message: "Feishu search request failed." };
      const parsed = searchResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.code !== 0) {
        return {
          status: parsed.success && isPermissionCode(parsed.data.code) ? "denied" : "unavailable",
          documents: [],
          message: parsed.success ? parsed.data.msg : "Feishu returned an invalid search response.",
        };
      }
      const documents = (parsed.data.data?.docs_entities ?? [])
        .map(toDocumentReference)
        .filter((value): value is TesseraFeishuDocumentReference => value !== undefined)
        .slice(0, input.limit);
      return {
        status: "completed",
        documents,
        ...(parsed.data.data?.has_more && offset + count < 199 ? { nextCursor: String(offset + count) } : {}),
      };
    },

    async read(input, context): Promise<TesseraFeishuDocument> {
      const token = await options.tokenProvider.getAccessToken(context);
      let reference = parseFeishuDocumentReference(input.documentId);
      if (!reference) return { status: "unavailable", message: "请提供飞书云文档或知识库的原始链接。" };
      const headers = { Authorization: `Bearer ${token}` };
      if (reference.kind === "wiki") {
        const url = new URL("/open-apis/wiki/v2/spaces/get_node", baseUrl);
        url.searchParams.set("token", reference.documentId);
        const wiki = await request(url, { headers, signal: context.signal });
        const data = z.object({ code: z.number(), data: z.object({ node: z.object({ obj_type: z.string(), obj_token: z.string(), title: z.string() }) }).optional() })
          .safeParse(await readJsonBounded(wiki, maxResponseBytes));
        if (!wiki.ok || !data.success || data.data.code !== 0 || !data.data.data) return { status: "denied", message: "无法读取该知识库节点，请确认飞书账号有访问权限。" };
        reference = { ...reference, kind: normalizeKind(data.data.data.node.obj_type), documentId: data.data.data.node.obj_token, title: data.data.data.node.title };
      }
      if (reference.kind !== "docx" && reference.kind !== "unknown") return { status: "unavailable", message: "目前支持新版云文档和知识库中的云文档；表格、多维表格和附件需要专用读取接口。" };
      const documentPath = `/open-apis/docx/v1/documents/${encodeURIComponent(reference.documentId)}`;
      const response = await request(new URL(`${documentPath}/raw_content`, baseUrl), {
        method: "GET",
        signal: context.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJsonBounded(response, maxResponseBytes);
      if (!response.ok) return { status: response.status === 403 ? "denied" : "unavailable", message: "Feishu document request failed." };
      const parsed = rawContentResponseSchema.safeParse(body);
      if (!parsed.success || parsed.data.code !== 0) {
        return {
          status: parsed.success && isPermissionCode(parsed.data.code) ? "denied" : "not_found",
          message: parsed.success ? parsed.data.msg : "Feishu returned an invalid document response.",
        };
      }
      const content = parsed.data.data?.content;
      if (content === undefined) return { status: "unavailable", message: "Feishu returned no document content." };
      const contentHash = createHash("sha256").update(content).digest("hex");
      let offset = 0;
      if (input.cursor !== undefined) {
        try {
          const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          if (cursor.id !== input.documentId || cursor.hash !== contentHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > content.length) throw new Error("Invalid cursor");
          offset = cursor.offset;
        } catch { return { status: "unavailable", message: "文档已更新或分页标识无效，请从文档开头重新读取。" }; }
      }
      const bounded = content.slice(offset, offset + input.maxCharacters);
      // Title metadata is optional; a denied metadata lookup must not undo a successful content read.
      try {
        const metadata = await request(new URL(documentPath, baseUrl), { headers, signal: context.signal });
        const result = z.object({ code: z.number(), data: z.object({ document: z.object({ title: z.string() }) }).optional() })
          .safeParse(await readJsonBounded(metadata, maxResponseBytes));
        if (metadata.ok && result.success && result.data.code === 0 && result.data.data) reference = { ...reference, title: result.data.data.document.title };
      } catch (error) { if (context.signal.aborted) throw error; }
      const end = offset + bounded.length;
      return {
        status: "completed",
        document: { ...reference, documentId: input.documentId },
        content: bounded,
        contentHash,
        truncated: end < content.length,
        ...(end < content.length ? { nextCursor: Buffer.from(JSON.stringify({ id: input.documentId, hash: contentHash, offset: end })).toString("base64url") } : {}),
      };
    },
  };
}

function toDocumentReference(value: Record<string, unknown>): TesseraFeishuDocumentReference | undefined {
  const documentId = firstString(value, ["docs_token", "document_id", "token", "obj_token", "id"]);
  const title = firstString(value, ["title", "name"]);
  if (!documentId || !title) return undefined;
  const kind = firstString(value, ["docs_type", "obj_type", "type"]);
  return {
    documentId: firstString(value, ["url", "url_link", "link"]) ?? `${normalizeKind(kind)}:${documentId}`,
    title,
    kind: normalizeKind(kind),
    ...(firstString(value, ["url", "url_link", "link"]) === undefined ? {} : { url: firstString(value, ["url", "url_link", "link"]) }),
    ...(firstString(value, ["update_time", "updated_at"]) === undefined ? {} : { updatedAt: firstString(value, ["update_time", "updated_at"]) }),
    ...(firstString(value, ["snippet", "summary", "content"]) === undefined ? {} : { snippet: firstString(value, ["snippet", "summary", "content"])?.slice(0, 4_000) }),
  };
}

/** Parse links without fetching user-supplied origins. All API traffic stays on the Feishu API. */
export function parseFeishuDocumentReference(input: string): TesseraFeishuDocumentReference | undefined {
  if (input.startsWith("https://")) {
    try {
      const url = new URL(input);
      if (url.username || url.password || !/(^|\.)(feishu\.cn|larksuite\.com)$/iu.test(url.hostname)) return undefined;
      const match = url.pathname.match(/^\/(docx|wiki|sheets|base|slides|doc)\/([A-Za-z0-9_-]+)\/?$/u);
      if (!match) return undefined;
      return { documentId: match[2]!, title: "飞书文档", kind: match[1] === "doc" ? "unknown" : normalizeKind(match[1]), url: url.origin + url.pathname };
    } catch { return undefined; }
  }
  const match = input.match(/^(?:(docx|wiki|sheet|bitable|slide|file|unknown):)?([A-Za-z0-9_-]+)$/u);
  if (!match) return undefined;
  return { documentId: match[2]!, title: "飞书文档", kind: normalizeKind(match[1]) };
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key].trim()) return value[key] as string;
  return undefined;
}

function normalizeKind(value: string | undefined): TesseraFeishuDocumentReference["kind"] {
  const lower = value?.toLowerCase();
  if (lower === "docx" || lower === "doc") return "docx";
  if (lower === "wiki") return "wiki";
  if (lower === "sheet" || lower === "sheets") return "sheet";
  if (lower === "bitable" || lower === "base") return "bitable";
  if (lower === "slide" || lower === "slides") return "slide";
  if (lower === "file") return "file";
  return "unknown";
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Feishu base URL must use HTTP(S).");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error("Feishu response exceeded the configured size limit."); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return undefined; }
}

function isPermissionCode(code: number): boolean {
  return code === 99991663 || code === 99991664 || code === 99991668 || code === 99991671 || code === 99991672;
}
