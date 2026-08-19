/**
 * Server-only settings and runtime rotation for Tessera Studio.
 *
 * This module deliberately has no dependency on a browser transport. It may
 * hold database URLs and provider credentials while normalizing a candidate,
 * but its public snapshot and managed runtime never expose either value.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { createDataAgent, type DataAgent } from "@data-elements/data-agent";
import type { DurableStateStorePort } from "@data-elements/runtime";
import {
  databasePermissionLevelSchema,
  databasePermissionProfileSchema,
  databaseScopedPermissionPolicyInputSchema,
  type ConnectionAssessment,
  type DatabaseConnector,
  type DatabasePermissionLevel,
  type DatabasePermissionProfile,
  type DatabaseScopedPermissionPolicy,
  type DatabaseScopedPermissionPolicyInput,
} from "@data-elements/database";
import { createMySqlConnector } from "@data-elements/mysql";
import { createPostgresConnector } from "@data-elements/postgres";
import { createTesseraStudioAgent } from "./agent";
import { createTesseraSessionMemory, type TesseraSessionMemory } from "./session-memory";
import {
  defineTesseraConfig,
  inferTesseraDatabaseDialect,
  isTesseraLlmConfigured,
  resolveTesseraLlmConfig,
  TESSERA_OPENROUTER_REASONING_EFFORTS,
  type TesseraConfig,
  type TesseraDatabaseDialect,
} from "./config";
import { createTesseraDatabaseActionService, type TesseraDatabaseActionService } from "./database-actions";

const SETTINGS_DIRECTORY = ".tessera";
const SETTINGS_FILE = "settings.json";
const SETTINGS_STORE_VERSION = 1;

const databaseDialectSchema = z.enum(["postgres", "mysql"]);
const accessModeSchema = z.enum(["read-only", "read-write"]);
const studioReasoningSelectionSchema = z.enum(["default", ...TESSERA_OPENROUTER_REASONING_EFFORTS] as const);
const safeProviderSchema = z.string().trim().min(1).max(64).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  "Expected a provider identifier.",
);
const safeModelSchema = z.string().trim().min(1).max(512).refine(
  (value) => !/\s/.test(value),
  "Expected a model identifier without whitespace.",
);
const secretSchema = z.string().trim().min(1).max(8_192).refine(
  (value) => !/[\r\n]/.test(value),
  "Credentials cannot contain line breaks.",
);
const databaseUrlSchema = z.string().trim().min(1).max(8_192).superRefine((value, context) => {
  try {
    inferTesseraDatabaseDialect(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Expected a PostgreSQL or MySQL database URL.",
    });
  }
});
const baseUrlSchema = z.string().trim().min(1).max(2_048).superRefine((value, context) => {
  if (normalizeBaseUrl(value) === undefined) {
    context.addIssue({
      code: "custom",
      message: "Expected an HTTP or HTTPS provider URL without credentials, a query, or a hash.",
    });
  }
});

/** Settings supplied by the local Studio UI. URL and API key are optional to retain the current server values. */
export const tesseraStudioSettingsCandidateSchema = z.object({
  database: z.object({
    dialect: databaseDialectSchema,
    accessMode: accessModeSchema,
    url: databaseUrlSchema.optional(),
  }).strict(),
  llm: z.object({
    provider: safeProviderSchema,
    model: safeModelSchema,
    /** `default` clears an earlier explicit OpenRouter reasoning effort. */
    reasoningEffort: studioReasoningSelectionSchema.default("default"),
    apiKey: secretSchema.optional(),
    baseUrl: baseUrlSchema.optional(),
  }).strict(),
  limits: z.object({
    maxRows: z.number().int().min(1).max(10_000),
    timeoutMs: z.number().int().min(250).max(120_000),
    maxSteps: z.number().int().min(3).max(50),
  }).strict(),
  permissions: z.object({
    profile: databasePermissionProfileSchema,
    sqlStatements: z.object({
      read: databasePermissionLevelSchema,
      write: databasePermissionLevelSchema,
      destructive: databasePermissionLevelSchema,
      unknown: databasePermissionLevelSchema,
    }).strict(),
  }).strict().optional(),
}).strict();

