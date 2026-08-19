import {
  TESSERA_OPENROUTER_REASONING_EFFORTS,
  type TesseraReasoningEffort,
} from "./config";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 256;

const featuredFamilies = [
  { id: "deepseek", label: "DeepSeek" },
  { id: "qwen", label: "Qwen" },
  { id: "moonshotai", label: "Kimi" },
  { id: "z-ai", label: "GLM" },
  { id: "x-ai", label: "Grok" },
] as const;

const knownReasoningEfforts = new Set<string>(TESSERA_OPENROUTER_REASONING_EFFORTS);

export type OpenRouterReasoningCapability = Readonly<{
  supportedEfforts: readonly TesseraReasoningEffort[];
  defaultEffort?: TesseraReasoningEffort;
  defaultEnabled: boolean;
  mandatory: boolean;
}>;

export type OpenRouterModelOption = Readonly<{
  id: string;
  name: string;
  family: string;
  reasoning?: OpenRouterReasoningCapability;
}>;

export type OpenRouterModelCatalog = Readonly<{
  models: readonly OpenRouterModelOption[];
}>;

export type OpenRouterModelCatalogProvider = Readonly<{
  list(input?: Readonly<{ currentModel?: string }>): Promise<OpenRouterModelCatalog>;
  getReasoning(model: string): Promise<OpenRouterReasoningCapability | undefined>;
}>;

export type OpenRouterModelRecord = Readonly<{
  id: string;
  name: string;
  created: number;
  reasoning?: OpenRouterReasoningCapability;
}>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateOpenRouterModelCatalogProviderOptions = Readonly<{
  cacheTtlMs?: number;
  fetch?: FetchLike;
}>;

/**
 * Keeps model metadata server-side and exposes only the small, stable picker
 * projection Studio needs. The OpenRouter endpoint is public and no API key is
 * used for this request.
 */
export function createOpenRouterModelCatalogProvider(
  options: CreateOpenRouterModelCatalogProviderOptions = {},
): OpenRouterModelCatalogProvider {
  const fetcher = options.fetch ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cached: Readonly<{ expiresAt: number; models: readonly OpenRouterModelRecord[] }> | undefined;
  let pending: Promise<readonly OpenRouterModelRecord[]> | undefined;

  async function getModels(): Promise<readonly OpenRouterModelRecord[]> {
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models;
    if (pending === undefined) {
      pending = fetchOpenRouterModels(fetcher).catch(() => fallbackModels).then((models) => {
        cached = Object.freeze({ expiresAt: Date.now() + cacheTtlMs, models });
        return models;
      }).finally(() => {
        pending = undefined;
      });
    }
    return pending;
  }

  return Object.freeze({
    async list(input = {}) {
      return createOpenRouterModelCatalog(await getModels(), input.currentModel);
    },
    async getReasoning(model) {
      const normalizedModel = normalizeModelId(model);
      if (normalizedModel === undefined) return undefined;
      return (await getModels()).find((candidate) => candidate.id === normalizedModel)?.reasoning;
    },
  });
}

export function createOpenRouterModelCatalog(
  models: readonly OpenRouterModelRecord[],
  currentModel?: string,
): OpenRouterModelCatalog {
  const selected: OpenRouterModelOption[] = [];
  for (const family of featuredFamilies) {
    const model = models
      .filter((candidate) => belongsToFamily(candidate.id, family.id))
      .filter((candidate) => !isPickerVariant(candidate.id))
      .sort((left, right) => right.created - left.created || left.id.localeCompare(right.id))[0];
    if (model !== undefined) selected.push(toModelOption(model, family.label));
  }

  const normalizedCurrent = currentModel === undefined ? undefined : normalizeModelId(currentModel);
  if (normalizedCurrent !== undefined && !selected.some((model) => model.id === normalizedCurrent)) {
    const current = models.find((model) => model.id === normalizedCurrent);
    if (current !== undefined) selected.unshift(toModelOption(current, "Current"));
  }

  return Object.freeze({ models: Object.freeze(selected) });
}

export function parseOpenRouterModelRecords(value: unknown): readonly OpenRouterModelRecord[] {
  const root = asRecord(value);
  const data = root?.data;
  if (!Array.isArray(data)) return [];

  const models = new Map<string, OpenRouterModelRecord>();
  for (const item of data) {
    const parsed = parseOpenRouterModelRecord(item);
    if (parsed === undefined) continue;
    const existing = models.get(parsed.id);
    if (existing === undefined || parsed.created > existing.created) models.set(parsed.id, parsed);
  }
  return Object.freeze([...models.values()]);
}

