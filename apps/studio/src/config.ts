import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { semanticCatalogDefinitionSchema } from "@open-tessera/data-agent";
import {
  createDatabaseScopedPermissionPolicy,
  databaseScopedPermissionPolicyInputSchema,
  type DatabaseScopedPermissionPolicy,
} from "@open-tessera/database";
import { parse as parseDotenv, populate as populateDotenv } from "dotenv";
import { z } from "zod";

export const TESSERA_CONFIG_FILE = "tessera.config.ts";
export const TESSERA_ENV_FILE = ".env";
export const DEFAULT_TESSERA_STUDIO_HOST = "127.0.0.1";
export const DEFAULT_TESSERA_STUDIO_PORT = 4317;
// A loopback-only placeholder lets the local Studio open its settings UI before
// a database is configured. It is never persisted or sent to the browser.
const UNCONFIGURED_TESSERA_DATABASE_URL = "postgresql://127.0.0.1:1/tessera";
// Schema changes are much less frequent than user turns. Align the Studio
// default with Data Agent's cache so an active analysis does not rescan every
// 15 seconds; callers can still set `catalogCacheTtlMs: 0` when they need it.
export const DEFAULT_CATALOG_CACHE_TTL_MS = 60_000;
/** The local default keeps existing OpenRouter setups working without a config migration. */
export const DEFAULT_TESSERA_LLM_MODEL = "openrouter/qwen/qwen3.8-27b";
export const DEFAULT_TESSERA_LLM_TEMPERATURE = 0.1;
/** Documented API roots used when a provider config omits an explicit base URL. */
export const TESSERA_PROVIDER_BASE_URLS = Object.freeze({
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
} as const);
const TESSERA_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES = Object.freeze({
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  together: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
} as const);
/** OpenRouter's documented reasoning effort vocabulary, including provider-specific `max`. */
export const TESSERA_OPENROUTER_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
] as const;
export type TesseraReasoningEffort = (typeof TESSERA_OPENROUTER_REASONING_EFFORTS)[number];
/** Keep the local Qwen default below OpenRouter's current xhigh provider default. */
export const DEFAULT_TESSERA_LLM_REASONING_EFFORT: TesseraReasoningEffort = "low";
// Tool-using turns need enough room for a model to inspect a catalog, issue a
// semantic plan, and narrate the verified result. 900 tokens regularly ends a
// reasoning-capable provider before it can make its second tool call.
export const DEFAULT_TESSERA_LLM_MAX_OUTPUT_TOKENS = 12_800;
export const DEFAULT_TESSERA_LLM_MAX_STEPS = 50;
export const DEFAULT_TESSERA_LLM_MAX_RETRIES = 0;
/** @deprecated Use DEFAULT_TESSERA_LLM_MODEL for new integrations. */
export const TESSERA_AGENT_MODEL = DEFAULT_TESSERA_LLM_MODEL;

const nonEmptyString = z.string().trim().min(1);
const portSchema = z.number().int().min(1).max(65_535);
const databaseDialectSchema = z.enum(["postgres", "mysql", "sqlite", "turso", "mongodb"]);
const explicitDatabaseDialect = Symbol("tessera.explicitDatabaseDialect");
/**
 * Datus-style policy input. The profile remains the concise default while
 * subject/resource scopes and ordered rules provide the durable boundary for
 * governed database actions.
 */
const databasePermissionsConfigSchema = databaseScopedPermissionPolicyInputSchema;
const originSchema = z.string().trim().min(1).max(2_048).refine(
  (value) => normalizeOrigin(value) !== undefined,
  "Expected an HTTP or HTTPS origin without a path, query, or hash.",
);

const studioConfigSchema = z.object({
  host: nonEmptyString.max(255).optional(),
  port: portSchema.optional(),
  allowRemote: z.boolean().optional(),
  requireAuthentication: z.boolean().optional(),
  allowedOrigins: z.array(originSchema).max(50).optional(),
  catalogCacheTtlMs: z.number().int().min(0).max(10 * 60_000).optional(),
}).strict();

