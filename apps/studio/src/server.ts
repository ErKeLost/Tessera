import {
  catalogStats,
  type CatalogIntrospectionOptions,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseQueryResult,
  type DatabaseTable,
  databaseActionSchema,
} from "@open-tessera/database";
import {
  createDataAgent,
  DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS,
  relationPlanningCatalogInputSchema,
  type DataAgent,
} from "@open-tessera/data-agent";
import {
  hasVisibleCopilotOutput,
  tesseraAgentEventSchema,
  tesseraAgentIdentitySchema,
  tesseraAgentRunSchema,
  type TesseraAgentDiagnostic,
  type TesseraAgentEvent,
  type TesseraAgentIdentity,
  type TesseraAgentImageInput,
  type TesseraAgentImageMediaType,
  type TesseraAgentRun,
  type TesseraAgentRunInput,
  type TesseraAgentTurnContext,
} from "@open-tessera/agent";
import { createMongoDbConnector } from "@open-tessera/mongodb";
import { createMySqlConnector } from "@open-tessera/mysql";
import { createPostgresConnector } from "@open-tessera/postgres";
import { createSqliteConnector } from "@open-tessera/sqlite";
import { createTursoConnector } from "@open-tessera/turso";
import type { OpenGenerativeAuthority } from "@open-generative/mastra";
import {
  hostCommandEnvelopeSchema,
  surfaceSessionIdSchema,
} from "@open-generative/protocol";
import {
  consumeStream,
  createUIMessageStream,
  createUIMessageStreamResponse,
  safeValidateUIMessages,
} from "ai";
import type { FinishReason } from "ai";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HTTPError } from "h3";
import { serve, type Server, type ServerRequest } from "srvx";
import { z } from "zod";
import { createTesseraStudioAgent, toMastraModelConfig } from "./agent";
import {
  createTesseraConfigFromDatabaseUrl,
  defineTesseraConfig,
  DEFAULT_TESSERA_STUDIO_PORT,
  isTesseraStudioUnconfigured,
  isTesseraLlmConfigured,
  normalizeOrigin,
  resolveTesseraLlmConfig,
  type TesseraConfig,
  type TesseraConfigInput,
  TesseraConfigError,
} from "./config";
import type {
  TesseraToolName,
  TesseraUIMessage,
  TesseraUIMessageChunk,
} from "./protocol";
import {
  LOCAL_STUDIO_IDENTITY,
  createTesseraSessionMemory,
  tesseraSessionResourceId,
  tesseraThreadTitleFromMessage,
  type TesseraSessionMemory,
} from "./session-memory";
import { createTesseraContinualHarness, type TesseraContinualHarness } from "./continual-harness";
import {
  assertTesseraOpenGenerativeRuntimeDeployment,
  createTesseraOpenGenerativeRuntimeBundle,
  createTesseraLocalSettingsStore,
  createTesseraStudioRuntimeManager,
  parseTesseraStudioSettingsCandidate,
  TesseraSettingsRuntimeError,
  type TesseraDatabaseAccessMode,
  type TesseraDatabasePermissionSettings,
  type TesseraOpenGenerativeHostFactory,
  type TesseraOpenGenerativeRuntimeBundle,
  type TesseraStudioRuntimeManager,
  type TesseraStudioRuntimeLease,
} from "./settings-runtime";
import type {
  OpenGenerativeInspectionRecord,
  TesseraOpenGenerativeInspectionReader,
} from "./generative/inspection";
import {
  createTesseraDatabaseActionService,
  type TesseraDatabaseActionEffect,
  type TesseraDatabaseActionService,
} from "./database-actions";
import { createTesseraDurableStateStore, type TesseraDurableStateStore } from "./durable-state";
import type { DurableStateStorePort } from "@open-tessera/runtime";
import {
  createOpenRouterModelCatalogProvider,
  type OpenRouterModelCatalogProvider,
} from "./openrouter-model-catalog";
import {
  createStudioConsoleLogger,
  publicStudioStreamError,
  safeStudioErrorDetails,
  silentStudioLogger,
  type StudioApiOperation,
  type StudioErrorPhase,
  type StudioLogEvent,
  type StudioLogLevel,
  type StudioLogger,
  type StudioStreamOutcome,
} from "./studio-logger";
import { StudioHttpApp, type StudioHttpContext } from "./studio-http";
import {
  resolveOpenGenerativeThemePreset,
  resolveOpenGenerativeThemePresetFromEnvironment,
  type OpenGenerativeThemePresetId,
} from "./open-generative-theme-preset";
import { createTesseraPresentationAuthority } from "./generative/presentation";

export type { StudioLogEvent, StudioLogger } from "./studio-logger";

const MAX_CHAT_MESSAGE_PARTS = 8;
const TESSERA_PUBLIC_TOOL_NAMES = new Set<TesseraToolName>([
  "list_database",
  "search_data_context",
  "execute_sql",
  "prepare_analysis",
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

const tablePreviewFilterSchema = z.object({
  column: z.string().min(1).max(256),
  operator: z.enum(["contains", "equals", "not_equals", "gt", "gte", "lt", "lte", "is_null", "is_not_null"]),
  value: z.string().max(2_000).default(""),
}).strict();

const tablePreviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(TABLE_PREVIEW_MAX_ROWS).default(TABLE_PREVIEW_MAX_ROWS),
  q: z.string().max(512).default(""),
  sort: z.string().max(256).optional(),
  direction: z.enum(["asc", "desc"]).default("asc"),
  filters: z.string().max(32_000).default("[]"),
}).strict();
const DEFAULT_STUDIO_CLIENT_ROOT = fileURLToPath(new URL("../dist/nitro/public", import.meta.url));
/** Bun defaults to 10 seconds; use its maximum global idle allowance for Studio HTTP requests. */
export const TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS = 255;
const STUDIO_CHAT_RETRY_TTL_MS = 10 * 60_000;
const MAX_STUDIO_CHAT_RETRIES = 256;

const runRequestSchema = z.object({
  message: z.string().trim().min(1).max(12_000),
  threadId: z.string().trim().min(1).max(128).optional(),
}).strict();

/**
 * Browser page state is only a navigation hint. The selected relation is
 * re-bound against the live catalog below before it can influence a turn.
 * Local filter text is intentionally reduced to a boolean and never reaches
 * the Agent, its memory, or a database predicate.
 */
const chatWorkspaceContextPayloadSchema = z.object({
  currentRelation: relationPlanningCatalogInputSchema.optional(),
  hasLocalFilter: z.boolean().optional(),
  view: z.enum(["data", "definition"]).optional(),
}).strict();

const createThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
}).strict();

const renameThreadRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
}).strict();

const threadIdSchema = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

const agentRunSchema = tesseraAgentRunSchema;
const studioAgentEventSchema = tesseraAgentEventSchema;

