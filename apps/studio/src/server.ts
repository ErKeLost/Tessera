import {
  catalogStats,
  type CatalogIntrospectionOptions,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseQueryResult,
  type DatabaseTable,
  databaseActionSchema,
} from "@data-elements/database";
import {
  createDataAgent,
  DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS,
  type DataAgent,
} from "@data-elements/data-agent";
import { createMySqlConnector } from "@data-elements/mysql";
import { createPostgresConnector } from "@data-elements/postgres";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
} from "ai";
import type { FinishReason } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createTesseraStudioAgent } from "./agent";
import {
  createTesseraConfigFromDatabaseUrl,
  defineTesseraConfig,
  isTesseraLlmConfigured,
  normalizeOrigin,
  resolveTesseraLlmConfig,
  type TesseraConfig,
  type TesseraConfigInput,
  TesseraConfigError,
} from "./config";
import {
  assistantTextHoldbackStart,
  isSafeAssistantTextFragment,
  redactOpaqueAssistantIdentifiers,
} from "./public-text";
import type {
  TesseraDataAgentStage,
  TesseraDataAgentStageStatus,
  TesseraEvidence,
  TesseraToolName,
  TesseraToolState,
  TesseraUIMessage,
  TesseraUIMessageChunk,
} from "./protocol";
import {
  createTesseraSessionMemory,
  tesseraSessionResourceId,
  tesseraThreadTitleFromMessage,
  type TesseraSessionMemory,
} from "./session-memory";
import {
  createTesseraLocalSettingsStore,
  createTesseraStudioRuntimeManager,
  parseTesseraStudioSettingsCandidate,
  TesseraSettingsRuntimeError,
  type TesseraDatabaseAccessMode,
  type TesseraDatabasePermissionSettings,
  type TesseraStudioRuntimeManager,
  type TesseraStudioRuntimeLease,
} from "./settings-runtime";
import {
  createTesseraDatabaseActionService,
  type TesseraDatabaseActionEffect,
  type TesseraDatabaseActionService,
} from "./database-actions";
import { createTesseraDurableStateStore, type TesseraDurableStateStore } from "./durable-state";
import type { DurableStateStorePort } from "@data-elements/runtime";
import {
  createOpenRouterModelCatalogProvider,
  type OpenRouterModelCatalogProvider,
} from "./openrouter-model-catalog";
import {
  createStudioConsoleLogger,
  silentStudioLogger,
  type StudioApiOperation,
  type StudioLogEvent,
  type StudioLogLevel,
  type StudioLogger,
  type StudioStreamOutcome,
} from "./studio-logger";

export type { StudioLogEvent, StudioLogger } from "./studio-logger";

const MAX_CHAT_MESSAGE_PARTS = 8;
const MAX_PUBLIC_TOOL_COUNT = 10_000;
const MAX_PUBLIC_STAGE_DURATION_MS = 120_000;
const MAX_PUBLIC_EVIDENCE = 32;
const MAX_PENDING_PUBLIC_NARRATION_CHARS = 4_096;
const TESSERA_PUBLIC_STAGES: readonly TesseraDataAgentStage[] = [
  "catalog",
  "retrieval",
  "planning",
  "probing",
  "compiling",
  "executing",
  "verifying",
  "publishing",
  "narrating",
];
const TESSERA_PUBLIC_TOOL_NAMES = new Set<TesseraToolName>([
  "inspect_catalog",
  "describe_data",
  "probe_data",
  "run_analysis",
]);
const TESSERA_PUBLIC_TOOL_STATES = new Set<TesseraToolState>([
  "started",
  "completed",
  "blocked",
  "failed",
]);
const TESSERA_PUBLIC_STAGE_SET = new Set<TesseraDataAgentStage>(TESSERA_PUBLIC_STAGES);
const TESSERA_PUBLIC_STAGE_STATUSES = new Set<TesseraDataAgentStageStatus>([
  "started",
  "completed",
  "failed",
]);
/** A table browser is intentionally narrower than governed Agent analysis. */
const TABLE_PREVIEW_MAX_ROWS = 100;
const TABLE_PREVIEW_MAX_COLUMNS = DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS;
const TABLE_PREVIEW_MAX_CELL_CHARS = 4_000;
const TABLE_PREVIEW_MAX_RESPONSE_CHARS = 512 * 1024;
const TABLE_PREVIEW_MAX_FOREIGN_KEYS = 16;
const TABLE_PREVIEW_MAX_FOREIGN_KEY_COLUMNS = 8;
const TABLE_PREVIEW_MAX_OBJECT_ITEMS = 32;
const TABLE_PREVIEW_MAX_OBJECT_DEPTH = 4;
const DEFAULT_STUDIO_CLIENT_ROOT = fileURLToPath(new URL("../dist/client", import.meta.url));
/** Bun defaults to 10 seconds; use its maximum global idle allowance for Studio HTTP requests. */
export const TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS = 255;
const STUDIO_CHAT_RETRY_TTL_MS = 10 * 60_000;
const MAX_STUDIO_CHAT_RETRIES = 256;

const runRequestSchema = z.object({
  message: z.string().trim().min(1).max(12_000),
  threadId: z.string().trim().min(1).max(128).optional(),
}).strict();

const createThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
}).strict();

const renameThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

const threadIdSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

const agentRunSchema = z.object({
  status: z.enum(["completed", "needs_input"]),
  message: z.string().max(30_000),
  evidence: z.array(z.object({
    queryId: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
  }).strict()).max(50).optional(),
}).strict();

const studioAgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text-delta"),
    text: z.string().min(1).max(4_096),
  }).strict(),
  z.object({
    type: z.literal("tool"),
    tool: z.enum(["inspect_catalog", "describe_data", "probe_data", "run_analysis"]),
    state: z.enum(["started", "completed", "blocked", "failed"]),
  }).strict(),
]);

const databaseActionSubmitRequestSchema = z.object({
  action: databaseActionSchema,
  purpose: z.string().trim().min(1).max(1_000),
  requestId: z.string().trim().min(1).max(256).optional(),
  invocationId: z.string().trim().min(1).max(256).optional(),
  stepId: z.string().trim().min(1).max(256).optional(),
  actionId: z.string().trim().min(1).max(256).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
}).strict();

const databaseActionApprovalRequestSchema = z.object({
  checkpointId: z.string().trim().min(1).max(256),
  decision: z.enum(["approve", "reject"]),
}).strict();

const databaseActionCancelRequestSchema = z.object({
  cancelRequestId: z.string().trim().min(1).max(256).optional(),
}).strict();

const databaseActionRequestIdSchema = z.string().trim().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f/]/.test(value),
);

type StudioChatTrigger = "submit-message" | "regenerate-message";
type StudioImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type StudioImageInput = Readonly<{
  dataUrl: string;
  mediaType: StudioImageMediaType;
}>;
type StudioChatRequest = z.infer<typeof runRequestSchema> & Readonly<{
  trigger: StudioChatTrigger;
  messageId?: string;
  images: readonly StudioImageInput[];
}>;

type StudioEnv = {
  Variables: {
    requestId: string;
    identity: StudioIdentity | undefined;
    apiRequest: StudioApiRequestLog | undefined;
    deferApiResponseLog: boolean | undefined;
    apiErrorLogged: boolean | undefined;
  };
};

type StudioErrorStatus = 400 | 401 | 403 | 404 | 413 | 415 | 422 | 500 | 502 | 503;

type StudioApiRequestLog = Readonly<{
  requestId: string;
  method: string;
  operation: StudioApiOperation;
  startedAt: number;
}>;

const studioIdentitySchema = z.object({
  subject: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  tenantId: z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  roles: z.array(z.string().trim().min(1).max(128)).max(64).readonly().optional(),
}).strict();

export type StudioIdentity = Readonly<z.infer<typeof studioIdentitySchema>>;
export type StudioAuthenticationInput = Readonly<{
  request: Request;
  requestId: string;
}>;
/** The host owns authentication and tenant membership; Tessera never parses credentials itself. */
export type StudioAuthenticator = (
  input: StudioAuthenticationInput,
) => StudioIdentity | undefined | Promise<StudioIdentity | undefined>;

/** Settings can contain credentials and can enable the database write surface. */
export type StudioSettingsChangeKind = "settings" | "test" | "access-mode" | "database-permissions";
export type StudioSettingsChangeAuthorizationInput = Readonly<{
  request: Request;
  requestId: string;
  identity: StudioIdentity;
  kind: StudioSettingsChangeKind;
}>;
/** The host owns its administrator role model and authorizes sensitive Settings changes here. */
export type StudioSettingsChangeAuthorizer = (
  input: StudioSettingsChangeAuthorizationInput,
) => boolean | Promise<boolean>;

export type StudioAgentRunInput = Readonly<{
  runId: string;
  threadId: string;
  message: string;
  images?: readonly StudioImageInput[];
  /**
   * Legacy Studio Agents receive a server-loaded catalog. Tessera's governed
   * Data Agent owns this lookup itself so its visible catalog stage remains
   * the source of truth for a chat run.
   */
  catalog?: DatabaseCatalog;
  signal: AbortSignal;
  identity?: StudioIdentity;
}>;

export type StudioAgentRun = z.infer<typeof agentRunSchema>;
export type StudioAgentEvent = z.infer<typeof studioAgentEventSchema>;

/**
 * The Agent boundary is intentionally narrow. It receives a discovered
 * catalog, never a connection string or connector, and returns JSON-safe UI
 * material that the Studio can render later.
 */
export interface StudioAgent {
  /**
   * `data-agent` means this implementation owns catalog loading and caching.
   * It lets the transport avoid a hidden preflight scan before the visible
   * governed workflow begins. Omitted preserves the legacy server-loaded
   * catalog behavior for embedded Studio Agents.
   */
  catalogLoading?: "data-agent";
  run(input: StudioAgentRunInput): Promise<StudioAgentRun>;
  stream?(input: StudioAgentRunInput, emit: (event: StudioAgentEvent) => void | Promise<void>): Promise<StudioAgentRun>;
  streamUI?(input: StudioAgentRunInput): ReadableStream<TesseraUIMessageChunk>;
}

export type StudioCatalogRequest = Readonly<{
  refresh?: boolean;
  signal?: AbortSignal;
}>;

export interface StudioCatalogProvider {
  get(request?: StudioCatalogRequest): Promise<DatabaseCatalog>;
}

export type StudioErrorReport = Readonly<{
  requestId: string;
  route: string;
  code: string;
}>;

export type StudioAppDependencies = Readonly<{
  connector: DatabaseConnector;
  /** The governed server-side execution boundary for catalog and previews. */
  dataAgent?: DataAgent;
  catalogProvider?: StudioCatalogProvider;
  agent?: StudioAgent;
  /** Server-only local SQLite session store. It never reads the analysed database. */
  sessionMemory?: TesseraSessionMemory;
  /** Typed, approval-gated database mutations. Read actions remain Data Agent-owned. */
  databaseActions?: TesseraDatabaseActionService;
  /** Enables local-only Settings endpoints backed by a lease-safe runtime manager. */
  settingsRuntime?: TesseraStudioRuntimeManager;
  /** Public model metadata used to validate and render the OpenRouter picker. */
  modelCatalog?: OpenRouterModelCatalogProvider;
  /** Supports dynamic runtimes where an LLM can be configured after startup. */
  agentAvailable?: () => Promise<boolean>;
  allowedOrigins?: readonly string[];
  authenticate?: StudioAuthenticator;
  requireAuthentication?: boolean;
  /** Required for Settings writes whenever Studio is connected to host authentication. */
  authorizeSettingsChange?: StudioSettingsChangeAuthorizer;
  reportError?: (report: StudioErrorReport) => void;
  logger?: StudioLogger;
}>;

/**
 * One coherent set of server-only dependencies for a Studio request. Dynamic
 * Settings runtimes construct this from a single leased generation, so a
 * catalog scan can never use a different connector than the Agent turn that
 * follows it.
 */
type StudioRouteRuntime = Readonly<{
  connector: DatabaseConnector;
  dataAgent: DataAgent;
  catalogProvider: StudioCatalogProvider;
  agent?: StudioAgent;
  sessionMemory?: TesseraSessionMemory;
  databaseActions?: TesseraDatabaseActionService;
}>;

type StudioRouteRuntimeLease = Readonly<{
  runtime: StudioRouteRuntime;
  release(): Promise<void>;
}>;

export type CreateStudioCatalogProviderOptions = Readonly<{
  introspection?: CatalogIntrospectionOptions;
  ttlMs?: number;
}>;