const databaseConfigSchema = z.object({
    // The URL is the source of truth when a project does not need to force a
    // dialect. An explicit dialect is still useful as a configuration guard.
    dialect: databaseDialectSchema.optional(),
    url: nonEmptyString.max(8_192),
    /** Server-only Turso token. TURSO_AUTH_TOKEN remains the environment fallback. */
    authToken: nonEmptyString.max(8_192).refine(
      (value) => !/[\r\n]/u.test(value),
      "Database credentials cannot contain line breaks.",
    ).optional(),
    id: nonEmptyString.max(256).optional(),
    /**
     * Optional explicit narrowing. When omitted, the connector discovers every
     * non-system schema the configured database credential can read.
     */
    schemas: z.array(nonEmptyString.max(256)).min(1).max(100).optional(),
    maxRows: z.number().int().min(1).max(20_000).optional(),
    statementTimeoutMs: z.number().int().min(250).max(120_000).optional(),
    permissions: databasePermissionsConfigSchema.optional(),
  }).strict();

const modelIdSchema = nonEmptyString.max(512).refine(
  (value) => /^[^/\s]+(?:\/[^/\s]+)+$/.test(value),
  "Expected a Mastra model id in provider/model format.",
);
const llmBaseUrlSchema = nonEmptyString.max(2_048).refine(
  (value) => normalizeLlmBaseUrl(value) !== undefined,
  "Expected an HTTP or HTTPS LLM base URL without credentials, query parameters, or a hash.",
);
const llmHeaderNameSchema = z.string().trim().min(1).max(128).regex(
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
  "Expected a valid HTTP header name.",
);
const llmHeaderValueSchema = z.string().max(4_096).refine(
  (value) => !/[\r\n]/.test(value),
  "LLM header values cannot contain line breaks.",
);
const llmHeadersSchema = z.record(llmHeaderNameSchema, llmHeaderValueSchema).refine(
  (headers) => Object.keys(headers).length <= 32,
  "Tessera accepts at most 32 additional LLM headers.",
);
const llmConfigSchema = z.object({
  model: modelIdSchema,
  /** Server-only credential. Omit it to use the provider environment variable. */
  apiKey: nonEmptyString.max(8_192).optional(),
  /** Enables any OpenAI-compatible gateway while preserving Mastra provider routing otherwise. */
  baseUrl: llmBaseUrlSchema.optional(),
  headers: llmHeadersSchema.optional(),
  /** Optional provider reasoning control. It is only applied where supported. */
  reasoningEffort: z.enum(TESSERA_OPENROUTER_REASONING_EFFORTS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(128).max(32_768).optional(),
  // A governed data turn may need catalog -> analysis -> narration. Mastra's
  // maxSteps is a hard cap on model/tool iterations, so values below three can
  // terminate immediately after a tool call with no visible answer.
  maxSteps: z.number().int().min(3).max(50).optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
}).strict();

export const tesseraConfigSchema = z.object({
  database: databaseConfigSchema,
  /** Optional business vocabulary and canonical entity definitions. */
  semantic: semanticCatalogDefinitionSchema.optional(),
  llm: llmConfigSchema.optional(),
  studio: studioConfigSchema.optional(),
}).strict();

export type TesseraConfigInput = z.input<typeof tesseraConfigSchema>;
type ParsedTesseraConfig = z.output<typeof tesseraConfigSchema>;
export type TesseraDatabaseDialect = z.infer<typeof databaseDialectSchema>;
export type TesseraDatabaseConfig = Omit<z.output<typeof databaseConfigSchema>, "dialect" | "permissions"> & Readonly<{
  dialect: TesseraDatabaseDialect;
  /** Resolved server-only policy for approval-gated database actions. */
  permissions: DatabaseScopedPermissionPolicy;
}>;

export type TesseraStudioConfig = Readonly<{
  host: string;
  port: number;
  allowRemote: boolean;
  requireAuthentication: boolean;
  allowedOrigins: readonly string[];
  catalogCacheTtlMs: number;
}>;

export type TesseraLlmConfig = Readonly<{
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers: Readonly<Record<string, string>>;
  reasoningEffort?: TesseraReasoningEffort;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
  maxRetries: number;
}>;

export type TesseraConfig = Omit<ParsedTesseraConfig, "database" | "llm" | "studio"> & Readonly<{
  database: TesseraDatabaseConfig;
  llm?: TesseraLlmConfig;
  studio: TesseraStudioConfig;
}>;

export type LoadedTesseraConfig = Readonly<{
  path: string;
  config: TesseraConfig;
}>;

export type LoadTesseraConfigOptions = Readonly<{
  cwd?: string;
  file?: string;
}>;

export type LoadedTesseraEnvironment = Readonly<{
  /** The nearest environment file that was loaded, when one exists. */
  path?: string;
}>;

export type LoadTesseraEnvironmentOptions = Readonly<{
  cwd?: string;
  /** An explicit file is useful for embedded hosts and test isolation. */
  file?: string;
  /** Defaults to process.env. Existing values always take precedence. */
  environment?: Record<string, string | undefined>;
}>;

export type TesseraStudioOverrides = Readonly<{
  host?: string;
  port?: number;
}>;

export class TesseraConfigError extends Error {
  override readonly name = "TesseraConfigError";
}

/**
 * Defines the server-only Tessera configuration. By default Studio accepts only
 * loopback bindings; non-loopback hosts require an explicit opt-in.
 */
export function defineTesseraConfig(input: TesseraConfigInput): TesseraConfig {
  let parsed: ParsedTesseraConfig;
  try {
    parsed = tesseraConfigSchema.parse(input);
  } catch {
    throw new TesseraConfigError("Tessera configuration is invalid.");
  }
  const inferredDialect = inferTesseraDatabaseDialect(parsed.database.url);
  const dialect = parsed.database.dialect ?? inferredDialect;
  if (dialect !== inferredDialect) {
    throw new TesseraConfigError("Tessera database.dialect does not match the database URL.");
  }
  const configuredStudio = parsed.studio ?? {};
  const host = normalizeHost(configuredStudio.host ?? DEFAULT_TESSERA_STUDIO_HOST);
  const allowRemote = configuredStudio.allowRemote ?? false;
  const requireAuthentication = configuredStudio.requireAuthentication ?? !isLoopbackHost(host);
  const allowedOrigins = normalizeOrigins(configuredStudio.allowedOrigins ?? []);

  if (!isLoopbackHost(host) && !allowRemote) {
    throw new TesseraConfigError(
      "Tessera Studio only binds to loopback by default. Set studio.allowRemote to true to expose it deliberately.",
    );
  }
  if (!isLoopbackHost(host) && allowedOrigins.length === 0) {
    throw new TesseraConfigError(
      "A remotely exposed Tessera Studio requires at least one explicit studio.allowedOrigins value.",
    );
  }
  if (!isLoopbackHost(host) && !requireAuthentication) {
    throw new TesseraConfigError(
      "A remotely exposed Tessera Studio requires studio.requireAuthentication to remain enabled.",
    );
  }

  const { llm: parsedLlm, ...configBase } = parsed;
  const llm = parsedLlm === undefined ? undefined : normalizeTesseraLlmConfig(parsedLlm);

  const config: TesseraConfig = {
    ...configBase,
    database: {
      ...parsed.database,
      dialect,
      permissions: createDatabaseScopedPermissionPolicy(parsed.database.permissions),
    },
    ...(llm === undefined ? {} : { llm }),
    studio: {
      host,
      port: configuredStudio.port ?? DEFAULT_TESSERA_STUDIO_PORT,
      allowRemote,
      requireAuthentication,
      allowedOrigins,
      catalogCacheTtlMs: configuredStudio.catalogCacheTtlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS,
    },
  };
  // `defineTesseraConfig()` resolves an omitted dialect for callers, while this
  // marker retains whether the project intentionally pinned one. It is
  // non-enumerable, never serialized, and lets a positional URL safely switch
  // database family only when the config did not explicitly forbid it.
  Object.defineProperty(config, explicitDatabaseDialect, {
    value: parsed.database.dialect !== undefined,
  });
  return config;
}

/**
 * Resolves the effective server-side LLM settings. An omitted `llm` retains
 * the local OpenRouter default; explicit config delegates provider support to
 * Mastra's model registry or its OpenAI-compatible adapter.
 */
export function resolveTesseraLlmConfig(config: Pick<TesseraConfig, "llm">): TesseraLlmConfig {
  return config.llm ?? {
    model: DEFAULT_TESSERA_LLM_MODEL,
    headers: {},
    reasoningEffort: DEFAULT_TESSERA_LLM_REASONING_EFFORT,
    temperature: DEFAULT_TESSERA_LLM_TEMPERATURE,
    maxOutputTokens: DEFAULT_TESSERA_LLM_MAX_OUTPUT_TOKENS,
    maxSteps: DEFAULT_TESSERA_LLM_MAX_STEPS,
    maxRetries: DEFAULT_TESSERA_LLM_MAX_RETRIES,
  };
}

/** Returns the provider's documented API root, or undefined for custom gateways. */
export function getTesseraProviderBaseUrl(provider: string | undefined): string | undefined {
  const normalized = provider?.trim().toLocaleLowerCase("en-US") as keyof typeof TESSERA_PROVIDER_BASE_URLS | undefined;
  return normalized === undefined ? undefined : TESSERA_PROVIDER_BASE_URLS[normalized];
}

/** Resolves a provider credential from server-only environment variables. */
export function getTesseraProviderEnvironmentApiKey(
  provider: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const normalized = provider?.trim().toLocaleLowerCase("en-US") as
    | keyof typeof TESSERA_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES
    | undefined;
  if (normalized === undefined) return undefined;
  for (const name of TESSERA_PROVIDER_API_KEY_ENVIRONMENT_VARIABLES[normalized] ?? []) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Returns the explicit model key, falling back to the provider's server environment key. */
export function resolveTesseraLlmApiKey(llm: TesseraLlmConfig): string | undefined {
  return llm.apiKey ?? getTesseraProviderEnvironmentApiKey(llm.model.split("/", 1)[0]);
}

/**
 * Explicit LLM configuration may use any credential source supported by
 * Mastra. The legacy local default intentionally requires OPENROUTER_API_KEY
 * so a bare database URL never silently starts a networked model client.
 */
export function isTesseraLlmConfigured(config: Pick<TesseraConfig, "llm">): boolean {
  return config.llm !== undefined || Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

/**
 * Establishes the connector dialect from a database URL without returning or
 * placing the URL in an error message. PostgreSQL accepts both conventional
 * postgres:// and postgresql:// schemes. SQLite accepts file: and sqlite:.
 * Turso accepts libsql:/turso: plus its HTTP and WebSocket transports.
 */
export function inferTesseraDatabaseDialect(value: string): TesseraDatabaseDialect {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TesseraConfigError("Tessera requires a valid supported database URL.");
  }
  switch (url.protocol.toLocaleLowerCase("en-US")) {
    case "postgres:":
    case "postgresql:":
      return "postgres";
    case "mysql:":
      return "mysql";
    case "file:":
    case "sqlite:":
      return "sqlite";
    case "libsql:":
    case "turso:":
    case "https:":
    case "http:":
    case "wss:":
    case "ws:":
      return "turso";
    case "mongodb:":
    case "mongodb+srv:":
      return "mongodb";
    default:
      throw new TesseraConfigError("Tessera supports PostgreSQL, MySQL, SQLite, Turso/libSQL, and MongoDB database URLs only.");
  }
}

/** Creates a complete local Studio configuration for a one-off database URL. */
export function createTesseraConfigFromDatabaseUrl(
  url: string,
  studio?: TesseraConfigInput["studio"],
): TesseraConfig {
  return defineTesseraConfig({
    database: { url },
    ...(studio === undefined ? {} : { studio }),
  });
}

/**
 * Creates a local Studio config for the first-run settings flow. Saved local
 * settings replace this placeholder before any database request is made.
 */
export function createUnconfiguredTesseraConfig(
  studio?: TesseraConfigInput["studio"],
): TesseraConfig {
  return defineTesseraConfig({
    database: { url: UNCONFIGURED_TESSERA_DATABASE_URL },
    ...(studio === undefined ? {} : { studio }),
  });
}

/** True only for the internal first-run config created above. */
export function isTesseraStudioUnconfigured(config: Pick<TesseraConfig, "database">): boolean {
  return config.database.url === UNCONFIGURED_TESSERA_DATABASE_URL;
}

/**
 * Applies the CLI's ephemeral positional URL while preserving the project's
 * schema limits, listener policy, and explicit dialect guard.
 */
export function withTesseraDatabaseUrl(config: TesseraConfig, url: string): TesseraConfig {
  const dialect = inferTesseraDatabaseDialect(url);
  const dialectWasExplicit = hasExplicitDatabaseDialect(config);
  if (dialectWasExplicit && config.database.dialect !== dialect) {
    throw new TesseraConfigError("Tessera database.dialect does not match the database URL.");
  }
  const {
    dialect: _configuredDialect,
    permissions,
    authToken,
    schemas,
    ...database
  } = config.database;
  const { database: _database, ...configBase } = config;
  return defineTesseraConfig({
    ...configBase,
    database: {
      ...database,
      url,
      permissions: databasePolicyConfigInput(permissions),
      ...(config.database.dialect === dialect && authToken !== undefined ? { authToken } : {}),
      ...(config.database.dialect === dialect && schemas !== undefined ? { schemas: [...schemas] } : {}),
      ...(dialectWasExplicit ? { dialect } : {}),
    },
    studio: {
      ...config.studio,
      allowedOrigins: [...config.studio.allowedOrigins],
    },
  });
}

function hasExplicitDatabaseDialect(config: TesseraConfig): boolean {
  const marker = (config as TesseraConfig & { [explicitDatabaseDialect]?: unknown })[explicitDatabaseDialect];
  // A manually constructed normalized config has no provenance marker. Treat
  // its dialect as explicit, which is the conservative library behavior.
  return marker === undefined ? true : marker === true;
}

/** Applies CLI listen overrides while preserving the same exposure policy. */
export function withTesseraStudioOverrides(
  config: TesseraConfig,
  overrides: TesseraStudioOverrides,
): TesseraConfig {
  const { database, ...configBase } = config;
  return defineTesseraConfig({
    ...configBase,
    database: {
      ...database,
      permissions: databasePolicyConfigInput(database.permissions),
    },
    studio: {
      ...config.studio,
      allowedOrigins: [...config.studio.allowedOrigins],
      ...(overrides.host === undefined ? {} : { host: overrides.host }),
      ...(overrides.port === undefined ? {} : { port: overrides.port }),
    },
  });
}

/** Converts a resolved policy back to strict config input without its hash. */
function databasePolicyConfigInput(policy: DatabaseScopedPermissionPolicy) {
  return databaseScopedPermissionPolicyInputSchema.parse({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    profile: policy.profile,
    sqlStatements: { ...policy.sqlStatements },
    ...(policy.subject === undefined ? {} : { subject: structuredClone(policy.subject) }),
    ...(policy.resource === undefined ? {} : { resource: structuredClone(policy.resource) }),
    rules: policy.rules.map((rule) => structuredClone(rule)),
  });
}

/**
 * Loads a conventional `tessera.config.ts` module. The module is evaluated only
 * in the local server process and its contents are never logged or sent to a UI.
 */
export async function loadTesseraConfig(options: LoadTesseraConfigOptions = {}): Promise<LoadedTesseraConfig> {
  const cwd = options.cwd ?? process.cwd();
  const explicitPath = options.file === undefined ? undefined : resolve(cwd, options.file);
  // Load project environment before evaluating a TypeScript config so the
  // documented `process.env.DATABASE_URL` convention works from nested CWDs.
  await loadTesseraEnvironment({ cwd: explicitPath === undefined ? cwd : dirname(explicitPath) });
  const path = explicitPath ?? await findTesseraConfigFile(cwd);

  let module: Record<string, unknown>;
  try {
    module = await import(/* @vite-ignore */ pathToFileURL(path).href) as Record<string, unknown>;
  } catch {
    throw new TesseraConfigError(`Tessera configuration could not be loaded from ${path}.`);
  }

  const exportedConfig = module.default ?? module.tesseraConfig ?? module.config;
  if (exportedConfig === undefined) {
    throw new TesseraConfigError(
      `Tessera configuration at ${path} must export a default config, tesseraConfig, or config value.`,
    );
  }

  try {
    const resolvedConfig = await exportedConfig;
    // A generated config often leaves an empty `llm: {}` section as a
    // placeholder. Treat it the same as an omitted section so Studio can use
    // its local OpenRouter default or the browser settings flow.
    const configInput = resolvedConfig !== null
      && typeof resolvedConfig === "object"
      && !Array.isArray(resolvedConfig)
      && "llm" in resolvedConfig
      && resolvedConfig.llm !== null
      && typeof resolvedConfig.llm === "object"
      && Object.keys(resolvedConfig.llm).length === 0
      ? Object.fromEntries(Object.entries(resolvedConfig).filter(([key]) => key !== "llm"))
      : resolvedConfig;
    return { path, config: defineTesseraConfig(configInput as TesseraConfigInput) };
  } catch (error) {
    if (error instanceof TesseraConfigError) throw error;
    throw new TesseraConfigError(`Tessera configuration at ${path} is invalid.`);
  }
}

/**
 * Loads the closest project `.env` file without logging it or overriding a
 * value supplied by the parent process. This remains server-only: the client
 * bundle never imports this module.
 */
export async function loadTesseraEnvironment(
  options: LoadTesseraEnvironmentOptions = {},
): Promise<LoadedTesseraEnvironment> {
  const cwd = options.cwd ?? process.cwd();
  const path = options.file === undefined
    ? await findTesseraEnvironmentFile(cwd)
    : resolve(cwd, options.file);
  if (path === undefined) return {};

  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new TesseraConfigError(`Tessera environment could not be loaded from ${path}.`);
  }

  try {
    // `populate` makes the precedence explicit and avoids dotenv's diagnostic
    // output. Environment variables supplied by a deployment always win.
    populateDotenv(options.environment ?? process.env, parseDotenv(source), { override: false });
  } catch {
    throw new TesseraConfigError(`Tessera environment could not be loaded from ${path}.`);
  }
  return { path };
}

async function findTesseraConfigFile(cwd: string): Promise<string> {
  const path = await findTesseraProjectFile(cwd, TESSERA_CONFIG_FILE);
  if (path !== undefined) return path;
  throw new TesseraConfigError(`Tessera configuration was not found at ${resolve(cwd, TESSERA_CONFIG_FILE)}.`);
}

async function findTesseraEnvironmentFile(cwd: string): Promise<string | undefined> {
  return findTesseraProjectFile(cwd, TESSERA_ENV_FILE);
}

async function findTesseraProjectFile(cwd: string, file: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  while (true) {
    const candidate = resolve(directory, file);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep walking towards the filesystem root, matching the CLI's project
      // config discovery convention.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.origin === "null") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function normalizeOrigins(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeOrigin(value)).filter((value): value is string => value !== undefined))];
}

function normalizeTesseraLlmConfig(value: z.output<typeof llmConfigSchema>): TesseraLlmConfig {
  const baseUrl = value.baseUrl === undefined ? undefined : normalizeLlmBaseUrl(value.baseUrl);
  if (value.baseUrl !== undefined && baseUrl === undefined) {
    throw new TesseraConfigError("Tessera requires a valid LLM base URL.");
  }
  return {
    model: value.model,
    ...(value.apiKey === undefined ? {} : { apiKey: value.apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    headers: Object.fromEntries(Object.entries(value.headers ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    temperature: value.temperature ?? DEFAULT_TESSERA_LLM_TEMPERATURE,
    maxOutputTokens: value.maxOutputTokens ?? DEFAULT_TESSERA_LLM_MAX_OUTPUT_TOKENS,
    maxSteps: value.maxSteps ?? DEFAULT_TESSERA_LLM_MAX_STEPS,
    maxRetries: value.maxRetries ?? DEFAULT_TESSERA_LLM_MAX_RETRIES,
  };
}

function normalizeLlmBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.origin === "null") {
      return undefined;
    }
    return url.href.endsWith("/") ? url.href.slice(0, -1) : url.href;
  } catch {
    return undefined;
  }
}

function normalizeHost(value: string): string {
  const host = value.trim().toLocaleLowerCase("en-US");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