/** The only settings shape a browser endpoint is allowed to return. */
export const tesseraStudioSettingsSnapshotSchema = z.object({
  database: z.object({
    dialect: databaseDialectSchema,
    accessMode: accessModeSchema,
    urlConfigured: z.boolean(),
  }).strict(),
  llm: z.object({
    provider: safeProviderSchema,
    model: safeModelSchema,
    reasoningEffort: studioReasoningSelectionSchema,
    baseUrl: baseUrlSchema.optional(),
    apiKeyConfigured: z.boolean(),
  }).strict(),
  limits: z.object({
    maxRows: z.number().int().min(1).max(10_000),
    timeoutMs: z.number().int().min(250).max(120_000),
    maxSteps: z.number().int().min(3).max(50),
  }).strict(),
  permissions: z.object({
    profile: databasePermissionProfileSchema,
    sqlStatements: z.object({
      read: databasePermissionLevelSchema,
      write: databasePermissionLevelSchema,
      destructive: databasePermissionLevelSchema,
      unknown: databasePermissionLevelSchema,
    }).strict(),
  }).strict(),
}).strict();

export type TesseraDatabaseAccessMode = z.infer<typeof accessModeSchema>;
export type TesseraDatabasePermissionSettings = Readonly<{
  profile: DatabasePermissionProfile;
  sqlStatements: Readonly<Record<"read" | "write" | "destructive" | "unknown", DatabasePermissionLevel>>;
}>;
export type TesseraStudioSettingsCandidate = z.infer<typeof tesseraStudioSettingsCandidateSchema>;
export type TesseraStudioSettingsSnapshot = z.infer<typeof tesseraStudioSettingsSnapshotSchema>;

/** A generic public error deliberately omits provider, URL, SQL, and credential detail. */
export class TesseraSettingsRuntimeError extends Error {
  override readonly name = "TesseraSettingsRuntimeError";

  constructor(
    readonly code:
      | "connection_unavailable"
      | "invalid_settings"
      | "runtime_closed"
      | "runtime_unavailable"
      | "settings_persist_failed"
      | "settings_store_unavailable",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Parses and canonicalizes a browser candidate without putting the rejected
 * input in an exception. Do not use Zod's raw errors in an HTTP response.
 */
export function parseTesseraStudioSettingsCandidate(value: unknown): TesseraStudioSettingsCandidate {
  const parsed = tesseraStudioSettingsCandidateSchema.safeParse(value);
  if (!parsed.success) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }

  const baseUrl = parsed.data.llm.baseUrl === undefined
    ? undefined
    : normalizeBaseUrl(parsed.data.llm.baseUrl);
  if (parsed.data.llm.baseUrl !== undefined && baseUrl === undefined) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }

  return Object.freeze({
    database: Object.freeze({
      dialect: parsed.data.database.dialect,
      accessMode: parsed.data.database.accessMode,
      ...(parsed.data.database.url === undefined ? {} : { url: parsed.data.database.url }),
    }),
    llm: Object.freeze({
      provider: parsed.data.llm.provider.toLocaleLowerCase("en-US"),
      model: parsed.data.llm.model,
      reasoningEffort: parsed.data.llm.reasoningEffort,
      ...(parsed.data.llm.apiKey === undefined ? {} : { apiKey: parsed.data.llm.apiKey }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    }),
    limits: Object.freeze({ ...parsed.data.limits }),
    ...(parsed.data.permissions === undefined ? {} : {
      permissions: Object.freeze({
        profile: parsed.data.permissions.profile,
        sqlStatements: Object.freeze({ ...parsed.data.permissions.sqlStatements }),
      }),
    }),
  });
}

/**
 * Merges a candidate into an already-normalized Tessera config. Empty URL/key
 * fields are intentionally absent from the candidate and therefore retain the
 * current server-only values. The Data Agent remains read-only for both
 * access modes; `read-write` is an entitlement for governed actions, not
 * permission for model-generated SQL.
 */
export function normalizeTesseraStudioSettings(
  current: TesseraConfig,
  candidateInput: unknown,
): Readonly<{ config: TesseraConfig; accessMode: TesseraDatabaseAccessMode }> {
  const candidate = parseTesseraStudioSettingsCandidate(candidateInput);
  const databaseUrl = candidate.database.url ?? current.database.url;

  let dialect: TesseraDatabaseDialect;
  try {
    dialect = inferTesseraDatabaseDialect(databaseUrl);
  } catch {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }
  if (dialect !== candidate.database.dialect) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "The selected database engine does not match the database URL.");
  }

  const existingLlm = resolveTesseraLlmConfig(current);
  const currentProvider = providerFromModelId(existingLlm.model);
  const providerUnchanged = currentProvider === candidate.llm.provider;
  const model = normalizeModelId(candidate.llm.provider, candidate.llm.model);
  if (model === undefined) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }

  // A provider credential or custom header must never silently follow a
  // model selection to a different provider. The UI can submit a new value
  // explicitly when that is intended.
  const apiKey = candidate.llm.apiKey ?? (providerUnchanged ? current.llm?.apiKey : undefined);
  const baseUrl = candidate.llm.baseUrl ?? (providerUnchanged ? current.llm?.baseUrl : undefined);
  let config: TesseraConfig;
  try {
    config = defineTesseraConfig({
      database: {
        dialect,
        url: databaseUrl,
        ...(current.database.id === undefined ? {} : { id: current.database.id }),
        ...(current.database.schemas === undefined ? {} : { schemas: [...current.database.schemas] }),
        maxRows: candidate.limits.maxRows,
        statementTimeoutMs: candidate.limits.timeoutMs,
        permissions: databasePermissionPolicyInput(
          current.database.permissions,
          candidate.permissions,
        ),
      },
      ...(current.semantic === undefined ? {} : { semantic: current.semantic }),
      llm: {
        model,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        headers: providerUnchanged ? { ...existingLlm.headers } : {},
        ...(candidate.llm.reasoningEffort === "default" ? {} : { reasoningEffort: candidate.llm.reasoningEffort }),
        temperature: existingLlm.temperature,
        maxOutputTokens: existingLlm.maxOutputTokens,
        maxSteps: candidate.limits.maxSteps,
        maxRetries: existingLlm.maxRetries,
      },
      studio: {
        ...current.studio,
        allowedOrigins: [...current.studio.allowedOrigins],
      },
    });
  } catch {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }

  return Object.freeze({ config, accessMode: candidate.database.accessMode });
}

/** Produces a transport-safe settings document with no URL, API key, or header values. */
export function createTesseraStudioSettingsSnapshot(
  config: TesseraConfig,
  accessMode: TesseraDatabaseAccessMode = "read-only",
): TesseraStudioSettingsSnapshot {
  const llm = resolveTesseraLlmConfig(config);
  const [provider, ...modelSegments] = llm.model.split("/");
  const model = modelSegments.join("/");
  const snapshot = {
    database: {
      dialect: config.database.dialect,
      accessMode,
      urlConfigured: Boolean(config.database.url),
    },
    llm: {
      provider: provider?.toLocaleLowerCase("en-US") || "openrouter",
      model: model || llm.model,
      reasoningEffort: llm.reasoningEffort ?? "default",
      ...(llm.baseUrl === undefined ? {} : { baseUrl: llm.baseUrl }),
      apiKeyConfigured: Boolean(llm.apiKey) || hasEnvironmentProviderKey(provider),
    },
    limits: {
      maxRows: config.database.maxRows ?? 500,
      timeoutMs: config.database.statementTimeoutMs ?? 15_000,
      maxSteps: llm.maxSteps,
    },
    permissions: {
      profile: config.database.permissions.profile,
      sqlStatements: { ...config.database.permissions.sqlStatements },
    },
  };
  return Object.freeze(tesseraStudioSettingsSnapshotSchema.parse(snapshot));
}

/** A resource built by a server-only factory. It never crosses an HTTP boundary. */
export type TesseraStudioRuntimeBuild = Readonly<{
  connector: DatabaseConnector;
  dataAgent: DataAgent;
  sessionMemory?: TesseraSessionMemory;
  /** Undefined only when no provider credential source has been configured. */
  agent?: ReturnType<typeof createTesseraStudioAgent>;
  databaseActions?: TesseraDatabaseActionService;
  close(): Promise<void>;
}>;

export type TesseraStudioRuntimeFactory = Readonly<{
  create(
    config: TesseraConfig,
    options: Readonly<{ accessMode: TesseraDatabaseAccessMode; databaseState?: DurableStateStorePort }>,
  ): Promise<TesseraStudioRuntimeBuild> | TesseraStudioRuntimeBuild;
}>;

