import {
  getTesseraProviderBaseUrl,
  resolveTesseraLlmApiKey,
  type TesseraLlmConfig,
} from "./config";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_MODELS = 500;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 256;

export type StudioProviderModelOption = Readonly<{
  id: string;
  name: string;
  family: string;
  contextWindow?: number;
}>;

export type StudioProviderModelCatalog = Readonly<{
  models: readonly StudioProviderModelOption[];
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchStudioProviderModelCatalog(
  llm: TesseraLlmConfig,
  options: Readonly<{ signal?: AbortSignal; fetch?: FetchLike }> = {},
): Promise<StudioProviderModelCatalog> {
  const [provider] = llm.model.split("/", 1);
  if (!provider || !["openai", "anthropic", "google", "custom"].includes(provider)) {
    return Object.freeze({ models: Object.freeze([]) });
  }

  const baseUrl = llm.baseUrl ?? getTesseraProviderBaseUrl(provider);
  if (!baseUrl) return Object.freeze({ models: Object.freeze([]) });

  const apiKey = resolveTesseraLlmApiKey(llm);
  if (provider !== "custom" && !apiKey) {
    throw new Error("provider_model_catalog_unavailable");
  }

  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/models`;
  if (provider === "google") url.searchParams.set("pageSize", String(MAX_MODELS));

  const headers = new Headers({ Accept: "application/json", ...llm.headers });
  if (provider === "anthropic") {
    if (apiKey) headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (provider === "google") {
    if (apiKey) headers.set("x-goog-api-key", apiKey);
  } else if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await (options.fetch ?? fetch)(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("provider_model_catalog_unavailable");
    }
    const models = parseStudioProviderModels(await response.json(), provider);
    if (models.length === 0) throw new Error("provider_model_catalog_unavailable");
    return Object.freeze({ models: Object.freeze(models) });
  } catch {
    throw new Error("provider_model_catalog_unavailable");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function parseStudioProviderModels(value: unknown, provider: string): readonly StudioProviderModelOption[] {
  const root = asRecord(value);
  const source = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : [];
  const family = providerLabel(provider);
  const models = new Map<string, StudioProviderModelOption>();

  for (const item of source) {
    const record = asRecord(item);
    const id = normalizeModelId(record?.id ?? record?.name, provider);
    if (!id || !isTextModel(record, provider)) continue;
    const name = readText(record?.display_name ?? record?.displayName ?? record?.name, MAX_MODEL_NAME_LENGTH) ?? id;
    const contextWindow = readPositiveInteger(record?.context_length ?? record?.contextWindow ?? record?.inputTokenLimit);
    models.set(id, Object.freeze({ id, name, family, ...(contextWindow === undefined ? {} : { contextWindow }) }));
    if (models.size >= MAX_MODELS) break;
  }

  return Object.freeze([...models.values()].sort((left, right) => left.name.localeCompare(right.name, "en-US")));
}

function normalizeModelId(value: unknown, provider: string): string | undefined {
  const text = readText(value, MAX_MODEL_ID_LENGTH);
  if (!text || /\s/u.test(text)) return undefined;
  const id = provider === "google" ? text.replace(/^models\//u, "") : text;
  if (!id || (provider === "google" && id.includes("/"))) return undefined;
  return id;
}

function isTextModel(record: Record<string, unknown> | undefined, provider: string): boolean {
  if (provider === "google") {
    const methods = record?.supportedGenerationMethods;
    if (Array.isArray(methods)) return methods.includes("generateContent");
  }
  const id = String(record?.id ?? record?.name ?? "").toLocaleLowerCase("en-US");
  return !/(?:embedding|whisper|transcri|moderation|dall-e|text-to-speech|tts)/u.test(id);
}

function providerLabel(provider: string): string {
  return ({
    anthropic: "Anthropic",
    custom: "Custom gateway",
    google: "Google",
    openai: "OpenAI",
  } as Record<string, string>)[provider] ?? provider;
}

function readText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maximumLength ? text : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