const databaseActionSubmitRequestSchema = z.object({
  action: databaseActionSchema,
  purpose: z.string().trim().min(1).max(1_000),
  requireApproval: z.boolean().optional(),
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

const chatResumeRequestSchema = z.object({
  threadId: threadIdSchema,
  runId: z.string().trim().min(1).max(256),
  toolCallId: z.string().trim().min(1).max(256),
  decision: z.enum(["approve", "reject"]),
  requestId: z.string().trim().min(1).max(512),
  checkpointId: z.string().trim().min(1).max(512),
}).strict();

const databaseActionCancelRequestSchema = z.object({
  cancelRequestId: z.string().trim().min(1).max(256).optional(),
}).strict();

const databaseActionRequestIdSchema = z.string().trim().min(1).max(256).refine(
  (value) => !/[\u0000-\u001f\u007f/]/.test(value),
);

type StudioChatTrigger = "submit-message" | "regenerate-message";
export type StudioImageInput = TesseraAgentImageInput;
type StudioChatWorkspaceContext = Readonly<{
  currentRelation?: z.output<typeof relationPlanningCatalogInputSchema>;
  hasLocalFilter: boolean;
  view?: "data" | "definition";
}>;
type StudioChatRequest = z.infer<typeof runRequestSchema> & Readonly<{
  trigger: StudioChatTrigger;
  messageId?: string;
  images: readonly StudioImageInput[];
  workspaceContext?: StudioChatWorkspaceContext;
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
type StudioContext = StudioHttpContext<StudioEnv["Variables"]>;
type StudioApp = StudioHttpApp<StudioEnv["Variables"]>;

type StudioErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 502 | 503;

type StudioApiRequestLog = Readonly<{
  requestId: string;
  method: string;
  operation: StudioApiOperation;
  startedAt: number;
}>;

const studioIdentitySchema = tesseraAgentIdentitySchema;

export type StudioIdentity = TesseraAgentIdentity;
export type StudioAuthenticationInput = Readonly<{
  request: Request;
  requestId: string;
}>;
/** The host owns authentication and tenant membership; Tessera never parses credentials itself. */
export type StudioAuthenticator = (
  input: StudioAuthenticationInput,
) => StudioIdentity | undefined | Promise<StudioIdentity | undefined>;

/** Settings can contain credentials and can enable the database write surface. */
export type StudioSettingsChangeKind = "settings" | "test" | "access-mode" | "database-permissions" | "reset";
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

/**
 * This is server-only turn state. It is constructed after validating a browser
 * navigation hint against the live catalog; physical relation coordinates never
 * cross this boundary into Mastra or the browser stream.
 */
export type StudioAgentTurnContext = TesseraAgentTurnContext;

export type StudioAgentRunInput = TesseraAgentRunInput & Readonly<{
  /**
   * Legacy Studio Agents receive a server-loaded catalog. Tessera's governed
   * Data Agent owns this lookup itself so its visible catalog stage remains
   * the source of truth for a chat run.
   */
  catalog?: DatabaseCatalog;
}>;

export type StudioAgentDiagnostic = TesseraAgentDiagnostic;
export type StudioAgentRun = TesseraAgentRun;
export type StudioAgentEvent = TesseraAgentEvent;

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
  /** Server-only adaptive memory owned by this Agent implementation. */
  continualHarness?: TesseraContinualHarness;
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
  /** Public presentation-only preset. It never enters Agent or memory state. */
  openGenerativeThemePreset?: OpenGenerativeThemePresetId;
  /** Same-generation Host and Inspector side channel. */
  openGenerativeRuntime?: TesseraOpenGenerativeRuntimeBundle;
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
  openGenerativeRuntime?: TesseraOpenGenerativeRuntimeBundle;
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

export type CreateTesseraStudioRuntimeOptions = Omit<
  StudioAppDependencies,
  "connector" | "catalogProvider" | "openGenerativeRuntime" | "allowedOrigins" | "requireAuthentication"
> & Readonly<{
  connector?: DatabaseConnector;
  catalogProvider?: StudioCatalogProvider;
  /** Optional shared governed Data Agent. When omitted, runtime creates one. */
  dataAgent?: DataAgent;
  /** Shared durable state used by the default governed mutation service. */
  databaseState?: DurableStateStorePort;
  /** Static runtimes expose mutation actions only when the embedding host opts in. */
  accessMode?: TesseraDatabaseAccessMode;
  /** Creates one owned Host/Inspector generation. */
  openGenerativeHostFactory?: TesseraOpenGenerativeHostFactory;
  /** False disables continual refinement; an instance lets embedded hosts own it. */
  continualHarness?: TesseraContinualHarness | false;
}>;

export type TesseraStudioRuntime = Readonly<{
  app: StudioApp;
  connector: DatabaseConnector;
  dataAgent: DataAgent;
  openGenerativeRuntime?: TesseraOpenGenerativeRuntimeBundle;
  databaseActions?: TesseraDatabaseActionService;
  close(): Promise<void>;
}>;

export type TesseraStudioServer = Readonly<{
  app: StudioApp;
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
export function createStudioApp(dependencies: StudioAppDependencies): StudioApp {
  if (dependencies.settingsRuntime !== undefined && dependencies.openGenerativeRuntime !== undefined) {
    throw new TypeError("A managed Studio must source Open Generative runtime capabilities from its leased generation.");
  }
  const app = new StudioHttpApp<StudioEnv["Variables"]>();
  const logger = dependencies.logger ?? silentStudioLogger;
  const chatRetries = createStudioChatRetryRegistry();
  const modelCatalog = dependencies.modelCatalog ?? createOpenRouterModelCatalogProvider();
  const openGenerativeThemePreset = dependencies.openGenerativeThemePreset === undefined
    ? resolveOpenGenerativeThemePresetFromEnvironment(process.env)
    : resolveOpenGenerativeThemePreset(dependencies.openGenerativeThemePreset);
  const dataAgent = dependencies.dataAgent ?? createDataAgent({ connector: dependencies.connector });
  const catalogProvider = dependencies.catalogProvider ?? createDataAgentCatalogProvider(dataAgent);
  const staticRuntime: StudioRouteRuntime = Object.freeze({
    connector: dependencies.connector,
    dataAgent,
    catalogProvider,
    ...(dependencies.openGenerativeRuntime === undefined
      ? {}
      : { openGenerativeRuntime: dependencies.openGenerativeRuntime }),
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
    if (context.req.method !== "OPTIONS") {
      if (dependencies.requireAuthentication || dependencies.authenticate) {
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
      } else {
        context.set("identity", LOCAL_STUDIO_IDENTITY);
      }
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
    const hostDeployment = runtime.openGenerativeRuntime === undefined
      ? null
      : runtime.openGenerativeRuntime.host.deployment;
    return context.json({
      protocolVersion: 1,
      capabilities: {
        chat: agentAvailable,
      },
      generativeUi: {
        themePreset: openGenerativeThemePreset,
        inspectorEnabled: runtime.openGenerativeRuntime?.inspectionReader !== undefined,
        hostDeployment,
      },
    });
  }));

  app.get("/api/open-generative/inspections/:surfaceSessionId", async (context) => (
    withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
      const reader = runtime.openGenerativeRuntime?.inspectionReader;
      if (reader === undefined) throw inspectionNotFoundError();

      const parsedSurfaceSessionId = surfaceSessionIdSchema.safeParse(context.req.param("surfaceSessionId"));
      if (!parsedSurfaceSessionId.success) {
        throw new StudioHttpError(
          400,
          "invalid_surface_session_id",
          "The Surface session identifier is invalid.",
        );
      }
      const identity = context.get("identity");
      if (!identity) {
        throw new StudioHttpError(
          401,
          "authentication_required",
          "An authenticated session is required.",
        );
      }

      const authority = createTesseraPresentationAuthority(identity);
      const record = await reader.read({
        surfaceSessionId: parsedSurfaceSessionId.data,
        authority,
      });
      if (!isInspectionRecordInScope(record, parsedSurfaceSessionId.data, authority)) {
        throw inspectionNotFoundError();
      }
      return context.json(record);
    })
  ));

  app.post("/api/open-generative/commands", async (context) => (
    withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
      if (runtime.openGenerativeRuntime === undefined) {
        throw new StudioHttpError(
          503,
          "generative_ui_unavailable",
          "Interactive generative UI is not enabled for this Studio runtime.",
        );
      }
      const identity = context.get("identity");
      if (!identity) {
        throw new StudioHttpError(401, "authentication_required", "A Surface command requires an authenticated session.");
      }
      const command = hostCommandEnvelopeSchema.safeParse(await readJsonBody(context.req.raw));
      if (!command.success) {
        throw new StudioHttpError(400, "invalid_surface_command", "The Surface command is invalid.");
      }
      try {
        const host = runtime.openGenerativeRuntime.host;
        return context.json(await host.handleCommand(
          command.data,
          createTesseraPresentationAuthority(identity),
          {
            operationScope: "tessera.surface.command",
            locale: "en-US",
            timezone: "Asia/Shanghai",
          },
        ));
      } catch (error) {
        throw surfaceCommandHttpError(error);
      }
    })
  ));

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

  app.post("/api/settings/reset", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    try {
      await authorizeSettingsChange(context, dependencies, "reset");
      const settings = await runtime.reset();
      return context.json({
        settings,
        message: "Local settings reset. Database data was not changed.",
      });
    } catch (error) {
      throw settingsRuntimeHttpError(error);
    }
  });

  app.post("/api/settings/test", async (context) => {
    const runtime = requireSettingsRuntime(dependencies.settingsRuntime);
    const candidate = await readJsonBody(context.req.raw);
    try {
      const parsedCandidate = parseTesseraStudioSettingsCandidate(candidate);
      await authorizeSettingsChange(context, dependencies, "test");
      await validateStudioReasoningSelection(parsedCandidate, modelCatalog);
      const target = context.req.query("target");
      if (target === "model") {
        const result = await runtime.testModel(parsedCandidate, { signal: context.req.raw.signal });
        return context.json({
          settings: result.settings,
          model: result.model,
          message: "OpenRouter returned a valid model response.",
        });
      }
      const result = await runtime.test(parsedCandidate, { signal: context.req.raw.signal });
      return context.json({
        settings: result.settings,
        connection: result.connection,
        message: result.connection.connected
          ? "Database connection verified."
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
      const current = runtime.getSnapshot();
      const databaseChanged = parsedCandidate.database.url !== undefined
        || parsedCandidate.database.dialect !== current.database.dialect
        || parsedCandidate.database.accessMode !== current.database.accessMode;
      const settings = await runtime.replace(parsedCandidate, {
        signal: context.req.raw.signal,
        verifyConnection: databaseChanged,
      });
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
   * this transport never accepts raw mutation SQL. It can return the exact
   * server-compiled statement to the authorized actor for review.
   */
  app.get("/api/database-actions/capabilities", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = runtime.databaseActions;
    if (service === undefined) {
      return context.json({ grantSetVersion: 0, capabilities: [], messageTemplates: [] });
    }
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
        ...(parsed.data.requireApproval === undefined ? {} : { requireApproval: parsed.data.requireApproval }),
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

  app.post("/api/database-actions/:requestId/retry", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const service = requireDatabaseActionService(runtime.databaseActions);
    const requestId = parseDatabaseActionRequestId(context.req.param("requestId"));
    try {
      return databaseActionEffectResponse(context, await service.retry({
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

  app.delete("/api/threads", async (context) => withStudioRouteRuntime(dependencies, staticRuntime, async (runtime) => {
    const memory = requireSessionMemory(runtime.sessionMemory);
    const resourceId = resourceIdForContext(context);
    const deletedThreadIds = await memory.clearThreads({ resourceId });
    chatRetries.clearResource({ resourceId });
    return context.json({ deletedCount: deletedThreadIds.length });
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

    const rawQuery = context.req.query();
    const hasTableQuery = Object.keys(rawQuery).length > 0;
    const dialect = catalog.dialect;
    const quote = (identifier: string) => quoteTableEditorIdentifier(dialect, identifier);
    const relationSql = `${quote(table.schema)}.${quote(table.name)}`;
    if (!hasTableQuery) {
      let result: DatabaseQueryResult;
      let countResult: DatabaseQueryResult;
      try {
        const previewRequest = dialect !== "mongodb" && previewColumns.some((column) => isJsonDataType(column.dataType))
          ? runtime.connector.query({
            sql: `SELECT ${previewColumns.map((column) => tablePreviewSelectExpression(dialect, column, quote)).join(", ")} FROM ${relationSql} LIMIT ${TABLE_PREVIEW_MAX_ROWS}`,
            parameters: [],
            purpose: "Tessera relation preview",
            maxRows: TABLE_PREVIEW_MAX_ROWS,
          }, context.req.raw.signal)
          : runtime.dataAgent.previewRelation({
            schema: table.schema,
            table: table.name,
            columns: previewColumns.map((column) => column.name),
            refresh: false,
          }, context.req.raw.signal).then(({ result }) => result);
        [result, countResult] = await Promise.all([
          previewRequest,
          runtime.connector.query(dialect === "mongodb"
            ? {
              kind: "mongodb",
              database: table.schema,
              collection: table.name,
              pipeline: [{ $count: "__total_count" }],
              columns: ["__total_count"],
              purpose: "Tessera table editor row count",
              maxRows: 1,
            }
            : {
              sql: `SELECT COUNT(*) AS ${quote("__total_count")} FROM ${relationSql}`,
              parameters: [],
              purpose: "Tessera table editor row count",
              maxRows: 1,
            }, context.req.raw.signal),
        ]);
      } catch {
        throw new StudioHttpError(503, "table_preview_unavailable", "Tessera could not load a preview for the selected table.");
      }
      return context.json(publicTablePreview(table, previewColumns, result, {
        dialect,
        totalRowCount: parseCountValue(countResult.rows[0]?.__total_count) ?? result.rowCount,
        definition: buildTableDefinition(catalog.dialect, table),
        page: 1,
        pageSize: TABLE_PREVIEW_MAX_ROWS,
      }));
    }
    const query = parseTablePreviewQuery(rawQuery, previewColumns);
    if (dialect === "mongodb") {
      const match = buildMongoTablePreviewMatch(query, previewColumns);
      const countPipeline: Array<Record<string, unknown>> = [
        ...(match === undefined ? [] : [{ $match: { $expr: match } }]),
        { $count: "__total_count" },
      ];
      const selectPipeline: Array<Record<string, unknown>> = [
        ...(match === undefined ? [] : [{ $match: { $expr: match } }]),
        ...(query.sort ? [{ $sort: { [query.sort]: query.direction === "desc" ? -1 : 1 } }] : []),
        { $skip: (query.page - 1) * query.pageSize },
        { $project: {
          _id: 0,
          ...Object.fromEntries(previewColumns.map((column) => [column.name, `$${column.name}`])),
        } },
        { $limit: query.pageSize },
      ];
      try {
        const [countResult, result] = await Promise.all([
          runtime.connector.query({
            kind: "mongodb",
            database: table.schema,
            collection: table.name,
            pipeline: countPipeline,
            columns: ["__total_count"],
            purpose: "Tessera table editor row count",
            maxRows: 1,
          }, context.req.raw.signal),
          runtime.connector.query({
            kind: "mongodb",
            database: table.schema,
            collection: table.name,
            pipeline: selectPipeline,
            columns: previewColumns.map((column) => column.name),
            purpose: "Tessera table editor preview",
            maxRows: query.pageSize,
          }, context.req.raw.signal),
        ]);
        return context.json(publicTablePreview(table, previewColumns, result, {
          dialect,
          totalRowCount: parseCountValue(countResult.rows[0]?.__total_count) ?? 0,
          definition: buildTableDefinition(dialect, table),
          page: query.page,
          pageSize: query.pageSize,
        }));
      } catch {
        throw new StudioHttpError(503, "table_preview_unavailable", "Tessera could not load a preview for the selected table.");
      }
    }
    const parameters: Array<string | number | boolean> = [];
    const placeholder = () => dialect === "postgres" ? `$${parameters.length + 1}` : "?";
    const whereParts: string[] = [];

    if (query.search) {
      const searchPlaceholder = () => {
        const token = placeholder();
        parameters.push(`%${query.search}%`);
        return token;
      };
      const searchParts = previewColumns.map((column) => (
        dialect === "postgres"
          ? `CAST(${quote(column.name)} AS text) ILIKE ${searchPlaceholder()}`
          : `CAST(${quote(column.name)} AS CHAR) LIKE ${searchPlaceholder()}`
      ));
      if (searchParts.length) whereParts.push(`(${searchParts.join(" OR ")})`);
    }

    for (const filter of query.filters) {
      const column = previewColumns.find((candidate) => candidate.name === filter.column);
      if (!column) continue;
      const identifier = quote(column.name);
      if (filter.operator === "is_null") {
        whereParts.push(`${identifier} IS NULL`);
        continue;
      }
      if (filter.operator === "is_not_null") {
        whereParts.push(`${identifier} IS NOT NULL`);
        continue;
      }
      const token = placeholder();
      parameters.push(filter.operator === "contains"
        ? `%${filter.value}%`
        : coercePreviewParameter(filter.value, column.dataType));
      if (filter.operator === "contains") {
        whereParts.push(`${dialect === "postgres" ? `CAST(${identifier} AS text) ILIKE ${token}` : `CAST(${identifier} AS CHAR) LIKE ${token}`}`);
      } else {
        const operator = filter.operator === "equals" ? "="
          : filter.operator === "not_equals" ? "<>"
            : filter.operator === "gt" ? ">"
              : filter.operator === "gte" ? ">="
                : filter.operator === "lt" ? "<" : "<=";
        whereParts.push(`${identifier} ${operator} ${token}`);
      }
    }

    const whereSql = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const countSql = `SELECT COUNT(*) AS ${quote("__total_count")} FROM ${relationSql}${whereSql}`;
    const nullOrdering = dialect === "postgres" ? ` NULLS ${query.direction === "desc" ? "FIRST" : "LAST"}` : "";
    const selectSql = `SELECT ${previewColumns.map((column) => tablePreviewSelectExpression(dialect, column, quote)).join(", ")} FROM ${relationSql}${whereSql}`
      + (query.sort ? ` ORDER BY ${quote(query.sort)} ${query.direction === "desc" ? "DESC" : "ASC"}${nullOrdering}` : "")
      + ` LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

    let result: DatabaseQueryResult;
    let countResult: DatabaseQueryResult;
    try {
      countResult = await runtime.connector.query({
        sql: countSql,
        parameters,
        purpose: "Tessera table editor row count",
        maxRows: 1,
      }, context.req.raw.signal);
      result = await runtime.connector.query({
        sql: selectSql,
        parameters,
        purpose: "Tessera table editor preview",
        maxRows: query.pageSize,
      }, context.req.raw.signal);
    } catch {
      throw new StudioHttpError(503, "table_preview_unavailable", "Tessera could not load a preview for the selected table.");
    }

    const totalRowCount = parseCountValue(countResult.rows[0]?.__total_count) ?? 0;
    return context.json(publicTablePreview(table, previewColumns, result, {
      dialect,
      totalRowCount,
      definition: buildTableDefinition(catalog.dialect, table),
      page: query.page,
      pageSize: query.pageSize,
    }));
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
    } catch (error) {
      const diagnostic = safeStreamDiagnostic(publicStudioStreamError(error).phase, error);
      logAgentEvent(logger, "error", context.get("apiRequest"), runId, {
        stage: "run_failed",
        code: "agent_run_failed",
        durationMs: elapsedMilliseconds(agentStartedAt),
        ...diagnostic,
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
            id: `user-message-${runId}`,
            role: "user",
            parts: [{ type: "text", text: message }],
          } satisfies TesseraUIMessage],
        });
      }
      const turnContext = runtime.agent.catalogLoading === "data-agent"
        ? await bindStudioAgentTurnContext({
          dataAgent: runtime.dataAgent,
          workspaceContext: request.workspaceContext,
          signal: context.req.raw.signal,
        })
        : undefined;
      const catalog = await catalogForStudioAgent({
        agent: runtime.agent,
        catalogProvider: runtime.catalogProvider,
        signal: context.req.raw.signal,
        request: context.get("apiRequest"),
        runId,
        logger,
      });

      const streamDiagnostics = createStudioStreamDiagnosticCollector();
      const agentInput: StudioAgentRunInput = {
        runId,
        threadId,
        message,
        ...(request.images.length === 0 ? {} : { images: request.images }),
        ...(catalog === undefined ? {} : { catalog: catalogForAgent(catalog) }),
        ...(turnContext === undefined ? {} : { turnContext }),
        signal: context.req.raw.signal,
        reportDiagnostic: streamDiagnostics.capture,
        ...(context.get("identity") === undefined ? {} : { identity: context.get("identity") }),
      };

      const source = runtime.agent.streamUI?.(agentInput)
        ?? streamLegacyAgentToUI(runtime.agent, agentInput);
      const durableSource = createUIMessageStream<TesseraUIMessage>({
        execute: ({ writer }) => writer.merge(source),
        onError: () => "The Tessera Agent stream could not be processed.",
        onStepEnd: async ({ responseMessage }) => {
          await checkpointStudioUiMessage(runtime.sessionMemory, {
            id: threadId,
            resourceId: sessionResourceId,
            checkpointId: runId,
            message: responseMessage,
          });
        },
        onEnd: async ({ responseMessage, isAborted, finishReason }) => {
          // Mastra owns the durable run snapshot for suspended tools. The UI
          // transcript is only a browser-safe projection of completed steps.
          if (hasSuspendedToolCall(responseMessage)) return;
          if (isAborted || finishReason !== "stop" || !hasVisibleCopilotOutput(responseMessage)) {
            chatRetries.mark({
              resourceId: sessionResourceId,
              threadId,
              messageId: responseMessage.id,
              message,
            });
            return;
          }
          await checkpointStudioUiMessage(runtime.sessionMemory, {
            id: threadId,
            resourceId: sessionResourceId,
            checkpointId: runId,
            message: responseMessage,
          });
          runtime.agent?.continualHarness?.submitCompletedTurn({
            runId,
            resourceId: sessionResourceId,
            threadId,
            userText: message,
            assistantMessage: responseMessage,
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
        diagnostics: streamDiagnostics,
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
        withStudioStreamLogging(response, context.get("apiRequest"), logger, stream.snapshot, {
          runId,
          startedAt: streamStartedAt,
          diagnostics: streamDiagnostics,
        }),
        lease,
      );
    } catch (error) {
      await releaseStudioRouteLease(lease);
      throw error;
    }
  });

  /** Resumes the same Mastra run after a mutation approval decision. */
  app.post("/api/chat/resume", async (context) => {
    const lease = acquireStudioRouteRuntime(dependencies, staticRuntime);
    try {
      const runtime = lease.runtime;
      if (!runtime.agent?.streamUI) {
        throw new StudioHttpError(503, "agent_unavailable", "The Tessera Agent is not configured for this Studio.");
      }
      const parsed = chatResumeRequestSchema.safeParse(await readJsonBody(context.req.raw));
      if (!parsed.success) throw new StudioHttpError(400, "invalid_chat_resume", "The chat resume request is invalid.");
      const memory = requireSessionMemory(runtime.sessionMemory);
      const thread = await memory.getThread({ id: parsed.data.threadId, resourceId: resourceIdForContext(context) });
      if (!thread) throw new StudioHttpError(404, "thread_not_found", "The requested session is not available.");
      const messages = await memory.readMessages({ id: parsed.data.threadId, resourceId: resourceIdForContext(context) });
      const userMessage = [...(messages ?? [])].reverse().find((message) => message.role === "user");
      const message = userMessage?.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!message) throw new StudioHttpError(400, "invalid_chat_resume", "The suspended user request is no longer available.");

      const streamDiagnostics = createStudioStreamDiagnosticCollector();
      const source = runtime.agent.streamUI({
        runId: parsed.data.runId,
        toolCallId: parsed.data.toolCallId,
        threadId: parsed.data.threadId,
        message,
        resumeData: {
          decision: parsed.data.decision,
          requestId: parsed.data.requestId,
          checkpointId: parsed.data.checkpointId,
        },
        signal: context.req.raw.signal,
        reportDiagnostic: streamDiagnostics.capture,
        ...(context.get("identity") === undefined ? {} : { identity: context.get("identity") }),
      });
      const durableSource = createUIMessageStream<TesseraUIMessage>({
        execute: ({ writer }) => writer.merge(source),
        onError: () => "The Tessera Agent stream could not be processed.",
        onStepEnd: async ({ responseMessage }) => {
          await checkpointStudioUiMessage(runtime.sessionMemory, {
            id: parsed.data.threadId,
            resourceId: resourceIdForContext(context),
            checkpointId: parsed.data.runId,
            message: responseMessage,
          });
        },
        onEnd: async ({ responseMessage, isAborted, finishReason }) => {
          if (hasSuspendedToolCall(responseMessage) || isAborted || finishReason !== "stop"
            || !hasVisibleCopilotOutput(responseMessage)) return;
          await checkpointStudioUiMessage(runtime.sessionMemory, {
            id: parsed.data.threadId,
            resourceId: resourceIdForContext(context),
            checkpointId: parsed.data.runId,
            message: responseMessage,
          });
          runtime.agent?.continualHarness?.submitCompletedTurn({
            runId: parsed.data.runId,
            resourceId: resourceIdForContext(context),
            threadId: parsed.data.threadId,
            userText: message,
            assistantMessage: responseMessage,
          });
        },
      });
      const streamStartedAt = performance.now();
      const stream = monitorStudioChatStream(durableSource, {
        request: context.get("apiRequest"),
        runId: parsed.data.runId,
        startedAt: streamStartedAt,
        logger,
        diagnostics: streamDiagnostics,
      });
      const response = createUIMessageStreamResponse({
        stream: stream.source,
        consumeSseStream: consumeStream,
        headers: { "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
      });
      context.set("deferApiResponseLog", true);
      return withStudioStreamLease(
        withStudioStreamLogging(response, context.get("apiRequest"), logger, stream.snapshot, {
          runId: parsed.data.runId,
          startedAt: streamStartedAt,
          diagnostics: streamDiagnostics,
        }),
        lease,
      );
    } catch (error) {
      await releaseStudioRouteLease(lease);
      throw error;
    }
  });

  // AI SDK's reconnect transport uses GET. Keep the decision payload in the
  // query string and route it through the same guarded POST implementation.
  app.get("/api/chat/resume", async (context) => {
    const query = context.req.query();
    const payload = {
      threadId: query.threadId,
      runId: query.runId,
      toolCallId: query.toolCallId,
      decision: query.decision,
      requestId: query.requestId,
      checkpointId: query.checkpointId,
    };
    const headers = new Headers(context.req.raw.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    const request = new Request(context.req.raw.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    return app.fetch(request);
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
    logStudioError(context, logger, 500, "internal_error", error);
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
      ...(lease.runtime.openGenerativeRuntime === undefined
        ? {}
        : { openGenerativeRuntime: lease.runtime.openGenerativeRuntime }),
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
  context: StudioContext,
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
    case "model_unavailable":
      return new StudioHttpError(503, "model_unavailable", "Tessera could not verify the selected model and credentials.");
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
 * policy while preserving the small provider contract used by HTTP routes.
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
export async function createTesseraStudioRuntime(
  config: TesseraConfig,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioRuntime> {
  const logger = options.logger ?? createStudioConsoleLogger();
  if (config.studio.requireAuthentication && options.authenticate === undefined) {
    throw new TesseraConfigError(
      "A Tessera Studio with studio.requireAuthentication enabled requires a host-provided authenticate adapter.",
    );
  }
  if (options.settingsRuntime !== undefined && options.openGenerativeHostFactory !== undefined) {
    throw new TypeError("A managed Studio owns its Open Generative Host factory through the runtime manager.");
  }

  if (options.settingsRuntime) {
    const lease = options.settingsRuntime.acquire();
    try {
      const runtime = lease.runtime;
      assertTesseraOpenGenerativeRuntimeDeployment(config, runtime.openGenerativeRuntime);
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
        ...(options.openGenerativeThemePreset === undefined
          ? {}
          : { openGenerativeThemePreset: options.openGenerativeThemePreset }),
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
      await lease.release();
    }
  }

  const ownsConnector = options.connector === undefined;
  const connector = options.connector ?? createTesseraDatabaseConnector(config);
  if (connector.dialect !== config.database.dialect) {
    throw new TypeError("The injected Tessera database connector does not match the configured dialect.");
  }
  let sessionMemory: TesseraSessionMemory | undefined;
  let openGenerativeRuntime: TesseraOpenGenerativeRuntimeBundle | undefined;
  let continualHarness: TesseraContinualHarness | undefined;
  try {
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
    sessionMemory = createTesseraSessionMemory();
    const llm = isTesseraLlmConfigured(config) ? resolveTesseraLlmConfig(config) : undefined;
    const accessMode = options.accessMode ?? "read-only";
    if (
      options.openGenerativeHostFactory !== undefined
      || llm !== undefined
      || config.studio.generativeUi.hostMode === "production"
    ) {
      openGenerativeRuntime = await createTesseraOpenGenerativeRuntimeBundle({
        config,
        connector,
        dataAgent,
        accessMode,
        ...(options.databaseState === undefined ? {} : { databaseState: options.databaseState }),
      }, options.openGenerativeHostFactory);
    }
    assertTesseraOpenGenerativeRuntimeDeployment(config, openGenerativeRuntime);

    continualHarness = options.continualHarness === false
      ? undefined
      : options.continualHarness ?? (options.agent !== undefined || llm === undefined || !config.studio.continualHarness.enabled
        ? undefined
        : createTesseraContinualHarness({
          memory: sessionMemory.memory,
          model: toMastraModelConfig(llm),
          maxRetries: llm.maxRetries,
          maxOutputTokens: Math.min(llm.maxOutputTokens, 4_096),
          autoReviewInterval: config.studio.continualHarness.autoReviewInterval,
          autoReviewCooldownMs: config.studio.continualHarness.autoReviewCooldownMs,
        }));
    const databaseActions = accessMode !== "read-write"
      || config.database.dialect === "mongodb"
      || config.database.dialect === "sqlite"
      || config.database.dialect === "turso"
      ? undefined
      : options.databaseActions ?? (options.databaseState === undefined
        ? undefined
        : createTesseraDatabaseActionService({
          connector,
          state: options.databaseState,
          policy: config.database.permissions,
          getCatalog: async (signal) => (await dataAgent.inspectCatalog({ refresh: true }, signal)).catalog,
        }));
    const agent = options.agent ?? (llm === undefined
      ? undefined
      : createTesseraStudioAgent({
        dataAgent,
        databaseDialect: config.database.dialect,
        memory: sessionMemory.memory,
        llm,
        ...(openGenerativeRuntime === undefined
          ? {}
          : { openGenerativeHost: openGenerativeRuntime.host }),
        ...(continualHarness === undefined ? {} : { continualHarness }),
        ...(databaseActions === undefined ? {} : { databaseActions }),
        permissionContext: {
          accessMode,
          databaseActionsAvailable: databaseActions !== undefined,
          sqlStatements: config.database.permissions.sqlStatements,
        },
      }));
    const app = createStudioApp({
      connector,
      dataAgent,
      catalogProvider,
      ...(agent === undefined ? {} : { agent }),
      sessionMemory,
      ...(openGenerativeRuntime === undefined ? {} : { openGenerativeRuntime }),
      ...(databaseActions === undefined ? {} : { databaseActions }),
      ...(options.openGenerativeThemePreset === undefined
        ? {}
        : { openGenerativeThemePreset: options.openGenerativeThemePreset }),
      allowedOrigins: config.studio.allowedOrigins,
      authenticate: options.authenticate,
      requireAuthentication: config.studio.requireAuthentication,
      authorizeSettingsChange: options.authorizeSettingsChange,
      reportError: options.reportError,
      logger,
    });

    let closeTask: Promise<void> | undefined;
    return {
      app,
      connector,
      dataAgent,
      ...(openGenerativeRuntime === undefined ? {} : { openGenerativeRuntime }),
      ...(databaseActions === undefined ? {} : { databaseActions }),
      close() {
        closeTask ??= Promise.allSettled([
          agent?.continualHarness?.close(),
          openGenerativeRuntime?.close(),
          sessionMemory?.close(),
          ownsConnector ? connector.close() : undefined,
        ]).then(() => undefined);
        return closeTask;
      },
    };
  } catch (error) {
    await Promise.allSettled([
      continualHarness?.close(),
      openGenerativeRuntime?.close(),
      sessionMemory?.close(),
      ownsConnector ? connector.close() : undefined,
    ]);
    throw error;
  }
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
  if (config.database.dialect === "sqlite") {
    return createSqliteConnector(options);
  }
  if (config.database.dialect === "turso") {
    return createTursoConnector({
      ...options,
      authToken: config.database.authToken ?? process.env.TURSO_AUTH_TOKEN,
    });
  }
  if (config.database.dialect === "mongodb") {
    return createMongoDbConnector(options);
  }
  if (config.database.dialect === "mysql") {
    return createMySqlConnector(options);
  }
  return createPostgresConnector({
    ...options,
    applicationName: "tessera-studio",
  });
}

/**
 * Creates the managed Studio application without binding a network listener.
 * Nitro deployments and the standalone CLI share this lifecycle boundary.
 */
export async function createTesseraStudioService(
  config: TesseraConfig,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioRuntime> {
  if (options.settingsRuntime !== undefined && options.openGenerativeHostFactory !== undefined) {
    throw new TypeError("Specify either a managed Studio runtime or its Open Generative Host factory, not both.");
  }
  let settingsRuntime = options.settingsRuntime;
  let durableState: TesseraDurableStateStore | undefined;
  let runtime: TesseraStudioRuntime | undefined;
  try {
    if (!settingsRuntime) {
      durableState = createTesseraDurableStateStore();
      settingsRuntime = await createTesseraStudioRuntimeManager({
        config,
        initiallyUnconfigured: isTesseraStudioUnconfigured(config),
        store: createTesseraLocalSettingsStore(),
        databaseState: durableState.state,
        ...(options.openGenerativeHostFactory === undefined
          ? {}
          : { openGenerativeHostFactory: options.openGenerativeHostFactory }),
      });
    }
    const { openGenerativeHostFactory: _managedFactory, ...runtimeOptions } = options;
    void _managedFactory;
    runtime = await createTesseraStudioRuntime(config, { ...runtimeOptions, settingsRuntime });
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    if (!runtime && options.settingsRuntime === undefined) {
      await settingsRuntime?.close().catch(() => undefined);
    }
    await durableState?.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    ...runtime,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await runtime.close();
      } finally {
        await durableState?.close();
      }
    },
  };
}

export async function startTesseraStudioServer(
  config: TesseraConfig,
  options: CreateTesseraStudioRuntimeOptions = {},
): Promise<TesseraStudioServer> {
  const startedAt = performance.now();
  const logger = options.logger ?? createStudioConsoleLogger();
  let runtime: TesseraStudioRuntime | undefined;
  let server: StudioListeningServer | undefined;
  try {
    runtime = await createTesseraStudioService(config, { ...options, logger });
    const fetch = createStudioFetchHandler(runtime.app);
    try {
      server = await startStudioListeningServer(
        config.studio.host,
        config.studio.port,
        fetch,
      );
    } catch (error) {
      // A second local Studio should still open the empty/settings workspace.
      // Only the conventional default port falls back; an explicit port keeps
      // its strict failure semantics so deployment mistakes remain visible.
      if (!isAddressInUseError(error) || config.studio.port !== DEFAULT_TESSERA_STUDIO_PORT) throw error;
      server = await startStudioListeningServer(config.studio.host, 0, fetch);
    }
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
      await server.stop();
      await runtime.close();
      writeStudioLog(logger, "info", {
        event: "shutdown",
        stage: "stopped",
        durationMs: elapsedMilliseconds(shutdownAt),
      });
    },
  };
}

type StudioListeningServer = Readonly<{
  port: number;
  stop(): Promise<void>;
}>;

type StudioFetch = (request: Request) => Response | Promise<Response>;

async function startStudioListeningServer(
  hostname: string,
  port: number,
  fetch: StudioFetch,
): Promise<StudioListeningServer> {
  const server: Server = serve({
    fetch,
    hostname,
    port,
    silent: true,
    gracefulShutdown: false,
    bun: { idleTimeout: TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS },
  });
  await server.ready();
  const nodeServer = server.node?.server;
  if (nodeServer && "keepAliveTimeout" in nodeServer && "requestTimeout" in nodeServer) {
    nodeServer.keepAliveTimeout = TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS * 1_000;
    nodeServer.requestTimeout = TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS * 1_000;
  }
  const listeningPort = server.url === undefined
    ? port
    : Number.parseInt(new URL(server.url).port, 10) || port;
  return {
    port: listeningPort,
    stop: () => server.close(true),
  };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "EADDRINUSE") return true;
  const message = "message" in error ? (error as { message?: unknown }).message : undefined;
  return typeof message === "string" && /address already in use|port .* already in use|EADDRINUSE/i.test(message);
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

function createStudioFetchHandler(app: StudioApp): StudioFetch {
  return async (request) => {
    if (isLongRunningStudioRequest(request)) {
      // Bun's default 10 second idle timer also applies before an LLM emits
      // its first SSE byte. The server has a generous 255 second default, but
      // Agent requests remain open indefinitely while a provider is quiet.
      const server = (request as ServerRequest).runtime?.bun?.server;
      if (server) server.timeout(request, 0);
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

  const headers = new Headers({
    "Cache-Control": filePath.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Type": contentTypeForPath(filePath),
  });
  if (request.method === "HEAD") {
    const metadata = await stat(filePath);
    headers.set("Content-Length", String(metadata.size));
    return new Response(null, { headers });
  }
  const content = new Uint8Array(await readFile(filePath));
  headers.set("Content-Length", String(content.byteLength));
  return new Response(content, { headers });
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

function createStudioApiRequestLog(context: StudioContext): StudioApiRequestLog {
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
  if (path === "/api/open-generative/commands" || path.startsWith("/api/open-generative/inspections/")) {
    return "generative_ui";
  }
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

function resourceIdForContext(context: StudioContext): string {
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
  context: StudioContext,
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

async function checkpointStudioUiMessage(
  memory: TesseraSessionMemory | undefined,
  input: Parameters<TesseraSessionMemory["checkpointUiMessage"]>[0],
): Promise<void> {
  if (!memory) return;
  try {
    await memory.checkpointUiMessage(input);
  } catch {
    // A transcript checkpoint must not interrupt a valid Agent stream.
    // Mastra's private model memory is persisted independently per step.
  }
}

function hasSuspendedToolCall(message: TesseraUIMessage): boolean {
  return message.parts.some((part) => part.type === "data-tool-call-suspended");
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

/**
 * A page context is advisory until this server-side bind succeeds. Stale tabs,
 * changed catalogs, and malformed relation hints simply lose their shortcut;
 * they never grant a planning capability and never break ordinary chat.
 */
async function bindStudioAgentTurnContext(input: Readonly<{
  dataAgent: DataAgent;
  signal: AbortSignal;
  workspaceContext: StudioChatWorkspaceContext | undefined;
}>): Promise<StudioAgentTurnContext | undefined> {
  const workspaceContext = input.workspaceContext;
  if (!workspaceContext) return undefined;
  const workspace = {
    hasLocalFilter: workspaceContext.hasLocalFilter,
    ...(workspaceContext.view === undefined ? {} : { view: workspaceContext.view }),
  } as const;
  if (!workspaceContext.currentRelation) return { workspace };

  try {
    const currentRelation = await input.dataAgent.inspectRelationPlanningCatalog(
      workspaceContext.currentRelation,
      input.signal,
    );
    return {
      workspace,
      currentRelation: {
        capability: currentRelation.capability,
        semanticCatalog: currentRelation.semanticCatalog,
        truncated: currentRelation.truncated,
        omitted: currentRelation.omitted,
      },
    };
  } catch {
    return { workspace };
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
    const diagnostic = safeStreamDiagnostic("catalog", error);
    logAgentEvent(input.logger, "error", input.request, input.runId, {
      stage: "catalog_failed",
      code: "catalog_unavailable",
      durationMs: elapsedMilliseconds(startedAt),
      ...diagnostic,
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
  diagnosticCode?: string;
  errorPhase?: StudioLogEvent["errorPhase"];
  errorType?: string;
  errorMessage?: string;
  field?: string;
  reason?: string;
  truncated?: boolean;
  omittedSchemas?: number;
  omittedTables?: number;
  omittedColumns?: number;
  omittedForeignKeys?: number;
  omittedEntities?: number;
  omittedFields?: number;
  omittedMetrics?: number;
  omittedRelationships?: number;
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
    ...(details.diagnosticCode === undefined ? {} : { diagnosticCode: details.diagnosticCode }),
    ...(details.errorPhase === undefined ? {} : { errorPhase: details.errorPhase }),
    ...(details.errorType === undefined ? {} : { errorType: details.errorType }),
    ...(details.errorMessage === undefined ? {} : { errorMessage: details.errorMessage }),
    ...(details.field === undefined ? {} : { field: details.field }),
    ...(details.reason === undefined ? {} : { reason: details.reason }),
    ...(details.truncated === undefined ? {} : { truncated: details.truncated }),
    ...(details.omittedSchemas === undefined ? {} : { omittedSchemas: details.omittedSchemas }),
    ...(details.omittedTables === undefined ? {} : { omittedTables: details.omittedTables }),
    ...(details.omittedColumns === undefined ? {} : { omittedColumns: details.omittedColumns }),
    ...(details.omittedForeignKeys === undefined ? {} : { omittedForeignKeys: details.omittedForeignKeys }),
    ...(details.omittedEntities === undefined ? {} : { omittedEntities: details.omittedEntities }),
    ...(details.omittedFields === undefined ? {} : { omittedFields: details.omittedFields }),
    ...(details.omittedMetrics === undefined ? {} : { omittedMetrics: details.omittedMetrics }),
    ...(details.omittedRelationships === undefined ? {} : { omittedRelationships: details.omittedRelationships }),
    ...(details.status === undefined ? {} : { status: details.status }),
  });
}

function logStudioError(
  context: StudioContext,
  logger: StudioLogger,
  status: StudioErrorStatus,
  code: string,
  error?: unknown,
): void {
  const request = context.get("apiRequest");
  if (!request) return;
  context.set("apiErrorLogged", true);
  const diagnostic = error === undefined ? undefined : safeStreamDiagnostic("transport", error);
  writeStudioLog(logger, "error", {
    event: "error",
    stage: "http_failed",
    requestId: request.requestId,
    method: request.method,
    operation: request.operation,
    status,
    code,
    durationMs: elapsedMilliseconds(request.startedAt),
    ...(diagnostic ?? {}),
  });
}

type StudioStreamLogContext = Readonly<{
  request: StudioApiRequestLog | undefined;
  runId: string;
  startedAt: number;
  logger: StudioLogger;
  diagnostics: StudioStreamDiagnosticCollector;
}>;

type SafeStudioStreamDiagnostic = Readonly<{
  diagnosticCode?: string;
  errorPhase: StudioErrorPhase;
  errorType: string;
  errorMessage: string;
  field?: string;
  reason?: string;
}>;

type StudioStreamLogSnapshot = Readonly<{
  outcome: StudioStreamOutcome;
  finishReason?: StudioLogEvent["finishReason"];
  diagnostic?: SafeStudioStreamDiagnostic;
}>;

type StudioStreamDiagnosticCollector = Readonly<{
  capture(diagnostic: StudioAgentDiagnostic): void;
  captureFallback(diagnostic: StudioAgentDiagnostic): void;
  takeTool(tool: TesseraToolName): SafeStudioStreamDiagnostic | undefined;
  terminal(): SafeStudioStreamDiagnostic | undefined;
}>;

function createStudioStreamDiagnosticCollector(): StudioStreamDiagnosticCollector {
  let terminal: SafeStudioStreamDiagnostic | undefined;
  const tools = new Map<TesseraToolName, SafeStudioStreamDiagnostic>();
  const normalize = (diagnostic: StudioAgentDiagnostic): SafeStudioStreamDiagnostic => {
    const safe = safeStudioErrorDetails(diagnostic.error);
    return {
      ...safe,
      errorPhase: diagnostic.phase,
      ...(safeDiagnosticToken(diagnostic.field) === undefined ? {} : { field: safeDiagnosticToken(diagnostic.field) }),
      ...(safeDiagnosticToken(diagnostic.reason) === undefined ? {} : { reason: safeDiagnosticToken(diagnostic.reason) }),
    };
  };
  const store = (diagnostic: StudioAgentDiagnostic, fallback: boolean) => {
    const safe = normalize(diagnostic);
    if (diagnostic.tool !== undefined) {
      const existing = tools.get(diagnostic.tool);
      if (existing === undefined
        || (!fallback && diagnosticPriority(safe.errorPhase) > diagnosticPriority(existing.errorPhase))) {
        tools.set(diagnostic.tool, safe);
      }
      return;
    }
    if (terminal === undefined
      || (!fallback && diagnosticPriority(safe.errorPhase) > diagnosticPriority(terminal.errorPhase))) {
      terminal = safe;
    }
  };
  return {
    capture(diagnostic) { store(diagnostic, false); },
    captureFallback(diagnostic) { store(diagnostic, true); },
    takeTool(tool) {
      const diagnostic = tools.get(tool);
      tools.delete(tool);
      return diagnostic;
    },
    terminal() { return terminal; },
  };
}

function diagnosticPriority(phase: StudioErrorPhase): number {
  if (phase === "stream") return 1;
  if (phase === "transport") return 2;
  return 3;
}

function monitorStudioChatStream(
  source: ReadableStream<TesseraUIMessageChunk>,
  context: StudioStreamLogContext,
): Readonly<{
  source: ReadableStream<TesseraUIMessageChunk>;
  snapshot(): StudioStreamLogSnapshot;
}> {
  let failed = false;
  let cancelled = false;
  let suspended = false;
  let finishReason: FinishReason | undefined;
  let emittedFirstEvent = false;
  const activeTools = new Map<string, TesseraToolName>();
  const logTool = (
    tool: TesseraToolName,
    toolState: "started" | "completed" | "blocked" | "failed",
    details: Partial<AgentLogDetails> = {},
  ) => {
    logAgentEvent(context.logger, toolState === "failed" ? "error" : "info", context.request, context.runId, {
      event: "stream",
      stage: "tool",
      durationMs: elapsedMilliseconds(context.startedAt),
      tool,
      toolState,
      ...details,
    });
  };
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
        if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
          const tool = asTesseraToolName(chunk.toolName);
          if (tool !== undefined && !activeTools.has(chunk.toolCallId)) {
            activeTools.set(chunk.toolCallId, tool);
            logTool(tool, "started");
          }
        }
        if (chunk.type === "tool-output-available") {
          const tool = activeTools.get(chunk.toolCallId);
          if (tool !== undefined) {
            activeTools.delete(chunk.toolCallId);
            const toolState = publicToolLogState(chunk.output);
            const reported = context.diagnostics.takeTool(tool);
            const outputDiagnostic = toolState === "completed" ? undefined : publicToolDiagnostic(chunk.output);
            logTool(tool, toolState, {
              ...(reported ?? outputDiagnostic ?? {}),
              ...publicToolTruncation(chunk.output),
            });
          }
        }
        if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error" || chunk.type === "tool-output-denied") {
          const tool = activeTools.get(chunk.toolCallId)
            ?? (chunk.type === "tool-input-error" ? asTesseraToolName(chunk.toolName) : undefined);
          if (tool !== undefined) {
            activeTools.delete(chunk.toolCallId);
            if (chunk.type === "tool-output-denied") {
              logTool(tool, "blocked", { reason: "tool_output_denied" });
            } else {
              const reported = context.diagnostics.takeTool(tool);
              const message = chunk.type === "tool-input-error"
                ? toolInputValidationMessage(chunk.errorText)
                : chunk.errorText;
              const fallback = safeStudioErrorDetails({
                name: chunk.type === "tool-input-error" ? "ToolInputError" : "ToolOutputError",
                message,
              });
              logTool(tool, "failed", {
                ...(reported ?? {
                  ...fallback,
                  errorPhase: chunk.type === "tool-input-error" ? "tool-input" : "tool-output",
                }),
                ...(chunk.type !== "tool-input-error" ? {} : { field: toolInputValidationField(chunk.errorText) }),
              });
            }
          }
        }
        if (chunk.type === "abort") {
          cancelled = true;
        }
        if (chunk.type === "data-tool-call-suspended") {
          suspended = true;
          logAgentEvent(context.logger, "info", context.request, context.runId, {
            event: "stream",
            stage: "suspended",
            durationMs: elapsedMilliseconds(context.startedAt),
          });
        }
        if (chunk.type === "error") {
          failed = true;
          context.diagnostics.captureFallback({
            phase: "stream",
            error: { name: "AgentStreamError", message: chunk.errorText },
          });
        }
        if (chunk.type === "finish") {
          finishReason = chunk.finishReason;
          const suspendedFinish = suspended || (chunk.finishReason as string | undefined) === "suspended";
          if (!suspendedFinish && chunk.finishReason !== undefined && chunk.finishReason !== "stop") failed = true;
        }
        controller.enqueue(chunk);
      },
    })),
    snapshot() {
      const outcome = cancelled
        ? "cancelled"
        : failed
          ? "failed"
          : suspended
            ? "suspended"
            : finishReason === "stop" ? "completed" : "failed";
      const safeFinishReason = studioFinishReason(finishReason);
      return {
        outcome,
        ...(safeFinishReason === undefined ? {} : { finishReason: safeFinishReason }),
        ...(outcome !== "failed" || context.diagnostics.terminal() === undefined
          ? {}
          : { diagnostic: context.diagnostics.terminal() }),
      };
    },
  };
}

function withStudioStreamLogging(
  response: Response,
  request: StudioApiRequestLog | undefined,
  logger: StudioLogger,
  completedSnapshot: () => StudioStreamLogSnapshot,
  stream: Readonly<{ runId: string; startedAt: number; diagnostics: StudioStreamDiagnosticCollector }>,
): Response {
  if (!request) return response;

  const logCompletion = (snapshot: StudioStreamLogSnapshot) => {
    const { outcome } = snapshot;
    logAgentEvent(
      logger,
      outcome === "completed" || outcome === "suspended" ? "info" : outcome === "cancelled" ? "warn" : "error",
      request,
      stream.runId,
      {
        event: "stream",
        stage: outcome,
        status: response.status,
        durationMs: elapsedMilliseconds(stream.startedAt),
        outcome,
        ...(snapshot.finishReason === undefined ? {} : { finishReason: snapshot.finishReason }),
        ...(snapshot.diagnostic ?? {}),
      },
    );
  };

  if (!response.body) {
    logCompletion(completedSnapshot());
    return response;
  }

  return new Response(observeStudioStream(
    response.body,
    logCompletion,
    completedSnapshot,
    (error) => stream.diagnostics.capture({ phase: "transport", error }),
  ), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A managed runtime must survive until the browser has consumed or cancelled
 * an Agent stream. Releasing it in the route handler would allow a Settings
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
  onCompletion: (snapshot: StudioStreamLogSnapshot) => void,
  completedSnapshot: () => StudioStreamLogSnapshot,
  onTransportError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let settled = false;
  const complete = (snapshot: StudioStreamLogSnapshot) => {
    if (settled) return;
    settled = true;
    onCompletion(snapshot);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          complete(completedSnapshot());
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        onTransportError(error);
        const snapshot = completedSnapshot();
        complete({
          ...snapshot,
          outcome: "failed",
          diagnostic: safeStreamDiagnostic("transport", error),
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        complete({ ...completedSnapshot(), outcome: "cancelled" });
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

class StudioHttpError extends HTTPError {
  constructor(
    readonly status: StudioErrorStatus,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super({ message: publicMessage, status });
  }
}

function requireDatabaseActionService(value: TesseraDatabaseActionService | undefined): TesseraDatabaseActionService {
  if (!value) {
    throw new StudioHttpError(503, "database_actions_unavailable", "Database actions are not enabled for this Studio runtime.");
  }
  return value;
}

function inspectionNotFoundError(): StudioHttpError {
  return new StudioHttpError(404, "not_found", "The requested Studio endpoint was not found.");
}

function isInspectionRecordInScope(
  record: OpenGenerativeInspectionRecord | undefined,
  surfaceSessionId: string,
  authority: OpenGenerativeAuthority,
): record is OpenGenerativeInspectionRecord {
  return record !== undefined
    && record.snapshot?.surfaceSessionId === surfaceSessionId
    && record.authority?.actorBindingHash === authority.actorBindingHash
    && record.authority?.tenantBindingHash === authority.tenantBindingHash
    && record.authority?.authorityPolicyRevision === authority.authorityPolicyRevision;
}

/** Exposes a stable Host rejection code without leaking adapter or database details. */
function surfaceCommandHttpError(error: unknown): StudioHttpError {
  if (error instanceof StudioHttpError) return error;
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  const code = /^(?:action|host|intent|interaction|policy|resource|state|surface|transaction|transport|validate)\.[a-z0-9.-]{1,192}$/u.test(candidate)
    ? candidate
    : "surface.command-rejected";
  const status: StudioErrorStatus = code.startsWith("policy.") || code.includes("denied")
    ? 403
    : code.includes("conflict") || code.includes("stale")
      ? 409
      : 400;
  return new StudioHttpError(status, code, `The Surface command was rejected (${code}).`);
}

function databaseActionActor(context: StudioContext): {
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
  context: StudioContext,
  effect: TesseraDatabaseActionEffect,
): Response {
  const status = effect.summary.status === "awaiting-approval"
    ? 202
    : effect.summary.status === "denied"
      ? 403
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
  context: StudioContext,
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
  options: Readonly<{ includeColumnMetadata?: boolean; maxForeignKeys?: number; maxForeignKeyColumns?: number; maxIndexes?: number }> = {},
): Record<string, unknown> {
  const maxForeignKeys = options.maxForeignKeys ?? table.foreignKeys.length;
  const maxForeignKeyColumns = options.maxForeignKeyColumns ?? Number.MAX_SAFE_INTEGER;
  const indexes = table.indexes ?? [];
  const maxIndexes = options.maxIndexes ?? indexes.length;
  return {
    schema: table.schema,
    name: table.name,
    kind: table.kind,
    ...(table.estimatedRows === undefined ? {} : { estimatedRows: table.estimatedRows }),
    columns: columns.map((column) => publicTableColumn(column, options.includeColumnMetadata === true)),
    primaryKey: [...table.primaryKey],
    foreignKeys: table.foreignKeys.slice(0, maxForeignKeys).map((foreignKey) => ({
      name: foreignKey.name,
      columns: foreignKey.columns.slice(0, maxForeignKeyColumns),
      referencedSchema: foreignKey.referencedSchema,
      referencedTable: foreignKey.referencedTable,
      referencedColumns: foreignKey.referencedColumns.slice(0, maxForeignKeyColumns),
    })),
    indexes: indexes.slice(0, maxIndexes).map((index) => ({
      name: index.name,
      columns: [...index.columns],
      unique: index.unique,
      ...(index.method ? { method: index.method } : {}),
      ...(index.definition ? { definition: index.definition } : {}),
      isConstraint: index.isConstraint,
    })),
  };
}

function publicTableColumn(column: DatabaseTable["columns"][number], includeMetadata = false): Record<string, unknown> {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    ordinal: column.ordinal,
    ...(includeMetadata && column.defaultValue !== undefined ? { defaultValue: column.defaultValue } : {}),
    ...(includeMetadata && column.comment !== undefined ? { comment: column.comment } : {}),
  };
}

type PublicPreviewValue = string | number | boolean | null;
type PublicPreviewCell = Readonly<{ incomplete: boolean; value: PublicPreviewValue }>;

function publicTablePreview(
  table: DatabaseTable,
  columns: readonly DatabaseTable["columns"][number][],
  result: DatabaseQueryResult,
  options: Readonly<{
    definition: string;
    dialect: DatabaseCatalog["dialect"];
    page: number;
    pageSize: number;
    totalRowCount: number;
  }>,
): Record<string, unknown> {
  let remainingCharacters = TABLE_PREVIEW_MAX_RESPONSE_CHARS;
  let responseBudgetExceeded = false;
  const rows: Array<Record<string, PublicPreviewValue>> = [];
  const incompleteCells: Array<Readonly<{ columns: string[]; rowIndex: number }>> = [];

  for (const sourceRow of result.rows.slice(0, TABLE_PREVIEW_MAX_ROWS)) {
    const row = Object.create(null) as Record<string, PublicPreviewValue>;
    const incompleteColumns: string[] = [];
    let rowCharacters = 0;
    for (const column of columns) {
      const cell = Object.prototype.hasOwnProperty.call(sourceRow, column.name)
        ? publicPreviewCell(sourceRow[column.name], column.dataType)
        : { incomplete: true, value: null };
      row[column.name] = cell.value;
      if (cell.incomplete) incompleteColumns.push(column.name);
      rowCharacters += column.name.length + previewValueCharacterCost(cell.value);
    }
    if (rowCharacters > remainingCharacters) {
      responseBudgetExceeded = true;
      break;
    }
    remainingCharacters -= rowCharacters;
    if (incompleteColumns.length) incompleteCells.push({ columns: incompleteColumns, rowIndex: rows.length });
    rows.push(row);
  }

  return {
    // The endpoint repeats only the bounded metadata needed for this view.
    // The complete public catalog remains available through /api/catalog.
    table: publicTable(table, columns, {
      maxForeignKeys: TABLE_PREVIEW_MAX_FOREIGN_KEYS,
      maxForeignKeyColumns: TABLE_PREVIEW_MAX_FOREIGN_KEY_COLUMNS,
    }),
    columns: columns.map((column) => publicTableColumn(column)),
    rows,
    incompleteCells,
    rowCount: rows.length,
    totalRowCount: options.totalRowCount,
    page: options.page,
    pageSize: options.pageSize,
    definition: options.definition,
    truncated: result.truncated || result.rows.length > TABLE_PREVIEW_MAX_ROWS || responseBudgetExceeded,
    durationMs: publicPreviewDuration(result.durationMs),
  };
}

function parseTablePreviewQuery(
  raw: Record<string, string | undefined>,
  columns: readonly DatabaseTable["columns"][number][],
): {
  direction: "asc" | "desc";
  filters: Array<z.infer<typeof tablePreviewFilterSchema>>;
  page: number;
  pageSize: number;
  search: string;
  sort?: string;
} {
  const parsed = tablePreviewQuerySchema.safeParse(raw);
  if (!parsed.success) throw new StudioHttpError(400, "invalid_table_query", "The table query is invalid.");
  let filters: Array<z.infer<typeof tablePreviewFilterSchema>> = [];
  try {
    const decoded = JSON.parse(parsed.data.filters) as unknown;
    const result = z.array(tablePreviewFilterSchema).max(32).safeParse(decoded);
    if (!result.success) throw new Error("invalid filters");
    filters = result.data;
  } catch {
    throw new StudioHttpError(400, "invalid_table_query", "The table filters are invalid.");
  }
  const columnNames = new Set(columns.map((column) => column.name));
  if (parsed.data.sort !== undefined && !columnNames.has(parsed.data.sort)) {
    throw new StudioHttpError(400, "invalid_table_query", "The selected sort column is not available.");
  }
  if (filters.some((filter) => !columnNames.has(filter.column))) {
    throw new StudioHttpError(400, "invalid_table_query", "A selected filter column is not available.");
  }
  return {
    direction: parsed.data.direction,
    filters,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    search: parsed.data.q.trim(),
    ...(parsed.data.sort === undefined ? {} : { sort: parsed.data.sort }),
  };
}

function quoteTableEditorIdentifier(dialect: DatabaseCatalog["dialect"], identifier: string): string {
  if (dialect === "mongodb") return identifier;
  return dialect === "postgres" || dialect === "sqlite" || dialect === "turso"
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll("`", "``")}\``;
}

function tablePreviewSelectExpression(
  dialect: DatabaseCatalog["dialect"],
  column: DatabaseTable["columns"][number],
  quote: (identifier: string) => string,
): string {
  const identifier = quote(column.name);
  if (!isJsonDataType(column.dataType)) return identifier;
  const textType = dialect === "mysql" ? "CHAR" : "TEXT";
  return `CAST(${identifier} AS ${textType}) AS ${identifier}`;
}

function isJsonDataType(dataType: string): boolean {
  return /^(?:json|jsonb)$/iu.test(dataType.trim());
}

function buildMongoTablePreviewMatch(
  query: ReturnType<typeof parseTablePreviewQuery>,
  columns: readonly DatabaseTable["columns"][number][],
): unknown | undefined {
  const predicates: unknown[] = [];
  if (query.search) {
    predicates.push({
      $or: columns.map((column) => ({
        $regexMatch: {
          input: { $convert: { input: `$${column.name}`, to: "string", onError: "", onNull: "" } },
          regex: escapeMongoRegex(query.search),
          options: "i",
        },
      })),
    });
  }
  for (const filter of query.filters) {
    const column = columns.find((candidate) => candidate.name === filter.column);
    if (!column) continue;
    const expression = `$${column.name}`;
    if (filter.operator === "is_null" || filter.operator === "is_not_null") {
      predicates.push({ [filter.operator === "is_null" ? "$eq" : "$ne"]: [expression, null] });
      continue;
    }
    if (filter.operator === "contains") {
      predicates.push({
        $regexMatch: {
          input: { $convert: { input: expression, to: "string", onError: "", onNull: "" } },
          regex: escapeMongoRegex(filter.value),
          options: "i",
        },
      });
      continue;
    }
    const operator = filter.operator === "equals" ? "$eq"
      : filter.operator === "not_equals" ? "$ne"
        : filter.operator === "gt" ? "$gt"
          : filter.operator === "gte" ? "$gte"
            : filter.operator === "lt" ? "$lt" : "$lte";
    predicates.push({ [operator]: [expression, mongoTablePreviewValue(filter.value, column.dataType)] });
  }
  if (predicates.length === 0) return undefined;
  return predicates.length === 1 ? predicates[0] : { $and: predicates };
}

function mongoTablePreviewValue(value: string, dataType: string): unknown {
  if (/objectid/iu.test(dataType)) {
    return { $convert: { input: value, to: "objectId", onError: null, onNull: null } };
  }
  if (/(?:timestamp|datetime|\bdate\b)/iu.test(dataType)) {
    return { $convert: { input: value, to: "date", onError: null, onNull: null } };
  }
  return coercePreviewParameter(value, dataType);
}

function escapeMongoRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function coercePreviewParameter(value: string, dataType: string): string | number | boolean {
  if (/\b(bool|boolean)\b/i.test(dataType)) {
    if (value.toLocaleLowerCase("en-US") === "true") return true;
    if (value.toLocaleLowerCase("en-US") === "false") return false;
  }
  if (/\b(?:smallint|bigint|integer|int\d*|serial|decimal|numeric|real|double(?: precision)?|float\d*|money)\b/i.test(dataType)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}

function parseCountValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return numeric !== undefined && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function buildTableDefinition(dialect: DatabaseCatalog["dialect"], table: DatabaseTable): string {
  if (dialect === "mongodb") {
    return JSON.stringify({
      database: table.schema,
      collection: table.name,
      inferredFields: table.columns.map((column) => ({
        name: column.name,
        type: column.dataType,
        nullable: column.nullable,
      })),
    }, null, 2);
  }
  const quote = (identifier: string) => quoteTableEditorIdentifier(dialect, identifier);
  const relation = `${quote(table.schema)}.${quote(table.name)}`;
  if (table.kind === "view" || table.kind === "materialized-view") {
    return `-- ${table.kind} definition\n-- The view query is not exposed by the read-only catalog.\n\nCREATE ${table.kind === "materialized-view" ? "MATERIALIZED " : ""}VIEW ${relation} AS\nSELECT\n  ${table.columns.map((column) => quote(column.name)).join(",\n  ")}\nFROM ${relation};`;
  }
  const lines = table.columns
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((column) => `  ${quote(column.name)} ${column.dataType}${column.nullable ? "" : " NOT NULL"}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ""}`);
  if (table.primaryKey?.length) {
    lines.push(`  CONSTRAINT ${quote(`${table.name}_pkey`)} PRIMARY KEY (${table.primaryKey.map(quote).join(", ")})`);
  }
  for (const foreignKey of table.foreignKeys) {
    lines.push(`  CONSTRAINT ${quote(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(quote).join(", ")}) REFERENCES ${quote(foreignKey.referencedSchema)}.${quote(foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quote).join(", ")})`);
  }
  const tableDefinition = `CREATE TABLE ${relation} (\n${lines.join(",\n")}\n);`;
  const indexDefinitions = (table.indexes ?? [])
    .filter((index) => !index.isConstraint)
    .map((index) => index.definition?.trim() || `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${relation}${index.method ? ` USING ${index.method}` : ""} (${index.columns.map(quote).join(", ")})`)
    .map((definition) => definition.endsWith(";") ? definition : `${definition};`);
  return [tableDefinition, ...indexDefinitions].join("\n\n");
}

function publicPreviewCell(value: unknown, dataType?: string): PublicPreviewCell {
  if (value === null || value === undefined) return { incomplete: false, value: null };
  if (dataType && isJsonDataType(dataType)) return serializeJsonPreviewValue(value);
  if (typeof value === "string") return truncatePreviewText(value);
  if (typeof value === "boolean") return { incomplete: false, value };
  if (typeof value === "number") return Number.isFinite(value)
    ? { incomplete: false, value }
    : { incomplete: true, value: "[non-finite number]" };
  if (typeof value === "bigint") return { incomplete: false, value: value.toString(10) };
  if (value instanceof Date) {
    try {
      return { incomplete: false, value: value.toISOString() };
    } catch {
      return { incomplete: true, value: "[invalid date]" };
    }
  }
  if (typeof value === "object") return serializePreviewObject(value);
  return { incomplete: true, value: "[unsupported value]" };
}

function serializeJsonPreviewValue(value: unknown): PublicPreviewCell {
  if (typeof value === "string") {
    const bounded = truncatePreviewText(value);
    if (bounded.incomplete) return bounded;
    try {
      JSON.parse(value);
      return bounded;
    } catch {
      return { incomplete: true, value };
    }
  }
  if (typeof value !== "object" || value === null) {
    try {
      return truncatePreviewText(JSON.stringify(value));
    } catch {
      return { incomplete: true, value: "[structured value unavailable]" };
    }
  }
  return serializePreviewObject(value);
}

function serializePreviewObject(value: object): PublicPreviewCell {
  if (ArrayBuffer.isView(value)) return { incomplete: true, value: "[binary value]" };
  const seen = new WeakSet<object>();
  try {
    const normalized = normalizePreviewObject(value, seen, 0);
    const serialized = JSON.stringify(normalized.value);
    if (serialized === undefined) return { incomplete: true, value: "[structured value unavailable]" };
    const bounded = truncatePreviewText(serialized);
    return { incomplete: normalized.incomplete || bounded.incomplete, value: bounded.value };
  } catch {
    return { incomplete: true, value: "[structured value unavailable]" };
  }
}

type NormalizedPreviewObject = Readonly<{ incomplete: boolean; value: unknown }>;

function normalizePreviewObject(value: unknown, seen: WeakSet<object>, depth: number): NormalizedPreviewObject {
  if (value === null || value === undefined) return { incomplete: false, value: null };
  if (typeof value === "string") return truncatePreviewText(value);
  if (typeof value === "boolean") return { incomplete: false, value };
  if (typeof value === "number") return Number.isFinite(value)
    ? { incomplete: false, value }
    : { incomplete: true, value: "[non-finite number]" };
  if (typeof value === "bigint") return { incomplete: false, value: value.toString(10) };
  if (value instanceof Date) return publicPreviewCell(value);
  if (typeof value !== "object") return { incomplete: true, value: "[unsupported value]" };
  if (ArrayBuffer.isView(value)) return { incomplete: true, value: "[binary value]" };
  if (depth >= TABLE_PREVIEW_MAX_OBJECT_DEPTH) return { incomplete: true, value: "[nested value omitted]" };
  if (seen.has(value)) return { incomplete: true, value: "[circular value]" };
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, TABLE_PREVIEW_MAX_OBJECT_ITEMS)
      .map((item) => normalizePreviewObject(item, seen, depth + 1));
    const incomplete = value.length > TABLE_PREVIEW_MAX_OBJECT_ITEMS || items.some((item) => item.incomplete);
    const normalized = items.map((item) => item.value);
    if (value.length > TABLE_PREVIEW_MAX_OBJECT_ITEMS) normalized.push("[truncated]");
    seen.delete(value);
    return { incomplete, value: normalized };
  }

  const normalized = Object.create(null) as Record<string, unknown>;
  const record = value as Record<string, unknown>;
  let incomplete = false;
  let itemCount = 0;
  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    if (itemCount >= TABLE_PREVIEW_MAX_OBJECT_ITEMS) {
      normalized["..."] = "[truncated]";
      incomplete = true;
      break;
    }
    itemCount += 1;
    try {
      const boundedKey = truncatePreviewText(key);
      const item = normalizePreviewObject(record[key], seen, depth + 1);
      normalized[String(boundedKey.value)] = item.value;
      incomplete ||= boundedKey.incomplete || item.incomplete;
    } catch {
      normalized[String(truncatePreviewText(key).value)] = "[unavailable]";
      incomplete = true;
    }
  }
  seen.delete(value);
  return { incomplete, value: normalized };
}

function truncatePreviewText(value: string): PublicPreviewCell {
  return value.length <= TABLE_PREVIEW_MAX_CELL_CHARS
    ? { incomplete: false, value }
    : { incomplete: true, value: `${value.slice(0, TABLE_PREVIEW_MAX_CELL_CHARS - 3)}...` };
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
        indexes: (table.indexes ?? []).map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          ...(index.method ? { method: index.method } : {}),
          isConstraint: index.isConstraint,
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
  const workspaceContext = chatWorkspaceContextFromPayload(payload.workspaceContext);
  return {
    ...parsed.data,
    trigger: payload.trigger === "regenerate-message" ? "regenerate-message" : "submit-message",
    ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
    images: imageParts,
    ...(workspaceContext === undefined ? {} : { workspaceContext }),
  };
}

function chatWorkspaceContextFromPayload(value: unknown): StudioChatWorkspaceContext | undefined {
  const parsed = chatWorkspaceContextPayloadSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...(parsed.data.currentRelation === undefined ? {} : { currentRelation: parsed.data.currentRelation }),
    hasLocalFilter: parsed.data.hasLocalFilter === true,
    ...(parsed.data.view === undefined ? {} : { view: parsed.data.view }),
  };
}

function isStudioImageMediaType(value: string): value is TesseraAgentImageMediaType {
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
    clearResource(input: Readonly<{ resourceId: string }>): void {
      for (const [key, retry] of retries) {
        if (retry.resourceId === input.resourceId) retries.delete(key);
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
  const textId = `text-${input.runId}`;
  let textStarted = false;
  let toolEvent = 0;
  const activeToolIds = new Map<string, string>();
  const stream = createUIMessageStream<TesseraUIMessage>({
    onError: (error) => {
      const publicError = publicStudioStreamError(error);
      input.reportDiagnostic?.({ phase: publicError.phase, error });
      return publicError.message;
    },
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
      writer.write({ type: "start", messageId: `message-${input.runId}` });
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
                toolId = `tool-${input.runId}-${toolEvent}`;
                activeToolIds.set(safe.data.tool, toolId);
                writer.write({
                  type: "tool-input-start",
                  toolCallId: toolId,
                  toolName: safe.data.tool,
                  providerExecuted: true,
                  title: publicToolTitle(safe.data.tool),
                });
                writer.write({
                  type: "tool-input-available",
                  toolCallId: toolId,
                  toolName: safe.data.tool,
                  input: publicToolInput(safe.data.tool),
                  providerExecuted: true,
                  title: publicToolTitle(safe.data.tool),
                });
              }
              if (safe.data.state === "failed") {
                writer.write({
                  type: "tool-output-error",
                  toolCallId: toolId,
                  errorText: "This operation could not be completed.",
                  providerExecuted: true,
                });
              } else if (safe.data.state !== "started") {
                writer.write({
                  type: "tool-output-available",
                  toolCallId: toolId,
                  output: { status: safe.data.state },
                  providerExecuted: true,
                });
              }
              if (safe.data.state !== "started") activeToolIds.delete(safe.data.tool);
            })
            : await agent.run(input),
        );
        if (!textStarted && run.message) {
          startText();
          writer.write({ type: "text-delta", id: textId, delta: run.message });
        }
        finishText();

        writer.write({ type: "finish", finishReason: "stop" });
      } catch (error) {
        const publicError = publicStudioStreamError(error);
        input.reportDiagnostic?.({ phase: publicError.phase, error });
        finishText();
        writer.write({ type: "error", errorText: publicError.message });
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

function publicToolInput(tool: TesseraToolName): Record<string, string> {
  if (tool === "list_database") return { action: "list_database" };
  if (tool === "search_data_context") return { action: "search_data_context" };
  if (tool === "execute_sql") return { action: "execute_sql" };
  return { action: "prepare_analysis" };
}

function publicToolLogState(value: unknown): "completed" | "blocked" | "failed" {
  const status = isRecord(value) ? value.status : undefined;
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "unavailable" || status === "rejected") return "blocked";
  return "completed";
}

function publicToolDiagnostic(value: unknown): SafeStudioStreamDiagnostic | undefined {
  if (!isRecord(value)) return undefined;
  const reason = safeDiagnosticToken(value.reason);
  const status = typeof value.status === "string" ? value.status : "failed";
  const message = typeof value.message === "string"
    ? value.message
    : `The tool returned status ${status}${reason === undefined ? "." : ` with reason ${reason}.`}`;
  return {
    ...safeStudioErrorDetails({ name: "ToolResultError", ...(reason === undefined ? {} : { code: reason }), message }),
    errorPhase: "tool-output",
    ...(reason === undefined ? {} : { reason }),
  };
}

function publicToolTruncation(value: unknown): Partial<AgentLogDetails> {
  if (!isRecord(value) || value.truncated !== true) return {};
  const omitted = isRecord(value.omitted) ? value.omitted : undefined;
  return {
    truncated: true,
    ...safeOmittedCount(omitted, "schemas", "omittedSchemas"),
    ...safeOmittedCount(omitted, "tables", "omittedTables"),
    ...safeOmittedCount(omitted, "columns", "omittedColumns"),
    ...safeOmittedCount(omitted, "foreignKeys", "omittedForeignKeys"),
    ...safeOmittedCount(omitted, "entities", "omittedEntities"),
    ...safeOmittedCount(omitted, "fields", "omittedFields"),
    ...safeOmittedCount(omitted, "metrics", "omittedMetrics"),
    ...safeOmittedCount(omitted, "relationships", "omittedRelationships"),
  };
}

function safeOmittedCount(
  omitted: Record<string, unknown> | undefined,
  source: string,
  target: keyof AgentLogDetails,
): Partial<AgentLogDetails> {
  const value = omitted?.[source];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { [target]: value }
    : {};
}

function toolInputValidationMessage(errorText: string): string {
  const explicitMessage = /(?:error message|validation error)\s*:\s*([\s\S]+)$/i.exec(errorText)?.[1]?.trim();
  if (explicitMessage) return explicitMessage;
  const argumentsMarker = /\b(?:value|input|arguments)\s*:/i.exec(errorText);
  if (argumentsMarker?.index !== undefined) {
    const prefix = errorText.slice(0, argumentsMarker.index).trim();
    return `${prefix || "Tool input validation failed."} Tool arguments were omitted from the log.`;
  }
  return errorText;
}

function toolInputValidationField(errorText: string): string | undefined {
  const match = /\bpath\s*[:=]?\s*(?:\[\s*)?["']?([A-Za-z_][A-Za-z0-9_-]{0,127})/i.exec(errorText);
  return safeDiagnosticToken(match?.[1]);
}

function safeStreamDiagnostic(phase: StudioErrorPhase, error: unknown): SafeStudioStreamDiagnostic {
  return { ...safeStudioErrorDetails(error), errorPhase: phase };
}

function safeDiagnosticToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function studioFinishReason(value: FinishReason | undefined): StudioLogEvent["finishReason"] | undefined {
  if (value === "stop" || value === "length" || value === "content-filter" || value === "tool-calls" || value === "error" || value === "other") {
    return value;
  }
  return undefined;
}

function publicToolTitle(tool: TesseraToolName): string {
  if (tool === "list_database") return "List database context";
  if (tool === "search_data_context") return "Search data context";
  if (tool === "execute_sql") return "Execute SQL";
  return "Prepare analysis";
}

function asTesseraToolName(value: unknown): TesseraToolName | undefined {
  return typeof value === "string" && TESSERA_PUBLIC_TOOL_NAMES.has(value as TesseraToolName)
    ? value as TesseraToolName
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