/** A lease-safe, secret-free handle for server routes to use during one request. */
export type TesseraStudioRuntimeGeneration = Readonly<{
  generation: number;
  accessMode: TesseraDatabaseAccessMode;
  connector: DatabaseConnector;
  dataAgent: DataAgent;
  sessionMemory?: TesseraSessionMemory;
  agent?: ReturnType<typeof createTesseraStudioAgent>;
  databaseActions?: TesseraDatabaseActionService;
}>;

export type TesseraStudioRuntimeLease = Readonly<{
  runtime: TesseraStudioRuntimeGeneration;
  release(): Promise<void>;
}>;

export type TesseraSettingsConnectionSnapshot = Readonly<{
  connected: boolean;
  dialect: TesseraDatabaseDialect;
  databaseName?: string;
  readOnlyTransactions: boolean;
  credentialCanWrite?: boolean;
  latencyMs?: number;
}>;

export type TesseraSettingsValidationResult = Readonly<{
  settings: TesseraStudioSettingsSnapshot;
  connection: TesseraSettingsConnectionSnapshot;
}>;

export type TesseraRuntimeManagerOptions = Readonly<{
  /** Must be normalized with defineTesseraConfig() before it reaches this server-only manager. */
  config: TesseraConfig;
  accessMode?: TesseraDatabaseAccessMode;
  factory?: TesseraStudioRuntimeFactory;
  store?: TesseraStudioSettingsStore;
  /** Shared durable store for grants, effects and mutation receipts. */
  databaseState?: DurableStateStorePort;
}>;

export type TesseraRuntimeReplaceOptions = Readonly<{
  /** Default true: reject a disconnected database instead of replacing a working generation. */
  verifyConnection?: boolean;
  signal?: AbortSignal;
}>;

type RuntimeRecord = {
  config: TesseraConfig;
  accessMode: TesseraDatabaseAccessMode;
  runtime: TesseraStudioRuntimeGeneration;
  close: () => Promise<void>;
  leaseCount: number;
  retired: boolean;
  closed: boolean;
  closeTask?: Promise<void>;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
};

/**
 * Creates a generation using exactly the same connector and Data Agent policy
 * as Studio's static runtime. The current Data Agent remains the only SQL
 * execution boundary, so a `read-write` UI setting cannot widen Agent SQL.
 */
export const defaultTesseraStudioRuntimeFactory: TesseraStudioRuntimeFactory = Object.freeze({
  async create(config, options) {
    const connector = createManagedConnector(config);
    const sessionMemory = createTesseraSessionMemory();
    try {
      const dataAgent = createDataAgent({
        connector,
        ...(config.semantic === undefined ? {} : { semantic: config.semantic }),
        catalog: {
          ttlMs: config.studio.catalogCacheTtlMs,
          introspection: {
            schemas: config.database.schemas,
            includeComments: true,
          },
        },
        query: {
          maxRows: config.database.maxRows,
          timeoutMs: config.database.statementTimeoutMs,
        },
      });
      const agent = isTesseraLlmConfigured(config)
        ? createTesseraStudioAgent({
          dataAgent,
          memory: sessionMemory.memory,
          llm: resolveTesseraLlmConfig(config),
        })
        : undefined;
      const databaseActions = options.accessMode !== "read-write" || options.databaseState === undefined
        ? undefined
        : createTesseraDatabaseActionService({
          connector,
          state: options.databaseState,
          policy: config.database.permissions,
          getCatalog: async (signal) => (await dataAgent.inspectCatalog({ refresh: true }, signal)).catalog,
        });
      return Object.freeze({
        connector,
        dataAgent,
        sessionMemory,
        ...(agent === undefined ? {} : { agent }),
        ...(databaseActions === undefined ? {} : { databaseActions }),
        async close() {
          await Promise.allSettled([sessionMemory.close(), connector.close()]);
        },
      });
    } catch {
      await sessionMemory.close().catch(() => undefined);
      await closeSilently(connector);
      throw new TesseraSettingsRuntimeError("runtime_unavailable", "Tessera could not prepare the requested runtime.");
    }
  },
});

/**
 * Settings persistence is intentionally optional. Implementations receive the
 * private candidate on the server only; callers must never return it to a UI.
 */
export interface TesseraStudioSettingsStore {
  read(): Promise<TesseraStudioSettingsCandidate | undefined>;
  write(candidate: TesseraStudioSettingsCandidate): Promise<void>;
}