export type CreateTesseraStudioRuntimeOptions = Omit<StudioAppDependencies, "connector" | "catalogProvider" | "allowedOrigins" | "requireAuthentication"> & Readonly<{
  connector?: DatabaseConnector;
  catalogProvider?: StudioCatalogProvider;
  /** Optional shared governed Data Agent. When omitted, runtime creates one. */
  dataAgent?: DataAgent;
  /** Shared durable state used by the default governed mutation service. */
  databaseState?: DurableStateStorePort;
  /** Static runtimes are read-only unless the embedding host opts into writes. */
  accessMode?: TesseraDatabaseAccessMode;
}>;

export type TesseraStudioRuntime = Readonly<{
  app: Hono<StudioEnv>;
  connector: DatabaseConnector;
  dataAgent: DataAgent;
  databaseActions?: TesseraDatabaseActionService;
  close(): Promise<void>;
}>;

export type TesseraStudioServer = Readonly<{
  app: Hono<StudioEnv>;
  connector: DatabaseConnector;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}>;

/**
 * Creates the transport layer for the Tessera Studio. It deliberately contains
 * no provider credentials, model construction, or direct SQL route.
 */
export function createStudioApp(dependencies: StudioAppDependencies): Hono<StudioEnv> {
  const app = new Hono<StudioEnv>();
  const logger = dependencies.logger ?? silentStudioLogger;
  const chatRetries = createStudioChatRetryRegistry();
  const modelCatalog = dependencies.modelCatalog ?? createOpenRouterModelCatalogProvider();
  const dataAgent = dependencies.dataAgent ?? createDataAgent({ connector: dependencies.connector });
  const catalogProvider = dependencies.catalogProvider ?? createDataAgentCatalogProvider(dataAgent);
  const staticRuntime: StudioRouteRuntime = Object.freeze({
    connector: dependencies.connector,
    dataAgent,
    catalogProvider,
    ...(dependencies.agent === undefined ? {} : { agent: dependencies.agent }),
    ...(dependencies.sessionMemory === undefined ? {} : { sessionMemory: dependencies.sessionMemory }),
    ...(dependencies.databaseActions === undefined ? {} : { databaseActions: dependencies.databaseActions }),
  });
  const allowedOrigins = new Set(
    (dependencies.allowedOrigins ?? [])
      .map(normalizeOrigin)
      .filter((origin): origin is string => origin !== undefined),
  );

  app.use("*", async (context, next) => {
    context.set("requestId", randomUUID());
    context.header("Cache-Control", "no-store, max-age=0");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    await next();
  });

  app.use("/api/*", async (context, next) => {
    const request = createStudioApiRequestLog(context);
    context.set("apiRequest", request);
    writeStudioLog(logger, "info", {
      event: "request",
      stage: "received",
      requestId: request.requestId,
      method: request.method,
      operation: request.operation,
    });

    await next();

    if (context.get("deferApiResponseLog") || context.get("apiErrorLogged")) return;
    writeStudioLog(logger, context.res.status >= 400 ? "error" : "info", {
      event: "response",
      stage: "completed",
      requestId: request.requestId,
      method: request.method,
      operation: request.operation,
      status: context.res.status,
      durationMs: elapsedMilliseconds(request.startedAt),
    });
  });

  app.use("/api/*", async (context, next) => {
    const origin = context.req.header("origin");
    if (origin) {
      const normalizedOrigin = normalizeOrigin(origin);
      const requestOrigin = normalizeOrigin(new URL(context.req.url).origin);
      if (!normalizedOrigin || (normalizedOrigin !== requestOrigin && !allowedOrigins.has(normalizedOrigin))) {
        throw new StudioHttpError(403, "origin_denied", "This origin is not allowed to use Tessera Studio.");
      }
      context.header("Access-Control-Allow-Origin", normalizedOrigin);
      context.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      context.header("Access-Control-Allow-Headers", "Content-Type, X-Request-Id");
      context.header("Vary", "Origin");
    }
    if (context.req.method !== "OPTIONS" && (dependencies.requireAuthentication || dependencies.authenticate)) {
      let identity: StudioIdentity | undefined;
      try {
        const authenticated = dependencies.authenticate === undefined
          ? undefined
          : await dependencies.authenticate({
            request: context.req.raw,
            requestId: context.get("requestId"),
          });
        identity = authenticated === undefined ? undefined : studioIdentitySchema.parse(authenticated);
      } catch {
        throw new StudioHttpError(401, "authentication_required", "Tessera Studio requires an authenticated session.");
      }
      if (dependencies.requireAuthentication && identity === undefined) {
        throw new StudioHttpError(401, "authentication_required", "Tessera Studio requires an authenticated session.");
      }
      context.set("identity", identity);
    }
    await next();
  });

  app.options("/api/*", (context) => context.body(null, 204));

  app.get("/health", (context) => context.json({
    status: "ok",
    service: "tessera-studio",
    readiness: "ready",
  }));

  /** Secret-free runtime handshake. It intentionally does not disclose model or database configuration. */
  app.get("/api/meta", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const agentAvailable = runtime.agent !== undefined || await dependencies.agentAvailable?.() === true;
    return context.json({
      protocolVersion: 1,
      capabilities: {
        chat: agentAvailable,
      },
    });
  }));

  /**
   * Settings run only against the server-side runtime manager. Responses are
   * intentionally limited to the redacted snapshot and assessment types.
   */
  app.get("/api/settings", (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    return context.json({ settings: runtime.getSnapshot() });
  });

  app.get("/api/settings/models", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    const settings = runtime.getSnapshot();
    const currentModel = settings.llm.provider === "openrouter" ? settings.llm.model : undefined;
    return context.json(await modelCatalog.list({ currentModel }));
  });

  app.post("/api/settings/test", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    const candidate = await readJsonBody(context.req.raw);
    try {
      const parsedCandidate = parseTesseraStudioSettingsCandidate(candidate);
      await authorizeSettingsChange(context, dependencies, "test");
      await validateStudioReasoningSelection(parsedCandidate, modelCatalog);
      const result = await runtime.test(parsedCandidate, { signal: context.req.raw.signal });
      return context.json({
        settings: result.settings,
        connection: result.connection,
        message: result.connection.connected
          ? "Configuration test completed."
          : "Tessera could not connect to this database.",
      });
    } catch (error) {
      throw settingsRuntimeHttpError(error);
    }
  });

  app.put("/api/settings", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    const candidate = await readJsonBody(context.req.raw);
    try {
      const parsedCandidate = parseTesseraStudioSettingsCandidate(candidate);
      if (parsedCandidate.permissions !== undefined) {
        throw new TesseraSettingsRuntimeError("invalid_settings", "Database permissions must use the dedicated settings endpoint.");
      }
      const kind: StudioSettingsChangeKind = parsedCandidate.database.accessMode === runtime.getSnapshot().database.accessMode
        ? "settings"
        : "access-mode";
      await authorizeSettingsChange(context, dependencies, kind);
      await validateStudioReasoningSelection(parsedCandidate, modelCatalog);
      const settings = await runtime.replace(parsedCandidate, { signal: context.req.raw.signal });
      return context.json({ settings, message: "Settings saved." });
    } catch (error) {
      throw settingsRuntimeHttpError(error);
    }
  });

  app.put("/api/settings/permissions", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    const candidate = await readJsonBody(context.req.raw);
    try {
      await authorizeSettingsChange(context, dependencies, "database-permissions");
      const permissions = readDatabasePermissionSettings(candidate);
      const settings = await runtime.replacePermissions(permissions, { signal: context.req.raw.signal });
      return context.json({ settings, message: "Database permissions saved." });
    } catch (error) {
      throw settingsRuntimeHttpError(error);
    }
  });

  /**
   * Database mutations are deliberately exposed as typed actions only. The
   * service owns catalog binding, policy evaluation, approval and execution;
   * this transport never accepts or forwards SQL text.
   */
  app.get("/api/database-actions/capabilities", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    return context.json(await service.capabilities({ actor: databaseActionActor(context) }));
  }));

  app.post("/api/database-actions", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    const parsed = databaseActionSubmitRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!parsed.success) throw new StudioHttpError(400, "invalid_database_action", "The database action request is invalid.");
    try {
      const effect = await service.submit({
        actor: databaseActionActor(context),
        action: parsed.data.action,
        purpose: parsed.data.purpose,
        ...(parsed.data.requestId === undefined ? {} : { requestId: parsed.data.requestId }),
        ...(parsed.data.invocationId === undefined ? {} : { invocationId: parsed.data.invocationId }),
        ...(parsed.data.stepId === undefined ? {} : { stepId: parsed.data.stepId }),
        ...(parsed.data.actionId === undefined ? {} : { actionId: parsed.data.actionId }),
        ...(parsed.data.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.data.idempotencyKey }),
      });
      return databaseActionEffectResponse(context, effect);
    } catch (error) {
      throw databaseActionHttpError(error);
    }
  }));

  app.get("/api/database-actions/:requestId", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    const requestId = parseDatabaseActionRequestId(context.req.param("requestId"));
    try {
      return databaseActionEffectResponse(context, await service.get({
        actor: databaseActionActor(context),
        requestId,
      }));
    } catch (error) {
      throw databaseActionHttpError(error);
    }
  }));

  app.post("/api/database-actions/:requestId/approval", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    const requestId = parseDatabaseActionRequestId(context.req.param("requestId"));
    const parsed = databaseActionApprovalRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!parsed.success) throw new StudioHttpError(400, "invalid_database_action", "The approval request is invalid.");
    try {
      const effect = parsed.data.decision === "approve"
        ? await service.approve({ actor: databaseActionActor(context), requestId, checkpointId: parsed.data.checkpointId })
        : await service.reject({ actor: databaseActionActor(context), requestId, checkpointId: parsed.data.checkpointId });
      return databaseActionEffectResponse(context, effect);
    } catch (error) {
      throw databaseActionHttpError(error);
    }
  }));

  app.post("/api/database-actions/:requestId/cancel", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    const requestId = parseDatabaseActionRequestId(context.req.param("requestId"));
    const parsed = databaseActionCancelRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!parsed.success) throw new StudioHttpError(400, "invalid_database_action", "The cancellation request is invalid.");
    try {
      const receipt = await service.cancel({
        actor: databaseActionActor(context),
        requestId,
        ...(parsed.data.cancelRequestId === undefined ? {} : { cancelRequestId: parsed.data.cancelRequestId }),
      });
      return context.json(receipt);
    } catch (error) {
      throw databaseActionHttpError(error);
    }
  }));

  /**
   * Session navigation is intentionally separate from Agent memory recall.
   * Thread metadata is safe to display; messages are read only through the
   * narrowly filtered endpoint below.
   */
  app.get("/api/threads", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const threads = await memory.listThreads({ resourceId: resourceIdForContext(context) });
    return context.json({ threads });
  }));

  app.post("/api/threads", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const request = createThreadRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!request.success) {
      throw new StudioHttpError(400, "invalid_thread_request", "The session request is invalid.");
    }
    const thread = await memory.createThread({
      id: randomUUID(),
      resourceId: resourceIdForContext(context),
      ...(request.data.title === undefined ? {} : { title: request.data.title }),
    });
    return context.json({ thread }, 201);
  }));

  app.get("/api/threads/:threadId/messages", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const threadId = parseThreadId(context.req.param("threadId"));
    const messages = await memory.readMessages({ id: threadId, resourceId: resourceIdForContext(context) });
    if (messages === undefined) {
      throw new StudioHttpError(404, "thread_not_found", "The requested session is not available.");
    }
    return context.json({ messages });
  }));

  app.patch("/api/threads/:threadId", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const threadId = parseThreadId(context.req.param("threadId"));
    const request = renameThreadRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!request.success) {
      throw new StudioHttpError(400, "invalid_thread_request", "The session request is invalid.");
    }
    const thread = await memory.renameThread({
      id: threadId,
      resourceId: resourceIdForContext(context),
      title: request.data.title,
    });
    if (!thread) {
      throw new StudioHttpError(404, "thread_not_found", "The requested session is not available.");
    }
    return context.json({ thread });
  }));

  app.delete("/api/threads/:threadId", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const threadId = parseThreadId(context.req.param("threadId"));
    const resourceId = resourceIdForContext(context);
    const deleted = await memory.deleteThread({ id: threadId, resourceId });
    if (!deleted) {
      throw new StudioHttpError(404, "thread_not_found", "The requested session is not available.");
    }
    chatRetries.clearThread({ resourceId, threadId });
    return context.body(null, 204);
  }));

  app.get("/api/connection", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    let assessment: ConnectionAssessment;
    try {
      assessment = await runtime.connector.assess(context.req.raw.signal);
    } catch {
      throw new StudioHttpError(503, "connection_unavailable", "Tessera could not assess the configured database.");
    }
    return context.json({ connection: publicConnectionAssessment(assessment) });
  }));

  app.get("/api/catalog", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const refresh = context.req.query("refresh") === "1";
    let catalog: DatabaseCatalog;
    try {
      catalog = await runtime.catalogProvider.get({ refresh, signal: context.req.raw.signal });
    } catch {
      throw new StudioHttpError(503, "catalog_unavailable", "Tessera could not load the database catalog.");
    }
    return context.json({
      catalog: publicCatalog(catalog),
      stats: catalogStats(catalog),
    });
  }));

  /**
   * Table previews are catalog-constrained by design. The route accepts an
   * identifier pair only so the browser can navigate a discovered database;
   * it never accepts SQL, filters, sort expressions, or a caller-selected limit.
   */
  app.get("/api/data/:schema/:table", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    let catalog: DatabaseCatalog;
    try {
      catalog = await runtime.catalogProvider.get({ signal: context.req.raw.signal });
    } catch {
      throw new StudioHttpError(503, "catalog_unavailable", "Tessera could not load the database catalog.");
    }
    const schemaName = context.req.param("schema");
    const tableName = context.req.param("table");
    const table = schemaName && tableName
      ? findCatalogTable(catalog, schemaName, tableName)
      : undefined;
    if (!table) {
      throw new StudioHttpError(404, "table_not_found", "The selected table is not available in the current Tessera catalog.");
    }

    const previewColumns = table.columns
      .slice()
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(0, TABLE_PREVIEW_MAX_COLUMNS);
    if (previewColumns.length === 0) {
      throw new StudioHttpError(422, "table_not_previewable", "The selected table does not expose any columns to preview.");
    }

    let result: DatabaseQueryResult;
    try {
      result = (await runtime.dataAgent.previewRelation({
        schema: table.schema,
        table: table.name,
        columns: previewColumns.map((column) => column.name),
        // The route already resolved this relation through the governed cache.
        // Re-scanning on every table click would turn navigation into a full
        // catalog operation; an explicit catalog refresh remains available.
        refresh: false,
      }, context.req.raw.signal)).result;
    } catch {
      throw new StudioHttpError(503, "table_preview_unavailable", "Tessera could not load a preview for the selected table.");
    }

    return context.json(publicTablePreview(table, previewColumns, result));
  }));

  app.post("/api/runs", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    if (!runtime.agent) {
      throw new StudioHttpError(503, "agent_unavailable", "The Tessera Agent is not configured for this Studio.");
    }

    const request = runRequestSchema.safeParse(await readJsonBody(context.req.raw));
    if (!request.success) {
      throw new StudioHttpError(400, "invalid_run_request", "The run request is invalid.");
    }

    const runId = randomUUID();
    const threadId = request.data.threadId ?? randomUUID();
    await ensureStudioSession(runtime.sessionMemory, threadId, request.data.message, context);
    const catalog = await catalogForStudioAgent({
      agent: runtime.agent,
      catalogProvider: runtime.catalogProvider,
      signal: context.req.raw.signal,
      request: context.get("apiRequest"),
      runId,
      logger,
    });

    let run: StudioAgentRun;
    const agentStartedAt = performance.now();
    logAgentEvent(logger, "info", context.get("apiRequest"), runId, {
      stage: "run_started",
    });
    try {
      run = agentRunSchema.parse(await runtime.agent.run({
        runId,
        threadId,
        message: request.data.message,
        ...(catalog === undefined ? {} : { catalog: catalogForAgent(catalog) }),
        signal: context.req.raw.signal,
        ...(context.get("identity") === undefined ? {} : { identity: context.get("identity") }),
      }));
    } catch {
      logAgentEvent(logger, "error", context.get("apiRequest"), runId, {
        stage: "run_failed",
        code: "agent_run_failed",
        durationMs: elapsedMilliseconds(agentStartedAt),
      });
      throw new StudioHttpError(502, "agent_run_failed", "The Tessera Agent could not complete this run.");
    }

    logAgentEvent(logger, "info", context.get("apiRequest"), runId, {
      stage: "run_completed",
      durationMs: elapsedMilliseconds(agentStartedAt),
      runStatus: run.status,
    });

    return context.json({ run: publicAgentRun(runId, threadId, run) });
  }));

  /** User-facing chat transport using the AI SDK UI Message Stream protocol. */
  app.post("/api/chat", async (context) => {
    const lease = acquireStudioRouteRuntime(dependencies, staticRuntime);
    try {
      const runtime = lease.runtime;
      if (!runtime.agent) {
        throw new StudioHttpError(503, "agent_unavailable", "The Tessera Agent is not configured for this Studio.");
      }
      const request = await readStudioChatRequest(context.req.raw);

      if (request.trigger === "regenerate-message" && (request.threadId === undefined || request.messageId === undefined)) {
        throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
      }
      const runId = randomUUID();
      const threadId = request.threadId ?? randomUUID();
      const sessionResourceId = resourceIdForContext(context);
      let message = request.message;
      if (request.trigger === "regenerate-message") {
        const accepted = chatRetries.accept({
          resourceId: sessionResourceId,
          threadId,
          messageId: request.messageId!,
          message: request.message,
        });
        if (!accepted) {
          const persistedMessage = await unresolvedRetryMessage(runtime.sessionMemory, {
            resourceId: sessionResourceId,
            threadId,
            messageId: request.messageId!,
            message: request.message,
          });
          if (persistedMessage === undefined) {
            throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
          }
          message = persistedMessage;
        }
      } else {
        await ensureStudioSession(runtime.sessionMemory, threadId, message, context);
        // A later user turn supersedes any older failed-response retry token.
        // Otherwise a client could replay an old error after newer context
        // had already been accepted for this thread.
        chatRetries.clearThread({ resourceId: sessionResourceId, threadId });
        await appendStudioUiMessages(runtime.sessionMemory, {
          id: threadId,
          resourceId: sessionResourceId,
          messages: [{
            id: `tessera-user-${runId}`,
            role: "user",
            parts: [{ type: "text", text: message }],
          } satisfies TesseraUIMessage],
        });
      }
      const catalog = await catalogForStudioAgent({
        agent: runtime.agent,
        catalogProvider: runtime.catalogProvider,
        signal: context.req.raw.signal,
        request: context.get("apiRequest"),
        runId,
        logger,
      });

      const agentInput: StudioAgentRunInput = {
        runId,
        threadId,
        message,
        ...(request.images.length === 0 ? {} : { images: request.images }),
        ...(catalog === undefined ? {} : { catalog: catalogForAgent(catalog) }),
        signal: context.req.raw.signal,
        ...(context.get("identity") === undefined ? {} : { identity: context.get("identity") }),
      };

      const source = runtime.agent.streamUI?.(agentInput)
        ?? streamLegacyAgentToUI(runtime.agent, agentInput);
      const durableSource = createUIMessageStream<TesseraUIMessage>({
        execute: ({ writer }) => writer.merge(redactTesseraUiStream(source, { runId, threadId })),
        onError: () => "The Tessera Agent could not complete this analysis.",
        onEnd: async ({ responseMessage, isAborted, finishReason }) => {
          // `consumeSseStream` below ensures this callback also runs after an
          // interrupted SSE response.
          // Persist only a complete, visible assistant turn; partial/error
          // messages must not become future Mastra memory context.
          if (isAborted || finishReason !== "stop" || !hasVisibleAssistantText(responseMessage)) {
            chatRetries.mark({
              resourceId: sessionResourceId,
              threadId,
              messageId: `tessera-${runId}`,
              message,
            });
            return;
          }
          await appendStudioUiMessages(runtime.sessionMemory, {
            id: threadId,
            resourceId: sessionResourceId,
            messages: [responseMessage],
          });
        },
      });
      const streamStartedAt = performance.now();
      logAgentEvent(logger, "info", context.get("apiRequest"), runId, {
        event: "stream",
        stage: "started",
      });
      const stream = monitorStudioChatStream(durableSource, {
        request: context.get("apiRequest"),
        runId,
        startedAt: streamStartedAt,
        logger,
      });
      const response = createUIMessageStreamResponse({
        stream: stream.source,
        consumeSseStream: consumeStream,
        headers: {
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
      context.set("deferApiResponseLog", true);
      return withStudioStreamLease(
        withStudioStreamLogging(response, context.get("apiRequest"), logger, stream.outcome, {
          runId,
          startedAt: streamStartedAt,
        }),
        lease,
      );
    } catch (error) {
      await releaseStudioRouteLease(lease);
      throw error;
    }
  });

  app.notFound((context) => {
    logStudioError(context, logger, 404, "not_found");
    return errorResponse(context, 404, "not_found", "The requested Studio endpoint was not found.");
  });

  app.onError((error, context) => {
    if (error instanceof StudioHttpError) {
      logStudioError(context, logger, error.status, error.code);
      return errorResponse(context, error.status, error.code, error.publicMessage);
    }
    reportError(dependencies.reportError, {
      requestId: context.get("requestId") ?? "unknown",
      route: context.get("apiRequest")?.operation ?? "unknown",
      code: "internal_error",
    });
    logStudioError(context, logger, 500, "internal_error");
    return errorResponse(context, 500, "internal_error", "Tessera Studio could not complete this request.");
  });

  return app;
}

/**
 * Converts the current managed generation into the same narrow route shape
 * used by embedded/static Studio hosts. The catalog adapter is deliberately
 * derived from that generation's Data Agent, preserving its cache and
 * introspection policy during a request.
 */
function acquireStudioRouteRuntime(
  dependencies: StudioAppDependencies,
  staticRuntime: StudioRouteRuntime,
): StudioRouteRuntimeLease {
  const manager = dependencies.settingsRuntime;
  if (!manager) {
    return Object.freeze({
      runtime: staticRuntime,
      async release() {},
    });
  }

  const lease: TesseraStudioRuntimeLease = manager.acquire();
  return Object.freeze({
    runtime: Object.freeze({
      connector: lease.runtime.connector,
      dataAgent: lease.runtime.dataAgent,
      catalogProvider: createDataAgentCatalogProvider(lease.runtime.dataAgent),
      ...(lease.runtime.agent === undefined ? {} : { agent: lease.runtime.agent }),
      ...(lease.runtime.sessionMemory === undefined ? {} : { sessionMemory: lease.runtime.sessionMemory }),
      ...(lease.runtime.accessMode !== "read-write" || lease.runtime.databaseActions === undefined
        ? {}
        : { databaseActions: lease.runtime.databaseActions }),
    }),
    release: lease.release,
  });
}

async function withStudioRouteRuntime<T>(
  dependencies: StudioAppDependencies,
  staticRuntime: StudioRouteRuntime,
  use: (runtime: StudioRouteRuntime) => Promise<T> | T,
): Promise<T> {
  const lease = acquireStudioRouteRuntime(dependencies, staticRuntime);
  try {
    return await use(lease.runtime);
  } finally {
    await releaseStudioRouteLease(lease);
  }
}

function requireSettingsRuntime(value: TesseraStudioRuntimeManager | undefined): TesseraStudioRuntimeManager {
  if (!value) {
    throw new StudioHttpError(503, "settings_unavailable", "Tessera Studio settings are not available.");
  }
  return value;
}

/**
 * A standalone loopback Studio has no host identity system, so it remains
 * usable for local development. Once a host supplies authentication, it must
 * also explicitly decide who may alter credentials, policy, or write mode.
 */
async function authorizeSettingsChange(
  context: Context<StudioEnv>,
  dependencies: StudioAppDependencies,
  kind: StudioSettingsChangeKind,
): Promise<void> {
  const authorizer = dependencies.authorizeSettingsChange;
  if (authorizer === undefined) {
    if (dependencies.authenticate === undefined && !dependencies.requireAuthentication) return;
    throw new StudioHttpError(403, "settings_change_denied", "This Studio session cannot change server settings.");
  }
  const identity = context.get("identity");
  if (identity === undefined) {
    throw new StudioHttpError(403, "settings_change_denied", "This Studio session cannot change server settings.");
  }
  let allowed = false;
  try {
    allowed = await authorizer({
      request: context.req.raw,
      requestId: context.get("requestId"),
      identity,
      kind,
    });
  } catch {
    // An unavailable authorization authority must never widen access.
  }
  if (!allowed) {
    throw new StudioHttpError(403, "settings_change_denied", "This Studio session cannot change server settings.");
  }
}

/** Maps server-only runtime errors to a fixed, credential-free HTTP vocabulary. */
function settingsRuntimeHttpError(error: unknown): StudioHttpError {
  if (error instanceof StudioHttpError) return error;
  if (!(error instanceof TesseraSettingsRuntimeError)) {
    return new StudioHttpError(503, "settings_unavailable", "Tessera Studio settings are not available.");
  }
  switch (error.code) {
    case "invalid_settings":
      return new StudioHttpError(400, "invalid_settings", "The Studio settings are invalid.");
    case "connection_unavailable":
      return new StudioHttpError(503, "connection_unavailable", "Tessera could not connect to the requested database.");
    case "runtime_closed":
    case "runtime_unavailable":
      return new StudioHttpError(503, "runtime_unavailable", "The Tessera Studio runtime is not available.");
    case "settings_persist_failed":
    case "settings_store_unavailable":
      return new StudioHttpError(503, "settings_unavailable", "Tessera Studio settings are not available.");
  }
}

function readDatabasePermissionSettings(value: unknown): TesseraDatabasePermissionSettings {
  const parsed = z.object({
    profile: z.enum(["normal", "auto", "dangerous"]),
    sqlStatements: z.object({
      read: z.enum(["allow", "ask", "deny"]),
      write: z.enum(["allow", "ask", "deny"]),
      destructive: z.enum(["allow", "ask", "deny"]),
      unknown: z.enum(["allow", "ask", "deny"]),
    }).strict(),
  }).strict().safeParse(value);
  if (!parsed.success) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }
  return parsed.data;
}

/** Browser selections are advisory; validate against server-fetched metadata before rotating a runtime. */
async function validateStudioReasoningSelection(
  value: unknown,
  modelCatalog: OpenRouterModelCatalogProvider,
): Promise<void> {
  const candidate = parseTesseraStudioSettingsCandidate(value);
  if (candidate.llm.reasoningEffort === "default") return;
  if (candidate.llm.provider !== "openrouter") {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }
  const capability = await modelCatalog.getReasoning(candidate.llm.model);
  if (capability === undefined || !capability.supportedEfforts.includes(candidate.llm.reasoningEffort)) {
    throw new TesseraSettingsRuntimeError("invalid_settings", "Tessera Studio settings are invalid.");
  }
}

/**
 * Provides a short-lived, coalesced Catalog cache so navigation and Agent runs
 * do not independently re-scan the selected database on every request.
 */
export function createStudioCatalogProvider(
  connector: DatabaseConnector,
  options: CreateStudioCatalogProviderOptions = {},
): StudioCatalogProvider {
  const ttlMs = clampInteger(options.ttlMs ?? 60_000, 0, 10 * 60_000);
  let cached: DatabaseCatalog | undefined;
  let expiresAt = 0;
  let inFlight: Promise<DatabaseCatalog> | undefined;

  return {
    async get(request = {}) {
      if (!request.refresh && cached && Date.now() < expiresAt) {
        return waitForAbort(Promise.resolve(cached), request.signal);
      }
      if (!inFlight) {
        inFlight = connector.introspect(options.introspection).then((catalog) => {
          cached = catalog;
          expiresAt = Date.now() + ttlMs;
          return catalog;
        }).finally(() => {
          inFlight = undefined;
        });
      }
      return waitForAbort(inFlight, request.signal);
    },
  };
}

/**
 * Adapts the Data Agent's catalog cache to Studio navigation and table
 * previews. This keeps the Data Agent as the single owner of introspection
 * policy while preserving the small provider contract used by Hono routes.
 */
export function createDataAgentCatalogProvider(dataAgent: DataAgent): StudioCatalogProvider {
  return {
    async get(request = {}) {
      const snapshot = await dataAgent.inspectCatalog(
        { refresh: request.refresh ?? false },
        request.signal,
      );
      return snapshot.catalog;
    },
  };
}

/**
 * Builds the selected database runtime from a Tessera config. Agent creation is
 * injected so this server package stays useful while the Agent package evolves.
 */
export function createTesseraStudioRuntime(
  config: TesseraConfig,
  options: CreateTesseraStudioRuntimeOptions = {},
): TesseraStudioRuntime {
  const logger = options.logger ?? createStudioConsoleLogger();
  if (config.studio.requireAuthentication && options.authenticate === undefined) {
    throw new TesseraConfigError(
      "A Tessera Studio with studio.requireAuthentication enabled requires a host-provided authenticate adapter.",
    );
  }

  if (options.settingsRuntime) {
    const lease = options.settingsRuntime.acquire();
    try {
      const runtime = lease.runtime;
      const app = createStudioApp({
        connector: runtime.connector,
        dataAgent: runtime.dataAgent,
        catalogProvider: createDataAgentCatalogProvider(runtime.dataAgent),
        ...(runtime.agent === undefined ? {} : { agent: runtime.agent }),
        ...(runtime.sessionMemory === undefined ? {} : { sessionMemory: runtime.sessionMemory }),
        ...(runtime.accessMode !== "read-write" || runtime.databaseActions === undefined
          ? {}
          : { databaseActions: runtime.databaseActions }),
        settingsRuntime: options.settingsRuntime,
        agentAvailable: options.agentAvailable,
        allowedOrigins: config.studio.allowedOrigins,
        authenticate: options.authenticate,
        requireAuthentication: config.studio.requireAuthentication,
        authorizeSettingsChange: options.authorizeSettingsChange,
        reportError: options.reportError,
        logger,
      });
      return {
        app,
        connector: runtime.connector,
        dataAgent: runtime.dataAgent,
        ...(runtime.accessMode !== "read-write" || runtime.databaseActions === undefined
          ? {}
          : { databaseActions: runtime.databaseActions }),
        async close() {
          await options.settingsRuntime?.close();
        },
      };
    } finally {
      // The current generation cannot retire before this handoff completes;
      // routes subsequently acquire their own leases from the manager.
      void lease.release();
    }
  }

  const ownsConnector = options.connector === undefined;
  const connector = options.connector ?? createTesseraDatabaseConnector(config);
  if (connector.dialect !== config.database.dialect) {
    throw new TypeError("The injected Tessera database connector does not match the configured dialect.");
  }
  const dataAgent = options.dataAgent ?? createDataAgent({
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
  const catalogProvider = options.catalogProvider ?? createDataAgentCatalogProvider(dataAgent);
  const sessionMemory = createTesseraSessionMemory();
  const agent = options.agent ?? (isTesseraLlmConfigured(config)
    ? createTesseraStudioAgent({
      dataAgent,
      memory: sessionMemory.memory,
      llm: resolveTesseraLlmConfig(config),
    })
    : undefined);
  const accessMode = options.accessMode ?? "read-only";
  const databaseActions = accessMode !== "read-write"
    ? undefined
    : options.databaseActions ?? (options.databaseState === undefined
    ? undefined
    : createTesseraDatabaseActionService({
      connector,
      state: options.databaseState,
      policy: config.database.permissions,
      getCatalog: async (signal) => (await dataAgent.inspectCatalog({ refresh: true }, signal)).catalog,
    }));
  const app = createStudioApp({
    connector,
    dataAgent,
    catalogProvider,
    agent,
    sessionMemory,
    ...(databaseActions === undefined ? {} : { databaseActions }),
    allowedOrigins: config.studio.allowedOrigins,
    authenticate: options.authenticate,
    requireAuthentication: config.studio.requireAuthentication,
    authorizeSettingsChange: options.authorizeSettingsChange,
    reportError: options.reportError,
    logger,
  });

  return {
    app,
    connector,
    dataAgent,
    ...(databaseActions === undefined ? {} : { databaseActions }),
    async close() {
      await sessionMemory.close();
      if (ownsConnector) await connector.close();
    },
  };
}

/**
 * Creates Tessera's governed connector for the configured database. The URL
 * remains inside the connector and is never placed in an Agent prompt or API
 * response.
 */
export function createTesseraDatabaseConnector(config: TesseraConfig): DatabaseConnector {
  const options = {
    connectionString: config.database.url,
    id: config.database.id,
    schemas: config.database.schemas,
    maxRows: config.database.maxRows,
    statementTimeoutMs: config.database.statementTimeoutMs,
  };
  if (config.database.dialect === "mysql") {
    return createMySqlConnector(options);
  }
  return createPostgresConnector({
    ...options,
    applicationName: "tessera-studio",
  });
}

export async function startTesseraStudioServer(
  config: TesseraConfig,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioServer> {
  const startedAt = performance.now();
  const logger = options.logger ?? createStudioConsoleLogger();
  let runtime: TesseraStudioRuntime | undefined;
  let settingsRuntime: TesseraStudioRuntimeManager | undefined;
  let ownsSettingsRuntime = false;
  let durableState: TesseraDurableStateStore | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    settingsRuntime = options.settingsRuntime;
    if (!settingsRuntime) {
      ownsSettingsRuntime = true;
      durableState = createTesseraDurableStateStore();
      settingsRuntime = await createTesseraStudioRuntimeManager({
        config,
        store: createTesseraLocalSettingsStore(),
        databaseState: durableState.state,
      });
    }
    runtime = createTesseraStudioRuntime(config, { ...options, settingsRuntime, logger });
    server = Bun.serve({
      hostname: config.studio.host,
      port: config.studio.port,
      idleTimeout: TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS,
      fetch: createStudioFetchHandler(runtime.app),
    });
  } catch (error) {
    writeStudioLog(logger, "error", {
      event: "startup",
      stage: "failed",
      code: "server_start_failed",
      durationMs: elapsedMilliseconds(startedAt),
    });
    try {
      await runtime?.close();
    } catch {
      // Startup failures remain redacted even if a driver rejects shutdown.
    }
    if (!runtime && ownsSettingsRuntime) {
      try {
        await settingsRuntime?.close();
      } catch {
        // The original startup error remains the only observable failure.
      }
    }
    if (!runtime) {
      await durableState?.close().catch(() => undefined);
    }
    throw error;
  }

  if (!runtime || !server) throw new TypeError("Tessera Studio server did not initialize.");

  const port = server.port ?? config.studio.port;
  const host = config.studio.host.includes(":") ? `[${config.studio.host}]` : config.studio.host;
  let closed = false;
  writeStudioLog(logger, "info", {
    event: "startup",
    stage: "ready",
    listenPort: port,
    idleTimeoutSeconds: TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS,
    durationMs: elapsedMilliseconds(startedAt),
  });
  return {
    app: runtime.app,
    connector: runtime.connector,
    host: config.studio.host,
    port,
    url: `http://${host}:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      const shutdownAt = performance.now();
      server.stop();
      await runtime.close();
      await durableState?.close();
      writeStudioLog(logger, "info", {
        event: "shutdown",
        stage: "stopped",
        durationMs: elapsedMilliseconds(shutdownAt),
      });
    },
  };
}

/**
 * The ergonomic library entry point. It accepts the same unnormalised object
 * a `tessera.config.ts` file exports, including a database URL-only setup.
 */
export async function startTesseraStudio(
  config: TesseraConfigInput,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioServer> {
  return startTesseraStudioServer(defineTesseraConfig(config), options);
}

/** Starts a standalone local Studio when a host application only has a URL. */
export async function startTesseraStudioFromDatabaseUrl(
  url: string,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioServer> {
  return startTesseraStudioServer(createTesseraConfigFromDatabaseUrl(url), options);
}

type BunRequestTimeoutController = Readonly<{
  timeout(request: Request, seconds: number): void;
}>;

function createStudioFetchHandler(app: Hono<StudioEnv>): (request: Request, server: BunRequestTimeoutController) => Promise<Response> {
  return async (request, server) => {
    if (isLongRunningStudioRequest(request)) {
      // Bun's default 10 second idle timer also applies before an LLM emits
      // its first SSE byte. The server has a generous 255 second default, but
      // Agent requests remain open indefinitely while a provider is quiet.
      server.timeout(request, 0);
    }
    const response = await app.fetch(request);
    if (response.status !== 404 || request.method !== "GET" && request.method !== "HEAD") {
      return response;
    }
    const asset = await serveStudioClientAsset(request, DEFAULT_STUDIO_CLIENT_ROOT);
    return asset ?? response;
  };
}

function isLongRunningStudioRequest(request: Request): boolean {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url).pathname;
  return pathname === "/api/chat" || pathname === "/api/runs";
}

async function serveStudioClientAsset(request: Request, clientRoot: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname === "/api") return undefined;

  const assetPath = safeClientAssetPath(clientRoot, url.pathname);
  const target = resolve(clientRoot, assetPath ?? "index.html");
  const fallback = assetPath === undefined || !assetPath.includes(".");
  const filePath = await existingFile(target) ?? (fallback ? await existingFile(resolve(clientRoot, "index.html")) : undefined);
  if (!filePath) return undefined;

  const file = Bun.file(filePath);
  const headers = new Headers({
    "Cache-Control": filePath.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Type": file.type || contentTypeForPath(filePath),
  });
  if (request.method === "HEAD") {
    const metadata = await stat(filePath);
    headers.set("Content-Length", String(metadata.size));
    return new Response(null, { headers });
  }
  return new Response(file, { headers });
}

function safeClientAssetPath(clientRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const requested = decoded.replace(/^\/+/, "");
  if (!requested) return undefined;
  const resolved = resolve(clientRoot, requested);
  const outsideRoot = relative(clientRoot, resolved);
  if (outsideRoot === "" || outsideRoot === ".." || outsideRoot.startsWith(`..${sep}`)) return undefined;
  return requested;
}

async function existingFile(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

function contentTypeForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLocaleLowerCase("en-US");
  switch (extension) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function createStudioApiRequestLog(context: Context<StudioEnv>): StudioApiRequestLog {
  return {
    requestId: context.get("requestId") ?? "unknown",
    method: context.req.method,
    operation: studioApiOperation(context.req.path),
    startedAt: performance.now(),
  };
}

function studioApiOperation(path: string): StudioApiOperation {
  if (path === "/api/catalog") return "catalog";
  if (path === "/api/chat") return "chat";
  if (path === "/api/connection") return "connection";
  if (path === "/api/meta") return "meta";
  if (path === "/api/runs") return "runs";
  if (path === "/api/settings" || path === "/api/settings/test" || path === "/api/settings/models" || path === "/api/settings/permissions") return "settings";
  if (path.startsWith("/api/database-actions")) return "database_actions";
  if (path === "/api/threads" || path.startsWith("/api/threads/")) return "threads";
  if (path.startsWith("/api/data/")) return "data_preview";
  return "unknown";
}

function requireSessionMemory(value: TesseraSessionMemory | undefined): TesseraSessionMemory {
  if (!value) {
    throw new StudioHttpError(503, "session_unavailable", "Tessera session storage is not available.");
  }
  return value;
}

function resourceIdForContext(context: Context<StudioEnv>): string {
  return tesseraSessionResourceId(context.get("identity"));
}

function parseThreadId(value: string | undefined): string {
  const parsed = threadIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioHttpError(400, "invalid_thread_request", "The session request is invalid.");
  }
  return parsed.data;
}

async function ensureStudioSession(
  memory: TesseraSessionMemory | undefined,
  threadId: string,
  message: string,
  context: Context<StudioEnv>,
): Promise<void> {
  if (!memory) return;
  const validThreadId = parseThreadId(threadId);
  try {
    await memory.createThread({
      id: validThreadId,
      resourceId: resourceIdForContext(context),
      title: tesseraThreadTitleFromMessage(message),
    });
  } catch {
    // A thread id from a separate authenticated user must remain
    // indistinguishable from an unavailable local thread.
    throw new StudioHttpError(404, "thread_not_found", "The requested session is not available.");
  }
}

async function appendStudioUiMessages(
  memory: TesseraSessionMemory | undefined,
  input: Parameters<TesseraSessionMemory["appendUiMessages"]>[0],
): Promise<void> {
  if (!memory) return;
  try {
    await memory.appendUiMessages(input);
  } catch {
    // UI transcript persistence is best-effort and must never interrupt an
    // otherwise valid Agent stream. Mastra memory remains server-only.
  }
}

function hasVisibleAssistantText(value: unknown): boolean {
  const message = asRecord(value);
  if (message?.role !== "assistant" || !Array.isArray(message.parts)) return false;
  return message.parts.some((part) => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string" && record.text.trim().length > 0;
  });
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

type AgentCatalogLoadInput = Readonly<{
  catalogProvider: StudioCatalogProvider;
  signal: AbortSignal;
  request: StudioApiRequestLog | undefined;
  runId: string;
  logger: StudioLogger;
}>;

/**
 * Tessera's Data Agent already performs a governed catalog stage as part of its
 * fixed run. Other host-provided Agents retain the historical eager catalog
 * contract, so this transport optimization remains explicitly opt-in.
 */
async function catalogForStudioAgent(input: AgentCatalogLoadInput & {
  agent: StudioAgent;
}): Promise<DatabaseCatalog | undefined> {
  if (input.agent.catalogLoading === "data-agent") return undefined;
  try {
    return await loadAgentCatalog(input);
  } catch {
    throw new StudioHttpError(503, "catalog_unavailable", "Tessera could not load the database catalog.");
  }
}

async function loadAgentCatalog(input: AgentCatalogLoadInput): Promise<DatabaseCatalog> {
  const startedAt = performance.now();
  logAgentEvent(input.logger, "info", input.request, input.runId, {
    stage: "catalog_started",
  });
  try {
    const catalog = await input.catalogProvider.get({ signal: input.signal });
    logAgentEvent(input.logger, "info", input.request, input.runId, {
      stage: "catalog_completed",
      durationMs: elapsedMilliseconds(startedAt),
    });
    return catalog;
  } catch (error) {
    logAgentEvent(input.logger, "error", input.request, input.runId, {
      stage: "catalog_failed",
      code: "catalog_unavailable",
      durationMs: elapsedMilliseconds(startedAt),
    });
    throw error;
  }
}

type AgentLogDetails = Readonly<{
  event?: "agent" | "stream";
  stage: NonNullable<StudioLogEvent["stage"]>;
  code?: string;
  durationMs?: number;
  outcome?: StudioStreamOutcome;
  tool?: StudioLogEvent["tool"];
  toolState?: StudioLogEvent["toolState"];
  agentStage?: StudioLogEvent["agentStage"];
  agentStageStatus?: StudioLogEvent["agentStageStatus"];
  runStatus?: StudioLogEvent["runStatus"];
  finishReason?: StudioLogEvent["finishReason"];
  status?: number;
}>;

function logAgentEvent(
  logger: StudioLogger,
  level: StudioLogLevel,
  request: StudioApiRequestLog | undefined,
  runId: string,
  details: AgentLogDetails,
): void {
  if (!request) return;
  writeStudioLog(logger, level, {
    event: details.event ?? "agent",
    stage: details.stage,
    requestId: request.requestId,
    runId,
    method: request.method,
    operation: request.operation,
    ...(details.code === undefined ? {} : { code: details.code }),
    ...(details.durationMs === undefined ? {} : { durationMs: details.durationMs }),
    ...(details.outcome === undefined ? {} : { outcome: details.outcome }),
    ...(details.tool === undefined ? {} : { tool: details.tool }),
    ...(details.toolState === undefined ? {} : { toolState: details.toolState }),
    ...(details.agentStage === undefined ? {} : { agentStage: details.agentStage }),
    ...(details.agentStageStatus === undefined ? {} : { agentStageStatus: details.agentStageStatus }),
    ...(details.runStatus === undefined ? {} : { runStatus: details.runStatus }),
    ...(details.finishReason === undefined ? {} : { finishReason: details.finishReason }),
    ...(details.status === undefined ? {} : { status: details.status }),
  });
}

function logStudioError(
  context: Context<StudioEnv>,
  logger: StudioLogger,
  status: StudioErrorStatus,
  code: string,
): void {
  const request = context.get("apiRequest");
  if (!request) return;
  context.set("apiErrorLogged", true);
  writeStudioLog(logger, "error", {
    event: "error",
    stage: "http_failed",
    requestId: request.requestId,
    method: request.method,
    operation: request.operation,
    status,
    code,
    durationMs: elapsedMilliseconds(request.startedAt),
  });
}

type StudioStreamLogContext = Readonly<{
  request: StudioApiRequestLog | undefined;
  runId: string;
  startedAt: number;
  logger: StudioLogger;
}>;

function monitorStudioChatStream(
  source: ReadableStream<TesseraUIMessageChunk>,
  context: StudioStreamLogContext,
): Readonly<{
  source: ReadableStream<TesseraUIMessageChunk>;
  outcome(): StudioStreamOutcome;
}> {
  let failed = false;
  let cancelled = false;
  let finishReason: FinishReason | undefined;
  let emittedFirstEvent = false;
  return {
    source: source.pipeThrough(new TransformStream<TesseraUIMessageChunk, TesseraUIMessageChunk>({
      transform(chunk, controller) {
        if (!emittedFirstEvent) {
          emittedFirstEvent = true;
          logAgentEvent(context.logger, "info", context.request, context.runId, {
            event: "stream",
            stage: "first_event",
            durationMs: elapsedMilliseconds(context.startedAt),
          });
        }
        if (chunk.type === "data-tessera-tool") {
          logAgentEvent(context.logger, chunk.data.state === "failed" ? "error" : "info", context.request, context.runId, {
            event: "stream",
            stage: "tool",
            durationMs: elapsedMilliseconds(context.startedAt),
            tool: chunk.data.tool,
            toolState: chunk.data.state,
          });
        }
        if (chunk.type === "data-tessera-stage") {
          logAgentEvent(context.logger, chunk.data.status === "failed" ? "error" : "info", context.request, context.runId, {
            event: "agent",
            stage: "analysis_stage",
            durationMs: elapsedMilliseconds(context.startedAt),
            agentStage: chunk.data.stage,
            agentStageStatus: chunk.data.status,
          });
        }
        if (chunk.type === "abort") {
          cancelled = true;
        }
        if (chunk.type === "error") {
          failed = true;
        }
        if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          if (chunk.finishReason !== undefined && chunk.finishReason !== "stop") failed = true;
          logAgentEvent(context.logger, chunk.finishReason === "stop" ? "info" : "warn", context.request, context.runId, {
            event: "stream",
            stage: chunk.finishReason === "stop" ? "completed" : "failed",
            durationMs: elapsedMilliseconds(context.startedAt),
            finishReason: chunk.finishReason,
          });
        }
        controller.enqueue(chunk);
      },
    })),
    outcome() {
      if (cancelled) return "cancelled";
      return failed || finishReason !== "stop" ? "failed" : "completed";
    },
  };
}

function withStudioStreamLogging(
  response: Response,
  request: StudioApiRequestLog | undefined,
  logger: StudioLogger,
  completedOutcome: () => StudioStreamOutcome,
  stream: Readonly<{ runId: string; startedAt: number }>,
): Response {
  if (!request) return response;

  const logCompletion = (outcome: StudioStreamOutcome) => {
    logAgentEvent(
      logger,
      outcome === "completed" ? "info" : outcome === "cancelled" ? "warn" : "error",
      request,
      stream.runId,
      {
        event: "stream",
        stage: outcome,
        status: response.status,
        durationMs: elapsedMilliseconds(stream.startedAt),
        outcome,
      },
    );
  };

  if (!response.body) {
    logCompletion(completedOutcome());
    return response;
  }

  return new Response(observeStudioStream(response.body, logCompletion, completedOutcome), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A managed runtime must survive until the browser has consumed or cancelled
 * an Agent stream. Releasing it in the Hono handler would allow a Settings
 * replacement to close its connector while Mastra is still producing chunks.
 */
function withStudioStreamLease(response: Response, lease: StudioRouteRuntimeLease): Response {
  if (!response.body) {
    void releaseStudioRouteLease(lease);
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseStudioRouteLease(lease);
  };

  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          await release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await release();
      }
    },
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function releaseStudioRouteLease(lease: StudioRouteRuntimeLease): Promise<void> {
  try {
    await lease.release();
  } catch {
    // Runtime retirement failures must never alter an already-started stream.
  }
}

function observeStudioStream(
  source: ReadableStream<Uint8Array>,
  onCompletion: (outcome: StudioStreamOutcome) => void,
  completedOutcome: () => StudioStreamOutcome,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let settled = false;
  const complete = (outcome: StudioStreamOutcome) => {
    if (settled) return;
    settled = true;
    onCompletion(outcome);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          complete(completedOutcome());
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        complete("failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        complete("cancelled");
      }
    },
  });
}

function writeStudioLog(logger: StudioLogger, level: StudioLogLevel, event: StudioLogEvent): void {
  try {
    if (level === "debug") {
      logger.debug?.(event);
      return;
    }
    if (level === "warn") {
      logger.warn?.(event);
      return;
    }
    logger[level](event);
  } catch {
    // Observability must never affect an API response or streaming lifecycle.
  }
}

class StudioHttpError extends Error {
  constructor(
    readonly status: StudioErrorStatus,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

function requireDatabaseActionService(value: TesseraDatabaseActionService | undefined): TesseraDatabaseActionService {
  if (!value) {
    throw new StudioHttpError(503, "database_actions_unavailable", "Database actions are not enabled for this Studio runtime.");
  }
  return value;
}

function databaseActionActor(context: Context<StudioEnv>): {
  tenantRef: string;
  actorRef: string;
  roleRefs?: readonly string[];
} {
  const identity = context.get("identity");
  if (!identity) {
    throw new StudioHttpError(401, "authentication_required", "Database actions require an authenticated session.");
  }
  return {
    tenantRef: identity.tenantId,
    actorRef: identity.subject,
    ...(identity.roles === undefined ? {} : { roleRefs: identity.roles }),
  };
}

function parseDatabaseActionRequestId(value: string | undefined): string {
  const parsed = databaseActionRequestIdSchema.safeParse(value);
  if (!parsed.success) throw new StudioHttpError(400, "invalid_database_action", "The database action request is invalid.");
  return parsed.data;
}

function databaseActionEffectResponse(
  context: Context<StudioEnv>,
  effect: TesseraDatabaseActionEffect,
): Response {
  const status = effect.summary.status === "awaiting-approval"
    ? 202
    : effect.summary.status === "denied"
      ? 403
      : effect.summary.status === "failed"
        ? 502
        : 200;
  return context.json(effect, status);
}

/** Keeps internal broker/driver diagnostics out of the public transport. */
function databaseActionHttpError(error: unknown): StudioHttpError {
  if (error instanceof StudioHttpError) return error;
  if (error instanceof TypeError) {
    return new StudioHttpError(400, "invalid_database_action", "The database action request is invalid.");
  }
  if (error instanceof Error && /denied|not authorized|ownership|approval|stale|scope/i.test(error.message)) {
    return new StudioHttpError(403, "database_action_denied", "The database action is not authorized in the current scope.");
  }
  if (error instanceof Error && /unavailable|not found/i.test(error.message)) {
    return new StudioHttpError(404, "database_action_not_found", "The database action request is not available.");
  }
  return new StudioHttpError(502, "database_action_failed", "The database action could not be completed.");
}

function errorResponse(
  context: Context<StudioEnv>,
  status: StudioErrorStatus,
  code: string,
  message: string,
): Response {
  return context.json({
    error: {
      code,
      message,
      requestId: context.get("requestId") ?? "unknown",
    },
  }, status);
}

function publicConnectionAssessment(assessment: ConnectionAssessment): Record<string, unknown> {
  return {
    dialect: assessment.dialect,
    connected: assessment.connected,
    ...(assessment.databaseName ? { databaseName: assessment.databaseName } : {}),
    ...(assessment.serverVersion ? { serverVersion: assessment.serverVersion } : {}),
    readOnlyTransactions: assessment.readOnlyTransactions,
    ...(assessment.credentialCanWrite === undefined ? {} : { credentialCanWrite: assessment.credentialCanWrite }),
    ...(assessment.latencyMs === undefined ? {} : { latencyMs: assessment.latencyMs }),
    warnings: assessment.connected
      ? (assessment.credentialCanWrite
        ? ["The configured credential has write privileges. Use a dedicated read-only database role."]
        : [])
      : ["Tessera could not connect to the configured database."],
  };
}

function publicCatalog(catalog: DatabaseCatalog): Record<string, unknown> {
  return {
    // The browser gets a stable public binding label. The action service
    // resolves it to the current server-side connector before compilation.
    connectionRef: "tessera",
    dialect: catalog.dialect,
    databaseName: catalog.databaseName,
    scannedAt: catalog.scannedAt,
    fingerprint: catalog.fingerprint,
    schemas: catalog.schemas.map((schema) => ({
      name: schema.name,
      tables: schema.tables.map((table) => publicTable(table)),
    })),
  };
}

function findCatalogTable(
  catalog: DatabaseCatalog,
  schemaName: string,
  tableName: string,
): DatabaseTable | undefined {
  return catalog.schemas
    .find((schema) => schema.name === schemaName)
    ?.tables.find((table) => table.name === tableName);
}

function publicTable(
  table: DatabaseTable,
  columns: readonly DatabaseTable["columns"][number][] = table.columns,
  options: Readonly<{ maxForeignKeys?: number; maxForeignKeyColumns?: number }> = {},
): Record<string, unknown> {
  const maxForeignKeys = options.maxForeignKeys ?? table.foreignKeys.length;
  const maxForeignKeyColumns = options.maxForeignKeyColumns ?? Number.MAX_SAFE_INTEGER;
  return {
    schema: table.schema,
    name: table.name,
    kind: table.kind,
    ...(table.estimatedRows === undefined ? {} : { estimatedRows: table.estimatedRows }),
    columns: columns.map(publicTableColumn),
    primaryKey: [...table.primaryKey],
    foreignKeys: table.foreignKeys.slice(0, maxForeignKeys).map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns.slice(0, maxForeignKeyColumns),
      referencedSchema: foreignKey.referencedSchema,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: foreignKey.referencedColumns.slice(0, maxForeignKeyColumns),
    })),
  };
}

function publicTableColumn(column: DatabaseTable["columns"][number]): Record<string, unknown> {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    ordinal: column.ordinal,
  };
}

type PublicPreviewValue = string | number | boolean | null;

function publicTablePreview(
  table: DatabaseTable,
  columns: readonly DatabaseTable["columns"][number][],
  result: DatabaseQueryResult,
): Record<string, unknown> {
  let remainingCharacters = TABLE_PREVIEW_MAX_RESPONSE_CHARS;
  let responseBudgetExceeded = false;
  const rows: Array<Record<string, PublicPreviewValue>> = [];

  for (const sourceRow of result.rows.slice(0, TABLE_PREVIEW_MAX_ROWS)) {
    const row = Object.create(null) as Record<string, PublicPreviewValue>;
    let rowCharacters = 0;
    for (const column of columns) {
      const value = Object.prototype.hasOwnProperty.call(sourceRow, column.name)
        ? publicPreviewValue(sourceRow[column.name])
        : null;
      row[column.name] = value;
      rowCharacters += column.name.length + previewValueCharacterCost(value);
    }
    if (rowCharacters > remainingCharacters) {
      responseBudgetExceeded = true;
      break;
    }
    remainingCharacters -= rowCharacters;
    rows.push(row);
  }

  return {
    // The endpoint repeats only the bounded metadata needed for this view.
    // The complete public catalog remains available through /api/catalog.
    table: publicTable(table, columns, {
      maxForeignKeys: TABLE_PREVIEW_MAX_FOREIGN_KEYS,
      maxForeignKeyColumns: TABLE_PREVIEW_MAX_FOREIGN_KEY_COLUMNS,
    }),
    columns: columns.map(publicTableColumn),
    rows,
    rowCount: rows.length,
    truncated: result.truncated
      || result.rowCount > rows.length
      || result.rows.length > rows.length
      || responseBudgetExceeded,
    durationMs: publicPreviewDuration(result.durationMs),
  };
}

function publicPreviewValue(value: unknown): PublicPreviewValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncatePreviewText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite number]";
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return "[invalid date]";
    }
  }
  if (typeof value === "object") return serializePreviewObject(value);
  return "[unsupported value]";
}

function serializePreviewObject(value: object): string {
  if (ArrayBuffer.isView(value)) return "[binary value]";
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(normalizePreviewObject(value, seen, 0));
    return truncatePreviewText(serialized ?? "[structured value unavailable]");
  } catch {
    return "[structured value unavailable]";
  }
}

function normalizePreviewObject(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncatePreviewText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite number]";
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return publicPreviewValue(value);
  if (typeof value !== "object") return "[unsupported value]";
  if (ArrayBuffer.isView(value)) return "[binary value]";
  if (depth >= TABLE_PREVIEW_MAX_OBJECT_DEPTH) return "[nested value omitted]";
  if (seen.has(value)) return "[circular value]";
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value
      .slice(0, TABLE_PREVIEW_MAX_OBJECT_ITEMS)
      .map((item) => normalizePreviewObject(item, seen, depth + 1));
    if (value.length > TABLE_PREVIEW_MAX_OBJECT_ITEMS) normalized.push("[truncated]");
    return normalized;
  }

  const normalized = Object.create(null) as Record<string, unknown>;
  const record = value as Record<string, unknown>;
  let itemCount = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (itemCount >= TABLE_PREVIEW_MAX_OBJECT_ITEMS) {
      normalized["..."] = "[truncated]";
      break;
    }
    itemCount += 1;
    try {
      normalized[truncatePreviewText(key)] = normalizePreviewObject(record[key], seen, depth + 1);
    } catch {
      normalized[truncatePreviewText(key)] = "[unavailable]";
    }
  }
  return normalized;
}

function truncatePreviewText(value: string): string {
  return value.length <= TABLE_PREVIEW_MAX_CELL_CHARS
    ? value
    : `${value.slice(0, TABLE_PREVIEW_MAX_CELL_CHARS - 3)}...`;
}

function previewValueCharacterCost(value: PublicPreviewValue): number {
  return typeof value === "string" ? value.length + 8 : 32;
}

function publicPreviewDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 120_000) : 0;
}

function catalogForAgent(catalog: DatabaseCatalog): DatabaseCatalog {
  // Catalog comments/defaults are untrusted operational text. Models receive
  // only identifiers and relational structure, never a connector id.
  return {
    ...catalog,
    connectorId: "tessera",
    schemas: catalog.schemas.map((schema) => ({
      name: schema.name,
      tables: schema.tables.map((table) => ({
        schema: table.schema,
        name: table.name,
        kind: table.kind,
        ...(table.estimatedRows === undefined ? {} : { estimatedRows: table.estimatedRows }),
        columns: table.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          ordinal: column.ordinal,
        })),
        primaryKey: [...table.primaryKey],
        foreignKeys: table.foreignKeys.map((foreignKey) => ({
          name: foreignKey.name,
          columns: [...foreignKey.columns],
          referencedSchema: foreignKey.referencedSchema,
          referencedTable: foreignKey.referencedTable,
          referencedColumns: [...foreignKey.referencedColumns],
        })),
      })),
    })),
  };
}

/**
 * AI SDK clients submit UI messages, but Tessera owns conversation history on
 * the server. Accept exactly one new user message per request so an altered
 * browser transcript can never become Agent context. Text and supported image
 * attachments are extracted into the narrow Agent input below.
 */
async function readStudioChatRequest(request: Request): Promise<StudioChatRequest> {
  const payload = await readJsonBody(request);
  if (!isRecord(payload) || !Array.isArray(payload.messages) || payload.messages.length !== 1) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  validateChatTransportMetadata(payload);

  const validated = await safeValidateUIMessages({ messages: payload.messages });
  if (!validated.success) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  const message = validated.data[0];
  if (!message || message.role !== "user" || message.parts.length === 0 || message.parts.length > MAX_CHAT_MESSAGE_PARTS) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  const textParts = message.parts.filter((part) => part.type === "text");
  const imageParts: StudioImageInput[] = [];
  for (const part of message.parts) {
    if (part.type === "text") continue;
    if (part.type !== "file" || !isStudioImageMediaType(part.mediaType)) {
      throw new StudioHttpError(415, "unsupported_image", "Only PNG, JPEG, WebP, and GIF images are supported.");
    }
    const dataPrefix = `data:${part.mediaType};base64,`;
    if (!part.url.startsWith(dataPrefix)) {
      throw new StudioHttpError(400, "invalid_image", "Images must be provided as base64 data URLs.");
    }
    imageParts.push({ dataUrl: part.url, mediaType: part.mediaType });
  }

  const text = textParts.map((part) => part.text).join("\n").trim();
  const parsed = runRequestSchema.safeParse({
    message: text || (imageParts.length > 0 ? "Analyze the attached image." : ""),
    ...(typeof payload.threadId === "string" ? { threadId: payload.threadId } : {}),
  });
  if (!parsed.success) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  return {
    ...parsed.data,
    trigger: payload.trigger === "regenerate-message" ? "regenerate-message" : "submit-message",
    ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
    images: imageParts,
  };
}

function isStudioImageMediaType(value: string): value is StudioImageMediaType {
  return value === "image/png"
    || value === "image/jpeg"
    || value === "image/webp"
    || value === "image/gif";
}

function validateChatTransportMetadata(payload: Record<string, unknown>): void {
  if ("threadId" in payload && payload.threadId !== undefined
    && (typeof payload.threadId !== "string" || payload.threadId.trim().length === 0 || payload.threadId.length > 128)) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  if ("id" in payload && (typeof payload.id !== "string" || payload.id.length === 0 || payload.id.length > 128)) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  if ("trigger" in payload && payload.trigger !== "submit-message" && payload.trigger !== "regenerate-message") {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
  if ("messageId" in payload && payload.messageId !== null && payload.messageId !== undefined
    && (typeof payload.messageId !== "string" || payload.messageId.length === 0 || payload.messageId.length > 128)) {
    throw new StudioHttpError(400, "invalid_chat_request", "The chat request is invalid.");
  }
}

/**
 * A Vite/Bun watch restart intentionally drops the in-memory retry registry.
 * The persisted transcript is the durable authority: retry only when the
 * current thread still ends in the exact user turn that failed to receive an
 * answer. Browser text can never be substituted for that stored request.
 */
async function unresolvedRetryMessage(
  memory: TesseraSessionMemory | undefined,
  input: StudioChatRetryInput,
): Promise<string | undefined> {
  if (!memory || !isStudioRetryMessageId(input.messageId)) return undefined;
  try {
    const messages = await memory.readMessages({ id: input.threadId, resourceId: input.resourceId });
    const last = messages?.at(-1);
    if (!last || last.role !== "user") return undefined;
    const textParts = last.parts.filter((part): part is { type: "text"; text: string } => (
      part.type === "text" && typeof part.text === "string"
    ));
    if (textParts.length !== last.parts.length) return undefined;
    const message = textParts.map((part) => part.text).join("\n").trim();
    return message === input.message ? message : undefined;
  } catch {
    return undefined;
  }
}

function isStudioRetryMessageId(value: string): boolean {
  return /^tessera-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

type StudioChatRetryInput = Readonly<{
  resourceId: string;
  threadId: string;
  messageId: string;
  message: string;
}>;

type StudioChatRetryRecord = Readonly<{
  resourceId: string;
  threadId: string;
  messageHash: string;
  expiresAt: number;
}>;

/**
 * A `regenerate-message` request is allowed only after this server emitted an
 * incomplete response. The browser cannot manufacture a retry for a new prompt
 * because the opaque failed-response id and message digest must both match.
 */
function createStudioChatRetryRegistry() {
  const retries = new Map<string, StudioChatRetryRecord>();
  const retryKey = (input: Pick<StudioChatRetryInput, "resourceId" | "threadId" | "messageId">) => (
    JSON.stringify([input.resourceId, input.threadId, input.messageId])
  );
  const messageHash = (message: string) => createHash("sha256").update(message).digest("base64url");
  const prune = (now: number) => {
    for (const [key, retry] of retries) {
      if (retry.expiresAt <= now) retries.delete(key);
    }
  };

  return {
    mark(input: StudioChatRetryInput): void {
      const now = Date.now();
      prune(now);
      const key = retryKey(input);
      retries.delete(key);
      while (retries.size >= MAX_STUDIO_CHAT_RETRIES) {
        const oldest = retries.keys().next().value;
        if (oldest === undefined) break;
        retries.delete(oldest);
      }
      retries.set(key, {
        resourceId: input.resourceId,
        threadId: input.threadId,
        messageHash: messageHash(input.message),
        expiresAt: now + STUDIO_CHAT_RETRY_TTL_MS,
      });
    },
    accept(input: StudioChatRetryInput): boolean {
      const now = Date.now();
      prune(now);
      const key = retryKey(input);
      const retry = retries.get(key);
      if (!retry || retry.messageHash !== messageHash(input.message)) return false;
      retries.delete(key);
      return true;
    },
    clearThread(input: Readonly<{ resourceId: string; threadId: string }>): void {
      for (const [key, retry] of retries) {
        if (retry.resourceId === input.resourceId && retry.threadId === input.threadId) retries.delete(key);
      }
    },
  };
}

/**
 * Keeps injected test or alternate Agents on the same public AI SDK protocol.
 * The default Tessera Agent supplies its own streamUI implementation, backed by
 * @mastra/ai-sdk and a stricter Mastra-chunk whitelist.
 */
function streamLegacyAgentToUI(agent: StudioAgent, input: StudioAgentRunInput): ReadableStream<TesseraUIMessageChunk> {
  const textId = `tessera-text-${input.runId}`;
  let textStarted = false;
  let toolEvent = 0;
  const activeToolIds = new Map<string, string>();
  const stream = createUIMessageStream<TesseraUIMessage>({
    onError: () => "The Tessera Agent could not complete this analysis.",
    execute: async ({ writer }) => {
      const startText = () => {
        if (textStarted) return;
        textStarted = true;
        writer.write({ type: "text-start", id: textId });
      };
      const finishText = () => {
        if (!textStarted) return;
        writer.write({ type: "text-end", id: textId });
      };
      writer.write({ type: "start", messageId: `tessera-${input.runId}` });
      try {
        const run = agentRunSchema.parse(
          agent.stream
            ? await agent.stream(input, async (event) => {
              const safe = studioAgentEventSchema.safeParse(event);
              if (!safe.success) return;
              if (safe.data.type === "text-delta") {
                startText();
                writer.write({ type: "text-delta", id: textId, delta: safe.data.text });
                return;
              }
              let toolId = activeToolIds.get(safe.data.tool);
              if (safe.data.state === "started" || toolId === undefined) {
                toolEvent += 1;
                toolId = `tessera-tool-${input.runId}-${toolEvent}`;
                activeToolIds.set(safe.data.tool, toolId);
              }
              writer.write({
                type: "data-tessera-tool",
                id: toolId,
                data: { runId: input.runId, tool: safe.data.tool, state: safe.data.state },
              });
              if (safe.data.state !== "started") activeToolIds.delete(safe.data.tool);
            })
            : await agent.run(input),
        );
        if (!textStarted && run.message) {
          startText();
          writer.write({ type: "text-delta", id: textId, delta: run.message });
        }
        finishText();

        const evidence = run.evidence ?? [];
        writer.write({
          type: "data-tessera-run",
          id: `tessera-run-${input.runId}`,
          data: {
            runId: input.runId,
            threadId: input.threadId,
            status: run.status,
            evidence,
          },
        });
        writer.write({ type: "finish", finishReason: "stop" });
      } catch {
        finishText();
        writer.write({ type: "error", errorText: "The Tessera Agent could not complete this analysis." });
        writer.write({ type: "finish", finishReason: "error" });
      }
    },
  });
  return stream as ReadableStream<TesseraUIMessageChunk>;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json") {
    throw new StudioHttpError(415, "json_required", "Requests to this endpoint must use application/json.");
  }
  if (!request.body) {
    throw new StudioHttpError(400, "invalid_json", "The request body must contain JSON.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new StudioHttpError(400, "invalid_json", "The request body must contain valid JSON.");
  }
}

function publicAgentRun(runId: string, threadId: string, run: StudioAgentRun): Record<string, unknown> {
  return {
    id: runId,
    threadId,
    status: run.status,
    message: run.message,
    ...(run.evidence === undefined ? {} : { evidence: run.evidence }),
  };
}

type TesseraPublicStreamContext = Readonly<{
  runId: string;
  threadId: string;
}>;

type TesseraPublicToolCall = Readonly<{
  id: string;
  tool: TesseraToolName;
}>;

type TesseraPublicStreamState = {
  readonly sourceToolCalls: Map<string, TesseraPublicToolCall>;
  readonly sourceTextIds: Map<string, string>;
  readonly sourceDataToolIds: Map<string, string>;
  /** A text start crosses the boundary only with a safe first delta. */
  readonly startedNarrations: Set<string>;
  readonly pendingNarrations: Map<string, string>;
  /** A rejected narrative makes the rest of this UI message unpublishable. */
  unsafeNarration: boolean;
  nextTextId: number;
  nextToolId: number;
};

/**
 * `streamUI` is an extension point. Treat its output as untrusted even when it
 * is typed as TesseraUIMessageChunk: injected agents can cast arbitrary data into
 * that type. Rebuild each supported chunk from public fields rather than
 * forwarding a partial object with provider metadata or raw tool payloads.
 */
function redactTesseraUiStream(
  source: ReadableStream<TesseraUIMessageChunk>,
  context: TesseraPublicStreamContext,
): ReadableStream<TesseraUIMessageChunk> {
  const state: TesseraPublicStreamState = {
    sourceToolCalls: new Map(),
    sourceTextIds: new Map(),
    sourceDataToolIds: new Map(),
    startedNarrations: new Set(),
    pendingNarrations: new Map(),
    unsafeNarration: false,
    nextTextId: 1,
    nextToolId: 1,
  };
  return source.pipeThrough(new TransformStream<TesseraUIMessageChunk, TesseraUIMessageChunk>({
    transform(chunk, controller) {
      const publicChunks = redactTesseraUiChunk(chunk, context, state);
      if (publicChunks && "type" in publicChunks) {
        controller.enqueue(publicChunks);
      } else if (publicChunks) {
        for (const publicChunk of publicChunks) controller.enqueue(publicChunk);
      }
    },
  }));
}

function redactTesseraUiChunk(
  chunk: unknown,
  context: TesseraPublicStreamContext,
  state: TesseraPublicStreamState,
): TesseraUIMessageChunk | readonly TesseraUIMessageChunk[] | undefined {
  const source = asRecord(chunk);
  if (!source || typeof source.type !== "string") return undefined;

  // Never publish a partially rejected message as a successful answer. The
  // source stream can be supplied by an embedded host, so it is not trusted
  // merely because it conforms to the UI-message TypeScript type.
  if (state.unsafeNarration) {
    if (source.type === "abort") return { type: "abort" } as TesseraUIMessageChunk;
    if (source.type === "finish") return { type: "finish", finishReason: "error" } as TesseraUIMessageChunk;
    return undefined;
  }

  switch (source.type) {
    case "start":
      return { type: "start", messageId: `tessera-${context.runId}` } as TesseraUIMessageChunk;
    case "text-start": {
      // An unsafe split response must not leave an open text part in the
      // browser before the prefix gate has accepted any of its content.
      publicTextId(source.id, context, state);
      return undefined;
    }
    case "text-delta": {
      const id = publicTextId(source.id, context, state);
      return id ? publicAssistantTextDeltas(source.delta, id, state) : undefined;
    }
    case "text-end": {
      const id = publicTextId(source.id, context, state);
      if (id === undefined) return undefined;
      const flushed = flushPublicAssistantText(id, state);
      return state.startedNarrations.has(id)
        ? [...flushed, { type: "text-end", id } as TesseraUIMessageChunk]
        : flushed;
    }
    case "tool-input-start": {
      const tool = asTesseraToolName(source.toolName);
      const call = tool === undefined ? undefined : publicToolCall(source.toolCallId, tool, context, state);
      return call === undefined
        ? undefined
        : {
          type: "tool-input-start",
          toolCallId: call.id,
          toolName: call.tool,
          providerExecuted: true,
          title: publicToolTitle(call.tool),
        } as TesseraUIMessageChunk;
    }
    case "tool-input-available": {
      const tool = asTesseraToolName(source.toolName);
      const call = tool === undefined ? undefined : publicToolCall(source.toolCallId, tool, context, state);
      return call === undefined
        ? undefined
        : {
          type: "tool-input-available",
          toolCallId: call.id,
          toolName: call.tool,
          input: publicToolInput(call.tool),
          providerExecuted: true,
          title: publicToolTitle(call.tool),
        } as TesseraUIMessageChunk;
    }
    case "tool-input-error": {
      const tool = asTesseraToolName(source.toolName);
      const call = tool === undefined ? undefined : publicToolCall(source.toolCallId, tool, context, state);
      return call === undefined
        ? undefined
        : {
          type: "tool-input-error",
          toolCallId: call.id,
          toolName: call.tool,
          input: publicToolInput(call.tool),
          providerExecuted: true,
          errorText: "This operation could not be prepared.",
          title: publicToolTitle(call.tool),
        } as TesseraUIMessageChunk;
    }
    case "tool-output-available": {
      const call = publicExistingToolCall(source.toolCallId, state);
      if (call === undefined) return undefined;
      const output = publicToolOutput(call.tool, source.output);
      // Mastra represents invalid tool input as an output value. Present it
      // as a real terminal tool error so the client never leaves the row in a
      // retrying/output-available visual state.
      if (output.status === "failed") {
        return {
          type: "tool-output-error",
          toolCallId: call.id,
          providerExecuted: true,
          errorText: "This operation could not be completed.",
        } as TesseraUIMessageChunk;
      }
      return {
        type: "tool-output-available",
        toolCallId: call.id,
        output,
        providerExecuted: true,
      } as TesseraUIMessageChunk;
    }
    case "tool-output-error": {
      const call = publicExistingToolCall(source.toolCallId, state);
      return call === undefined
        ? undefined
        : {
          type: "tool-output-error",
          toolCallId: call.id,
          providerExecuted: true,
          errorText: "This operation could not be completed.",
        } as TesseraUIMessageChunk;
    }
    case "tool-output-denied": {
      const call = publicExistingToolCall(source.toolCallId, state);
      return call === undefined
        ? undefined
        : { type: "tool-output-denied", toolCallId: call.id } as TesseraUIMessageChunk;
    }
    case "data-tessera-tool": {
      const data = asRecord(source.data);
      const tool = asTesseraToolName(data?.tool);
      const toolState = asTesseraToolState(data?.state);
      if (tool === undefined || toolState === undefined) return undefined;
      return {
        type: "data-tessera-tool",
        id: publicDataToolId(source.id, context, state),
        data: { runId: context.runId, tool, state: toolState },
      } as TesseraUIMessageChunk;
    }
    case "data-tessera-stage": {
      const stage = publicStageData(source.data);
      return stage === undefined
        ? undefined
        : {
          type: "data-tessera-stage",
          id: `tessera-stage-${context.runId}-${stage.stage}`,
          data: { runId: context.runId, ...stage },
        } as TesseraUIMessageChunk;
    }
    case "data-tessera-execution": {
      const execution = publicExecutionTrace(source.data, context.runId);
      return execution === undefined
        ? undefined
        : {
          type: "data-tessera-execution",
          id: `tessera-execution-${context.runId}`,
          data: execution,
        } as TesseraUIMessageChunk;
    }
    case "data-tessera-artifact":
      return undefined;
    case "data-tessera-run": {
      const data = asRecord(source.data);
      if (data?.status !== "completed" && data?.status !== "needs_input") return undefined;
      return {
        type: "data-tessera-run",
        id: `tessera-run-${context.runId}`,
        data: {
          runId: context.runId,
          threadId: context.threadId,
          status: data.status,
          evidence: publicEvidence(data.evidence, context.runId),
        },
      } as TesseraUIMessageChunk;
    }
    case "start-step":
    case "finish-step":
      // These are provider iteration markers, not user-visible progress. The
      // Tessera timeline is driven by explicit tool and execution-stage chunks.
      return undefined;
    case "error":
      return { type: "error", errorText: "The Tessera Agent could not complete this analysis." } as TesseraUIMessageChunk;
    case "abort":
      return { type: "abort" } as TesseraUIMessageChunk;
    case "finish":
      {
        const finishReason = publicFinishReason(source.finishReason);
        return [
          ...flushAllPublicAssistantText(state),
          {
            type: "finish",
            ...(finishReason === undefined ? {} : { finishReason }),
          } as TesseraUIMessageChunk,
        ];
      }
    default:
      // Provider metadata, input deltas, sources, files, reasoning, and custom
      // chunks can all carry private execution material. They have no public
      // Tessera UI contract, so the browser never receives them.
      return undefined;
  }
}

function publicTextId(
  sourceId: unknown,
  context: TesseraPublicStreamContext,
  state: TesseraPublicStreamState,
): string | undefined {
  const id = sourceIdentifier(sourceId);
  if (!id) return undefined;
  const existing = state.sourceTextIds.get(id);
  if (existing) return existing;
  const publicId = `tessera-text-${context.runId}-${state.nextTextId++}`;
  state.sourceTextIds.set(id, publicId);
  return publicId;
}

function publicToolCall(
  sourceId: unknown,
  tool: TesseraToolName,
  context: TesseraPublicStreamContext,
  state: TesseraPublicStreamState,
): TesseraPublicToolCall | undefined {
  const id = sourceIdentifier(sourceId);
  if (!id) return undefined;
  const existing = state.sourceToolCalls.get(id);
  if (existing) return existing.tool === tool ? existing : undefined;
  const call = { id: `tessera-tool-${context.runId}-${state.nextToolId++}`, tool };
  state.sourceToolCalls.set(id, call);
  return call;
}

function publicExistingToolCall(
  sourceId: unknown,
  state: TesseraPublicStreamState,
): TesseraPublicToolCall | undefined {
  const id = sourceIdentifier(sourceId);
  return id === undefined ? undefined : state.sourceToolCalls.get(id);
}

function publicDataToolId(
  sourceId: unknown,
  context: TesseraPublicStreamContext,
  state: TesseraPublicStreamState,
): string {
  const id = sourceIdentifier(sourceId);
  if (!id) return `tessera-tool-${context.runId}-${state.nextToolId++}`;
  const toolCall = state.sourceToolCalls.get(id);
  if (toolCall) return toolCall.id;
  const existing = state.sourceDataToolIds.get(id);
  if (existing) return existing;
  const publicId = `tessera-tool-${context.runId}-${state.nextToolId++}`;
  state.sourceDataToolIds.set(id, publicId);
  return publicId;
}

function publicToolInput(tool: TesseraToolName): Record<string, string> {
  if (tool === "inspect_catalog") return { action: "inspect_governed_catalog" };
  if (tool === "describe_data") return { action: "describe_governed_catalog" };
  if (tool === "probe_data") return { action: "probe_governed_data" };
  return { action: "run_governed_analysis" };
}

function publicToolOutput(tool: TesseraToolName, value: unknown): Record<string, unknown> {
  const output = isRecord(value) ? value : undefined;
  if (tool === "inspect_catalog") {
    const tableCount = boundedPublicInteger(output?.tableCount, MAX_PUBLIC_TOOL_COUNT);
    return {
      status: output?.status === "completed" ? "completed" : "failed",
      ...(tableCount === undefined ? {} : { tableCount }),
      ...(output?.truncated === true ? { truncated: true } : {}),
    };
  }

  // A rejected semantic draft is a completed, terminal tool outcome: the
  // model can revise its plan, but the browser must not present this as a
  // transport error or leave a tool call retrying. Keep the rejection reason
  // server-side and expose the established public `blocked` state instead.
  const status = output?.status === "completed" || output?.status === "blocked" || output?.status === "failed"
    ? output.status
    : output?.status === "rejected"
      ? "blocked"
      : "failed";
  if (tool === "describe_data") {
    const entityCount = boundedPublicInteger(output?.entityCount, MAX_PUBLIC_TOOL_COUNT);
    return {
      status,
      ...(entityCount === undefined ? {} : { entityCount }),
      ...(output?.truncated === true ? { truncated: true } : {}),
    };
  }
  if (tool === "probe_data") return { status };

  const rowCount = boundedPublicInteger(output?.rowCount, MAX_PUBLIC_TOOL_COUNT);
  return {
    status,
    ...(rowCount === undefined ? {} : { rowCount }),
    ...(output?.truncated === true ? { truncated: true } : {}),
  };
}

function publicToolTitle(tool: TesseraToolName): string {
  if (tool === "inspect_catalog") return "Inspect data catalog";
  if (tool === "describe_data") return "Describe data definitions";
  if (tool === "probe_data") return "Probe governed data";
  return "Run governed analysis";
}

function publicStageData(value: unknown): Readonly<{
  stage: TesseraDataAgentStage;
  status: TesseraDataAgentStageStatus;
  durationMs?: number;
}> | undefined {
  const source = asRecord(value);
  const stage = asTesseraStage(source?.stage);
  const status = asTesseraStageStatus(source?.status);
  if (stage === undefined || status === undefined) return undefined;
  const durationMs = boundedPublicDuration(source?.durationMs);
  return { stage, status, ...(durationMs === undefined ? {} : { durationMs }) };
}

function publicExecutionTrace(value: unknown, runId: string): Readonly<{
  runId: string;
  status: "running" | "completed" | "failed";
  stages: readonly Readonly<{
    stage: TesseraDataAgentStage;
    status: TesseraDataAgentStageStatus;
    durationMs?: number;
  }>[];
}> | undefined {
  const source = asRecord(value);
  if (!source || !Array.isArray(source.stages)) return undefined;
  const status = source.status === "running" || source.status === "completed" || source.status === "failed"
    ? source.status
    : undefined;
  if (status === undefined) return undefined;

  const stages = new Map<TesseraDataAgentStage, ReturnType<typeof publicStageData>>();
  for (const stage of source.stages.slice(0, TESSERA_PUBLIC_STAGES.length)) {
    const safe = publicStageData(stage);
    if (safe) stages.set(safe.stage, safe);
  }
  return {
    runId,
    status,
    stages: TESSERA_PUBLIC_STAGES.flatMap((stage) => {
      const safe = stages.get(stage);
      return safe === undefined ? [] : [safe];
    }),
  };
}

function publicEvidence(value: unknown, runId: string): readonly TesseraEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PUBLIC_EVIDENCE).flatMap((entry, index) => (
    isRecord(entry)
      ? [{ queryId: `${runId}-evidence-${index + 1}`, label: "Verified result" }]
      : []
  ));
}

function asTesseraToolName(value: unknown): TesseraToolName | undefined {
  return typeof value === "string" && TESSERA_PUBLIC_TOOL_NAMES.has(value as TesseraToolName)
    ? value as TesseraToolName
    : undefined;
}

function asTesseraToolState(value: unknown): TesseraToolState | undefined {
  return typeof value === "string" && TESSERA_PUBLIC_TOOL_STATES.has(value as TesseraToolState)
    ? value as TesseraToolState
    : undefined;
}

function asTesseraStage(value: unknown): TesseraDataAgentStage | undefined {
  return typeof value === "string" && TESSERA_PUBLIC_STAGE_SET.has(value as TesseraDataAgentStage)
    ? value as TesseraDataAgentStage
    : undefined;
}

function asTesseraStageStatus(value: unknown): TesseraDataAgentStageStatus | undefined {
  return typeof value === "string" && TESSERA_PUBLIC_STAGE_STATUSES.has(value as TesseraDataAgentStageStatus)
    ? value as TesseraDataAgentStageStatus
    : undefined;
}

function publicFinishReason(value: unknown): FinishReason | undefined {
  return value === "stop"
    || value === "length"
    || value === "content-filter"
    || value === "tool-calls"
    || value === "error"
    || value === "other"
    ? value
    : undefined;
}

function sourceIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function boundedPublicText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function publicAssistantTextDeltas(
  value: unknown,
  id: string,
  state: TesseraPublicStreamState,
): readonly TesseraUIMessageChunk[] {
  const delta = boundedPublicText(value, 4_096);
  if (delta === undefined) return [];
  const buffered = `${state.pendingNarrations.get(id) ?? ""}${delta}`;
  if (!isSafeAssistantTextFragment(buffered) || buffered.length > MAX_PENDING_PUBLIC_NARRATION_CHARS) {
    state.unsafeNarration = true;
    return [{ type: "error", errorText: "The Tessera Agent returned an unsafe response." } as TesseraUIMessageChunk];
  }
  const holdbackStart = assistantTextHoldbackStart(buffered);
  if (holdbackStart === undefined) {
    state.pendingNarrations.delete(id);
    return buffered.length === 0
      ? []
      : publicAssistantTextDelta(id, redactOpaqueAssistantIdentifiers(buffered), state);
  }
  const safePrefix = buffered.slice(0, holdbackStart);
  const pending = buffered.slice(holdbackStart);
  if (pending.length > MAX_PENDING_PUBLIC_NARRATION_CHARS) {
    state.unsafeNarration = true;
    return [{ type: "error", errorText: "The Tessera Agent returned an unsafe response." } as TesseraUIMessageChunk];
  }
  state.pendingNarrations.set(id, pending);
  return safePrefix.length === 0
    ? []
    : publicAssistantTextDelta(id, redactOpaqueAssistantIdentifiers(safePrefix), state);
}

function flushPublicAssistantText(id: string, state: TesseraPublicStreamState): readonly TesseraUIMessageChunk[] {
  const pending = state.pendingNarrations.get(id);
  state.pendingNarrations.delete(id);
  return pending === undefined || pending.length === 0
    ? []
    : publicAssistantTextDelta(id, redactOpaqueAssistantIdentifiers(pending), state);
}

function flushAllPublicAssistantText(state: TesseraPublicStreamState): readonly TesseraUIMessageChunk[] {
  const chunks = [...state.pendingNarrations.keys()].flatMap((id) => flushPublicAssistantText(id, state));
  return chunks;
}

function publicAssistantTextDelta(
  id: string,
  delta: string,
  state: TesseraPublicStreamState,
): readonly TesseraUIMessageChunk[] {
  const start = state.startedNarrations.has(id)
    ? []
    : (() => {
      state.startedNarrations.add(id);
      return [{ type: "text-start", id } as TesseraUIMessageChunk];
    })();
  return [...start, { type: "text-delta", id, delta } as TesseraUIMessageChunk];
}

function boundedPublicInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : undefined;
}

function boundedPublicDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_PUBLIC_STAGE_DURATION_MS)
    : undefined;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function createAbortError(): DOMException {
  return new DOMException("The request was aborted.", "AbortError");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function reportError(reporter: StudioAppDependencies["reportError"], report: StudioErrorReport): void {
  try {
    reporter?.(report);
  } catch {
    // Error reporting must not replace a redacted API error response.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
