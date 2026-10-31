import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createFeishuApiReader, createFeishuOAuthUrl, exchangeFeishuOAuthCode, refreshFeishuOAuthToken, type FeishuOAuthTokenResponse } from "@open-tessera/feishu";
import type { TesseraAgentIdentity, TesseraFeishuReader } from "@open-tessera/agent";
import type { DurableStateStorePort } from "@open-tessera/runtime";

export const FEISHU_CALLBACK_PATH = "/api/feishu/callback";
export const feishuAppSettingsSchema = z.object({
  appId: z.string().trim().regex(/^cli_[A-Za-z0-9_-]+$/u).max(256),
  appSecret: z.string().trim().min(1).max(8_192).refine((value) => !/[\r\n]/u.test(value)).optional(),
}).strict();

type Encrypted = { iv: string; tag: string; data: string };
type AppConfig = { appId: string; appSecret: string; version: string };
type TokenRecord = FeishuOAuthTokenResponse & { expiresAt: number; appVersion: string };
type PendingAuth = { expiresAt: number; verifier: string; browserBinding: string; redirectUri: string; appVersion: string };

export type FeishuConnectionStatus = Readonly<{
  available: boolean;
  configured: boolean;
  connected: boolean;
  appId?: string;
  expiresAt?: string;
  callbackPath: string;
}>;

export class FeishuConnectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Credentials and consent are partitioned by the authenticated Studio owner. */
export class FeishuConnectionService {
  readonly #state: DurableStateStorePort;
  readonly #key: Buffer;
  readonly #fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly reader: TesseraFeishuReader;