/** Options use a project root, not an arbitrary settings directory, to keep chmod scoped to `.tessera`. */
export type CreateTesseraLocalSettingsStoreOptions = Readonly<{
  rootDirectory?: string;
  fileName?: string;
}>;

const persistedSettingsSchema = z.object({
  version: z.literal(SETTINGS_STORE_VERSION),
  candidate: tesseraStudioSettingsCandidateSchema,
}).strict();

/**
 * Creates a plaintext local store at `<project>/.tessera/settings.json`.
 * The containing directory is mode 0700 and the file is mode 0600. This is a
 * local convenience store, not an operating-system keychain replacement.
 */
export function createTesseraLocalSettingsStore(
  options: CreateTesseraLocalSettingsStoreOptions = {},
): TesseraStudioSettingsStore {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const fileName = options.fileName ?? SETTINGS_FILE;
  if (basename(fileName) !== fileName || fileName.length === 0) {
    throw new TesseraSettingsRuntimeError("settings_store_unavailable", "Tessera Studio local settings are unavailable.");
  }
  const directory = join(rootDirectory, SETTINGS_DIRECTORY);
  const path = join(directory, fileName);

  return Object.freeze({
    async read() {
      try {
        const directoryMetadata = await lstat(directory);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
          throw new Error("invalid settings directory");
        }
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw new TesseraSettingsRuntimeError("settings_store_unavailable", "Tessera Studio local settings are unavailable.");
      }

      let source: string;
      try {
        const fileMetadata = await lstat(path);
        if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
          throw new Error("invalid settings file");
        }
        source = await readFile(path, "utf8");
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw new TesseraSettingsRuntimeError("settings_store_unavailable", "Tessera Studio local settings are unavailable.");
      }

      try {
        const parsed = persistedSettingsSchema.safeParse(JSON.parse(source));
        if (!parsed.success) throw new Error("invalid settings content");
        return parseTesseraStudioSettingsCandidate(parsed.data.candidate);
      } catch (error) {
        if (error instanceof TesseraSettingsRuntimeError) throw error;
        throw new TesseraSettingsRuntimeError("settings_store_unavailable", "Tessera Studio local settings are unavailable.");
      }
    },
    async write(candidateInput: TesseraStudioSettingsCandidate) {
      const candidate = parseTesseraStudioSettingsCandidate(candidateInput);
      const source = JSON.stringify({ version: SETTINGS_STORE_VERSION, candidate });
      const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const directoryMetadata = await lstat(directory);
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
          throw new Error("invalid settings directory");
        }
        // chmod is applied only to the dedicated `.tessera` leaf, never to a project root.
        await chmod(directory, 0o700);
        await writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
      } catch {
        await unlink(temporaryPath).catch(() => undefined);
        throw new TesseraSettingsRuntimeError("settings_store_unavailable", "Tessera Studio local settings are unavailable.");
      }
    },
  });
}

/**
 * Holds one current runtime and zero or more retired runtimes. A request must
 * acquire a lease before using the connector, Data Agent, or Mastra agent.
 * Replacement is serialized, but construction happens before the pointer swap
 * so a failure cannot disturb a healthy generation.
 */