async function fetchOpenRouterModels(fetcher: FetchLike): Promise<readonly OpenRouterModelRecord[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("openrouter_model_catalog_unavailable");
    const records = parseOpenRouterModelRecords(await response.json());
    if (records.length === 0) throw new Error("openrouter_model_catalog_invalid");
    return records;
  } finally {
    clearTimeout(timeout);
  }
}

function parseOpenRouterModelRecord(value: unknown): OpenRouterModelRecord | undefined {
  const record = asRecord(value);
  const id = normalizeModelId(record?.id);
  if (id === undefined) return undefined;
  const name = readText(record?.name, MAX_MODEL_NAME_LENGTH) ?? id;
  const created = readTimestamp(record?.created);
  const reasoning = parseReasoningCapability(record?.reasoning);
  return Object.freeze({
    id,
    name,
    created,
    ...(reasoning === undefined ? {} : { reasoning }),
  });
}

function parseReasoningCapability(value: unknown): OpenRouterReasoningCapability | undefined {
  const record = asRecord(value);
  const rawEfforts = record?.supported_efforts;
  if (!Array.isArray(rawEfforts)) return undefined;
  const supportedEfforts = [...new Set(rawEfforts
    .filter((effort): effort is string => typeof effort === "string" && knownReasoningEfforts.has(effort))
    .map((effort) => effort as TesseraReasoningEffort))];
  if (supportedEfforts.length === 0) return undefined;
  const defaultEffort = typeof record?.default_effort === "string" && supportedEfforts.includes(record.default_effort as TesseraReasoningEffort)
    ? record.default_effort as TesseraReasoningEffort
    : undefined;
  return Object.freeze({
    supportedEfforts: Object.freeze(supportedEfforts),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    defaultEnabled: record?.default_enabled === true,
    mandatory: record?.mandatory === true,
  });
}

function toModelOption(model: OpenRouterModelRecord, family: string): OpenRouterModelOption {
  return Object.freeze({
    id: model.id,
    name: model.name,
    family,
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
  });
}

function belongsToFamily(modelId: string, family: string): boolean {
  return modelId.startsWith(`${family}/`);
}

function isPickerVariant(modelId: string): boolean {
  return modelId.endsWith(":batch") || modelId.endsWith(":free");
}

function normalizeModelId(value: unknown): string | undefined {
  const model = readText(value, MAX_MODEL_ID_LENGTH);
  return model !== undefined && !/\s/u.test(model) ? model : undefined;
}

function readText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : undefined;
}

function readTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const fallbackModels: readonly OpenRouterModelRecord[] = Object.freeze([
  Object.freeze({
    id: "qwen/qwen3.8-27b",
    name: "Qwen: Qwen3.8 27B",
    created: 1_786_722_910,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["xhigh", "medium", "low"] as TesseraReasoningEffort[]),
      defaultEffort: "xhigh" as TesseraReasoningEffort,
      defaultEnabled: true,
      mandatory: false,
    }),
  }),
  Object.freeze({
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek: DeepSeek V4 Pro 0813",
    created: 1_786_549_364,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["max", "high", "low"] as TesseraReasoningEffort[]),
      defaultEffort: "high" as TesseraReasoningEffort,
      defaultEnabled: false,
      mandatory: false,
    }),
  }),
  Object.freeze({
    id: "qwen/qwen3.8-2.4t-a95b",
    name: "Qwen: Qwen3.8 2.4T A95B",
    created: 1_786_551_702,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["xhigh", "medium", "low"] as TesseraReasoningEffort[]),
      defaultEffort: "xhigh" as TesseraReasoningEffort,
      defaultEnabled: true,
      mandatory: true,
    }),
  }),
  Object.freeze({
    id: "moonshotai/kimi-k3",
    name: "MoonshotAI: Kimi K3",
    created: 1_784_215_858,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["max", "high", "low"] as TesseraReasoningEffort[]),
      defaultEffort: "max" as TesseraReasoningEffort,
      defaultEnabled: false,
      mandatory: false,
    }),
  }),
  Object.freeze({
    id: "z-ai/glm-5.2",
    name: "Z.ai: GLM 5.2",
    created: 1_781_631_930,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["xhigh", "high"] as TesseraReasoningEffort[]),
      defaultEffort: "high" as TesseraReasoningEffort,
      defaultEnabled: false,
      mandatory: false,
    }),
  }),
  Object.freeze({
    id: "x-ai/grok-4.6",
    name: "SpaceXAI: Grok 4.6",
    created: 1_786_548_957,
    reasoning: Object.freeze({
      supportedEfforts: Object.freeze(["xhigh", "high", "medium", "low"] as TesseraReasoningEffort[]),
      defaultEffort: "high" as TesseraReasoningEffort,
      defaultEnabled: true,
      mandatory: true,
    }),
  }),
]);