  constructor(options: { state: DurableStateStorePort; encryptionSecret: string; fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; now?: () => number }) {
    this.#state = options.state;
    this.#key = createHash("sha256").update(`tessera-feishu:${options.encryptionSecret}`).digest();
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.reader = createFeishuApiReader({ fetch: this.#fetch, tokenProvider: { getAccessToken: ({ identity, signal }) => this.accessToken(identity, signal) } });
  }

  async status(identity: TesseraAgentIdentity): Promise<FeishuConnectionStatus> {
    const app = await this.#app(identity);
    const token = await this.#read<TokenRecord>(this.#ownerKey(identity, "token"));
    return { available: true, configured: Boolean(app), connected: Boolean(app && token?.appVersion === app.version && (token.expiresAt > this.#now() || token.refreshToken)),
      appId: app?.appId, expiresAt: token ? new Date(token.expiresAt).toISOString() : undefined, callbackPath: FEISHU_CALLBACK_PATH };
  }

  async configure(identity: TesseraAgentIdentity, candidate: z.infer<typeof feishuAppSettingsSchema>) {
    const input = feishuAppSettingsSchema.parse(candidate);
    const existing = await this.#app(identity);
    const appSecret = input.appSecret ?? (existing?.appId === input.appId ? existing.appSecret : undefined);
    if (!appSecret) throw new FeishuConnectionError("app_secret_required", "请填写飞书应用的 App Secret。");
    const changed = existing?.appId !== input.appId || existing.appSecret !== appSecret;
    const app: AppConfig = { appId: input.appId, appSecret, version: changed ? randomBytes(16).toString("hex") : existing.version };
    const keys = [this.#ownerKey(identity, "app"), this.#ownerKey(identity, "token")];
    await this.#state.transaction(keys, async (tx) => {
      await tx.set(keys[0]!, this.#seal(app, keys[0]!));
      if (changed) await tx.delete(keys[1]!);
    });
    return this.status(identity);
  }

  async begin(identity: TesseraAgentIdentity, origin: string) {
    const app = await this.#app(identity);
    if (!app) throw new FeishuConnectionError("app_not_configured", "请先保存飞书应用的 App ID 和 App Secret。");
    const state = randomBytes(32).toString("base64url");
    const browserBinding = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const redirectUri = new URL(FEISHU_CALLBACK_PATH, origin).toString();
    const pending: PendingAuth = { expiresAt: this.#now() + 5 * 60_000, verifier, browserBinding, redirectUri, appVersion: app.version };
    // One pending authorization per owner; a newer attempt invalidates the previous one.
    const key = this.#ownerKey(identity, "pending");
    await this.#state.transaction([key], (tx) => tx.set(key, this.#seal({ ...pending, state }, key)));
    return { browserBinding, url: createFeishuOAuthUrl({ appId: app.appId, redirectUri, state,
      scope: "offline_access docx:document:readonly wiki:wiki:readonly docs:doc:readonly",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url") }) };
  }

  async complete(identity: TesseraAgentIdentity, input: { code: string; state: string; browserBinding: string; origin: string }, signal: AbortSignal) {
    const key = this.#ownerKey(identity, "pending");
    const pending = await this.#state.transaction([key], async (tx) => {
      const stored = await tx.get<Encrypted>(key);
      if (!stored) throw new FeishuConnectionError("invalid_oauth_state", "授权已过期，请重新连接飞书。");
      const record = this.#unseal<PendingAuth & { state: string }>(stored, key);
      if (record.state !== input.state || record.browserBinding !== input.browserBinding || record.expiresAt <= this.#now()
        || record.redirectUri !== new URL(FEISHU_CALLBACK_PATH, input.origin).toString()) {
        throw new FeishuConnectionError("invalid_oauth_state", "授权状态不匹配，请从当前工作区重新发起连接。");
      }
      await tx.delete(key);
      return record;
    });
    const app = await this.#app(identity);
    if (!app || app.version !== pending.appVersion) throw new FeishuConnectionError("app_changed", "应用配置已变化，请重新连接飞书。");
    const token = await exchangeFeishuOAuthCode({ ...app, code: input.code, redirectUri: pending.redirectUri, codeVerifier: pending.verifier, signal, fetch: this.#fetch });
    const tokenKey = this.#ownerKey(identity, "token");
    const appKey = this.#ownerKey(identity, "app");
    await this.#state.transaction([appKey, tokenKey], async (tx) => {
      const current = await tx.get<Encrypted>(appKey);
      if (!current || this.#unseal<AppConfig>(current, appKey).version !== app.version) throw new FeishuConnectionError("app_changed", "应用配置已变化，请重新授权。");
      await tx.set(tokenKey, this.#seal(this.#tokenRecord(token, app.version), tokenKey));
    });
  }

  async disconnect(identity: TesseraAgentIdentity) {
    const keys = [this.#ownerKey(identity, "token"), this.#ownerKey(identity, "pending")];
    await this.#state.transaction(keys, async (tx) => { for (const key of keys) await tx.delete(key); });
  }

  async accessToken(identity: TesseraAgentIdentity, signal: AbortSignal): Promise<string> {
    const appKey = this.#ownerKey(identity, "app");
    const tokenKey = this.#ownerKey(identity, "token");
    // The store serializes refreshes across Netlify instances, including token rotation.
    return this.#state.transaction([appKey, tokenKey], async (tx) => {
      const [appData, tokenData] = await Promise.all([tx.get<Encrypted>(appKey), tx.get<Encrypted>(tokenKey)]);
      const app = appData ? this.#unseal<AppConfig>(appData, appKey) : undefined;
      const token = tokenData ? this.#unseal<TokenRecord>(tokenData, tokenKey) : undefined;
      if (!app || !token || token.appVersion !== app.version) throw new FeishuConnectionError("authorization_required", "请先连接飞书并授权读取文档。");
      if (token.expiresAt > this.#now() + 60_000) return token.accessToken;
      if (!token.refreshToken) throw new FeishuConnectionError("authorization_expired", "飞书授权已过期，请重新连接。");
      const refreshed = await refreshFeishuOAuthToken({ ...app, refreshToken: token.refreshToken, signal, fetch: this.#fetch });
      await tx.set(tokenKey, this.#seal(this.#tokenRecord(refreshed, app.version), tokenKey));
      return refreshed.accessToken;
    });
  }

  #tokenRecord(token: FeishuOAuthTokenResponse, appVersion: string): TokenRecord {
    return { ...token, expiresAt: this.#now() + (token.expiresIn ?? 7_200) * 1_000, appVersion };
  }
  #ownerKey(identity: TesseraAgentIdentity, kind: string) {
    return `tessera.feishu.${createHash("sha256").update(JSON.stringify([identity.tenantId, identity.subject])).digest("hex")}.${kind}`;
  }
  #app(identity: TesseraAgentIdentity) { return this.#read<AppConfig>(this.#ownerKey(identity, "app")); }
  async #read<T>(key: string): Promise<T | undefined> {
    const value = await this.#state.read<Encrypted>(key);
    return value ? this.#unseal<T>(value, key) : undefined;
  }
  #seal(value: unknown, key: string): Encrypted {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }
  #unseal<T>(value: Encrypted, key: string): T {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(key));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8")) as T;
  }
}

/** Local SQLite stores use a project-specific private encryption key. */
export async function localFeishuEncryptionSecret(root = process.cwd()): Promise<string> {
  const directory = join(root, ".tessera");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "feishu.key");
  try {
    const file = await open(path, "wx", 0o600);
    const secret = randomBytes(32).toString("base64url");
    try { await file.writeFile(secret); } finally { await file.close(); }
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFile(path, "utf8");
  }
}