export class TesseraStudioRuntimeManager {
  #current: RuntimeRecord;
  readonly #factory: TesseraStudioRuntimeFactory;
  readonly #store: TesseraStudioSettingsStore | undefined;
  readonly #databaseState: DurableStateStorePort | undefined;
  readonly #retired = new Set<RuntimeRecord>();
  #persistedCandidate: TesseraStudioSettingsCandidate | undefined;
  #generation = 1;
  #closed = false;
  #operationTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  private constructor(
    initial: RuntimeRecord,
    factory: TesseraStudioRuntimeFactory,
    store: TesseraStudioSettingsStore | undefined,
    persistedCandidate: TesseraStudioSettingsCandidate | undefined,
    databaseState: DurableStateStorePort | undefined,
  ) {
    this.#current = initial;
    this.#factory = factory;
    this.#store = store;
    this.#persistedCandidate = persistedCandidate;
    this.#databaseState = databaseState;
  }

  static async create(options: TesseraRuntimeManagerOptions): Promise<TesseraStudioRuntimeManager> {
    const factory = options.factory ?? defaultTesseraStudioRuntimeFactory;
    let state: Readonly<{ config: TesseraConfig; accessMode: TesseraDatabaseAccessMode }> = Object.freeze({
      config: options.config,
      accessMode: options.accessMode ?? "read-only",
    });
    let stored: TesseraStudioSettingsCandidate | undefined;
    if (options.store) {
      stored = await options.store.read();
      if (stored !== undefined) state = normalizeTesseraStudioSettings(options.config, stored);
    }
    const initial = await buildRuntimeRecord(factory, 1, state.config, state.accessMode, options.databaseState);
    return new TesseraStudioRuntimeManager(initial, factory, options.store, stored, options.databaseState);
  }

  /** Returns only the redacted document suitable for GET /api/settings. */
  getSnapshot(): TesseraStudioSettingsSnapshot {
    return createTesseraStudioSettingsSnapshot(this.#current.config, this.#current.accessMode);
  }

  /** Acquires the current generation synchronously so a route cannot race a later replacement. */
  acquire(): TesseraStudioRuntimeLease {
    if (this.#closed) {
      throw new TesseraSettingsRuntimeError("runtime_closed", "Tessera Studio is shutting down.");
    }
    const record = this.#current;
    record.leaseCount += 1;
    let released = false;
    return Object.freeze({
      runtime: record.runtime,
      release: async () => {
        if (released) return;
        released = true;
        record.leaseCount = Math.max(0, record.leaseCount - 1);
        await this.#disposeIfUnused(record);
      },
    });
  }

  async withRuntime<T>(use: (runtime: TesseraStudioRuntimeGeneration) => Promise<T> | T): Promise<T> {
    const lease = this.acquire();
    try {
      return await use(lease.runtime);
    } finally {
      await lease.release();
    }
  }

  /** Validates a candidate with an isolated connector and leaves the current generation untouched. */
  async test(
    candidateInput: unknown,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<TesseraSettingsValidationResult> {
    if (this.#closed) {
      throw new TesseraSettingsRuntimeError("runtime_closed", "Tessera Studio is shutting down.");
    }
    const state = normalizeTesseraStudioSettings(this.#current.config, candidateInput);
      const record = await buildRuntimeRecord(this.#factory, 0, state.config, state.accessMode, undefined);
    try {
      const assessment = await assessRuntime(record.runtime.connector, options.signal);
      return Object.freeze({
        settings: createTesseraStudioSettingsSnapshot(state.config, state.accessMode),
        connection: redactConnectionAssessment(assessment),
      });
    } finally {
      await disposeRuntimeRecord(record);
    }
  }

  /**
   * Replaces the active generation only after the candidate is built and,
   * by default, confirmed to reach its database. The old generation remains
   * usable to all already-acquired leases until those leases release.
   */
  replace(
    candidateInput: unknown,
    options: TesseraRuntimeReplaceOptions = {},
  ): Promise<TesseraStudioSettingsSnapshot> {
    const candidate = parseTesseraStudioSettingsCandidate(candidateInput);
    return this.#enqueue(async () => {
      if (this.#closed) {
        throw new TesseraSettingsRuntimeError("runtime_closed", "Tessera Studio is shutting down.");
      }

      const state = normalizeTesseraStudioSettings(this.#current.config, candidate);
      const next = await buildRuntimeRecord(this.#factory, this.#generation + 1, state.config, state.accessMode, this.#databaseState);
      try {
        if (options.verifyConnection ?? true) {
          const assessment = await assessRuntime(next.runtime.connector, options.signal);
          if (!assessment.connected) {
            throw new TesseraSettingsRuntimeError("connection_unavailable", "Tessera could not connect to the requested database.");
          }
        }
        if (this.#store) {
          const persistedCandidate = mergePersistedCandidate(this.#persistedCandidate, candidate);
          await this.#store.write(persistedCandidate);
          this.#persistedCandidate = persistedCandidate;
        }
      } catch (error) {
        await disposeRuntimeRecord(next);
        if (error instanceof TesseraSettingsRuntimeError) throw error;
        throw new TesseraSettingsRuntimeError("settings_persist_failed", "Tessera Studio could not save these settings.");
      }

      const previous = this.#current;
      this.#generation += 1;
      this.#current = next;
      previous.retired = true;
      this.#retired.add(previous);
      await this.#disposeIfUnused(previous);
      return this.getSnapshot();
    });
  }

  /** Updates only the server-owned database permission policy. */
  replacePermissions(
    permissions: TesseraDatabasePermissionSettings,
    options: Readonly<{ verifyConnection?: boolean; signal?: AbortSignal }> = {},
  ): Promise<TesseraStudioSettingsSnapshot> {
    const llm = resolveTesseraLlmConfig(this.#current.config);
    const [provider, ...modelParts] = llm.model.split("/");
    const candidate: TesseraStudioSettingsCandidate = {
      database: {
        dialect: this.#current.config.database.dialect,
        accessMode: this.#current.accessMode,
      },
      llm: {
        provider: provider ?? "openrouter",
        model: modelParts.join("/") || llm.model,
        reasoningEffort: llm.reasoningEffort ?? "default",
      },
      limits: {
        maxRows: this.#current.config.database.maxRows ?? 500,
        timeoutMs: this.#current.config.database.statementTimeoutMs ?? 15_000,
        maxSteps: llm.maxSteps,
      },
      permissions,
    };
    return this.replace(candidate, options);
  }

  /** Stops new leases and closes every generation after outstanding requests release. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#enqueue(async () => {
      if (this.#closed) return;
      this.#closed = true;
      this.#current.retired = true;
      this.#retired.add(this.#current);
      await this.#disposeIfUnused(this.#current);
    }).then(async () => {
      await Promise.all([...this.#retired].map((record) => record.closedPromise));
    });
    return this.#closePromise;
  }

  async #disposeIfUnused(record: RuntimeRecord): Promise<void> {
    if (!record.retired || record.leaseCount > 0 || record.closed) return;
    if (!record.closeTask) {
      record.closeTask = disposeRuntimeRecord(record).then(() => {
        record.closed = true;
        this.#retired.delete(record);
        record.resolveClosed();
      });
    }
    await record.closeTask;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#operationTail.then(operation, operation);
    this.#operationTail = task.then(() => undefined, () => undefined);
    return task;
  }
}

export async function createTesseraStudioRuntimeManager(
  options: TesseraRuntimeManagerOptions,
): Promise<TesseraStudioRuntimeManager> {
  return TesseraStudioRuntimeManager.create(options);
}

function createManagedConnector(config: TesseraConfig): DatabaseConnector {
  const options = {
    connectionString: config.database.url,
    id: config.database.id,
    schemas: config.database.schemas,
    maxRows: config.database.maxRows,
    statementTimeoutMs: config.database.statementTimeoutMs,
  };
  if (config.database.dialect === "mysql") return createMySqlConnector(options);
  return createPostgresConnector({ ...options, applicationName: "tessera-studio" });
}

async function buildRuntimeRecord(
  factory: TesseraStudioRuntimeFactory,
  generation: number,
  config: TesseraConfig,
  accessMode: TesseraDatabaseAccessMode,
  databaseState?: DurableStateStorePort,
): Promise<RuntimeRecord> {
  let build: TesseraStudioRuntimeBuild;
  try {
    build = await factory.create(config, { accessMode, ...(databaseState === undefined ? {} : { databaseState }) });
  } catch (error) {
    if (error instanceof TesseraSettingsRuntimeError) throw error;
    throw new TesseraSettingsRuntimeError("runtime_unavailable", "Tessera could not prepare the requested runtime.");
  }

  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    config,
    accessMode,
    runtime: Object.freeze({
      generation,
      accessMode,
      connector: build.connector,
      dataAgent: build.dataAgent,
      ...(build.sessionMemory === undefined ? {} : { sessionMemory: build.sessionMemory }),
      ...(build.agent === undefined ? {} : { agent: build.agent }),
      // Factories are injectable, so enforce the access-mode boundary here as
      // well as in the default factory. A read-only generation must never
      // expose a mutation service to Studio routes. The injected build is
      // still closed normally when its service is stripped.
      ...(accessMode !== "read-write" || build.databaseActions === undefined
        ? {}
        : { databaseActions: build.databaseActions }),
    }),
    close: build.close,
    leaseCount: 0,
    retired: false,
    closed: false,
    closedPromise,
    resolveClosed,
  };
}

async function disposeRuntimeRecord(record: RuntimeRecord): Promise<void> {
  try {
    await record.close();
  } catch {
    // Connector shutdown errors are intentionally not surfaced or logged: a
    // driver can include a connection string in its own error text.
  }
}

async function assessRuntime(connector: DatabaseConnector, signal?: AbortSignal): Promise<ConnectionAssessment> {
  try {
    return await connector.assess(signal);
  } catch {
    throw new TesseraSettingsRuntimeError("connection_unavailable", "Tessera could not connect to the requested database.");
  }
}

function redactConnectionAssessment(assessment: ConnectionAssessment): TesseraSettingsConnectionSnapshot {
  return Object.freeze({
    connected: assessment.connected,
    dialect: assessment.dialect,
    ...(assessment.databaseName === undefined ? {} : { databaseName: assessment.databaseName }),
    readOnlyTransactions: assessment.readOnlyTransactions,
    ...(assessment.credentialCanWrite === undefined ? {} : { credentialCanWrite: assessment.credentialCanWrite }),
    ...(assessment.latencyMs === undefined ? {} : { latencyMs: assessment.latencyMs }),
  });
}

function normalizeModelId(provider: string, model: string): string | undefined {
  const normalizedProvider = provider.trim().toLocaleLowerCase("en-US");
  const normalizedModel = model.trim();
  if (!normalizedProvider || !normalizedModel || /\s/.test(normalizedModel)) return undefined;
  const fullModel = normalizedModel.startsWith(`${normalizedProvider}/`)
    ? normalizedModel
    : `${normalizedProvider}/${normalizedModel}`;
  return fullModel.split("/").length >= 2 ? fullModel : undefined;
}

function providerFromModelId(model: string): string | undefined {
  const [provider] = model.split("/", 1);
  return provider?.trim().toLocaleLowerCase("en-US") || undefined;
}

/**
 * The browser may omit fields it did not edit. Preserve only prior local
 * overrides so a second settings save cannot erase a previously selected
 * database URL or API key from the private local store. Source config values
 * are intentionally not copied into this store.
 */
function mergePersistedCandidate(
  previous: TesseraStudioSettingsCandidate | undefined,
  next: TesseraStudioSettingsCandidate,
): TesseraStudioSettingsCandidate {
  const providerUnchanged = previous?.llm.provider === next.llm.provider;
  return parseTesseraStudioSettingsCandidate({
    database: {
      ...next.database,
      ...(next.database.url === undefined && previous?.database.url !== undefined
        ? { url: previous.database.url }
        : {}),
    },
    llm: {
      ...next.llm,
      ...(providerUnchanged && next.llm.apiKey === undefined && previous?.llm.apiKey !== undefined
        ? { apiKey: previous.llm.apiKey }
        : {}),
      ...(providerUnchanged && next.llm.baseUrl === undefined && previous?.llm.baseUrl !== undefined
        ? { baseUrl: previous.llm.baseUrl }
        : {}),
    },
    limits: next.limits,
    ...(next.permissions === undefined && previous?.permissions === undefined
      ? {}
      : { permissions: next.permissions ?? previous?.permissions }),
  });
}

/**
 * Browser Settings intentionally edits only the compact profile and statement
 * posture. Keep the server-owned scopes and ordered rules verbatim whenever a
 * user saves another Settings tab, and never feed a resolved policy hash back
 * into the strict config input schema.
 */
function databasePermissionPolicyInput(
  policy: DatabaseScopedPermissionPolicy,
  overrides?: TesseraDatabasePermissionSettings,
): DatabaseScopedPermissionPolicyInput {
  return databaseScopedPermissionPolicyInputSchema.parse({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    profile: overrides?.profile ?? policy.profile,
    sqlStatements: { ...(overrides?.sqlStatements ?? policy.sqlStatements) },
    ...(policy.subject === undefined ? {} : { subject: structuredClone(policy.subject) }),
    ...(policy.resource === undefined ? {} : { resource: structuredClone(policy.resource) }),
    rules: policy.rules.map((rule) => structuredClone(rule)),
  });
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || !url.hostname
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

function hasEnvironmentProviderKey(provider: string | undefined): boolean {
  const variables: Record<string, readonly string[]> = {
    openrouter: ["OPENROUTER_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    groq: ["GROQ_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    xai: ["XAI_API_KEY"],
    together: ["TOGETHER_API_KEY", "TOGETHERAI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
  };
  return (variables[provider?.toLocaleLowerCase("en-US") ?? ""] ?? [])
    .some((name) => Boolean(process.env[name]?.trim()));
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function closeSilently(connector: DatabaseConnector): Promise<void> {
  try {
    await connector.close();
  } catch {
    // See disposeRuntimeRecord: never permit driver-provided strings to escape.
  }
}
