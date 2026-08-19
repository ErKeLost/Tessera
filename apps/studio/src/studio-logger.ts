import pino, { type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

export type StudioApiOperation = "catalog" | "chat" | "connection" | "data_preview" | "database_actions" | "meta" | "runs" | "settings" | "threads" | "unknown";
export type StudioStreamOutcome = "completed" | "failed" | "cancelled";
export type StudioToolName = "inspect_catalog" | "describe_data" | "probe_data" | "run_analysis";
export type StudioToolState = "started" | "completed" | "blocked" | "failed";
export type StudioAgentStage =
  | "catalog"
  | "retrieval"
  | "planning"
  | "probing"
  | "compiling"
  | "executing"
  | "verifying"
  | "publishing"
  | "narrating";
export type StudioAgentStageStatus = "started" | "completed" | "failed";
export type StudioLogLevel = "debug" | "info" | "warn" | "error";
export type StudioLogStage =
  | "ready"
  | "failed"
  | "stopped"
  | "received"
  | "completed"
  | "http_failed"
  | "catalog_started"
  | "catalog_completed"
  | "catalog_failed"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "started"
  | "first_event"
  | "tool"
  | "cancelled"
  | "analysis_stage";

/**
 * A deliberately small allowlist of fields which are safe to emit from the
 * Studio process. In particular it excludes URLs, database identifiers, SQL,
 * request headers and bodies, and raw provider errors.
 */
export type StudioLogEvent = Readonly<{
  event: "startup" | "shutdown" | "request" | "response" | "error" | "agent" | "stream";
  stage?: StudioLogStage;
  requestId?: string;
  runId?: string;
  method?: string;
  operation?: StudioApiOperation;
  status?: number;
  code?: string;
  outcome?: StudioStreamOutcome;
  durationMs?: number;
  tool?: StudioToolName;
  toolState?: StudioToolState;
  agentStage?: StudioAgentStage;
  agentStageStatus?: StudioAgentStageStatus;
  runStatus?: "completed" | "needs_input";
  finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  listenPort?: number;
  idleTimeoutSeconds?: number;
}>;

/**
 * The injectable observability boundary for hosts embedding Tessera Studio.
 * `debug` and `warn` are optional to preserve compatibility with the original
 * two-method logger contract.
 */
export type StudioLogger = Readonly<{
  debug?: (event: StudioLogEvent) => void;
  info: (event: StudioLogEvent) => void;
  warn?: (event: StudioLogEvent) => void;
  error: (event: StudioLogEvent) => void;
}>;

export type CreateStudioConsoleLoggerOptions = Readonly<{
  level?: StudioLogLevel;
  /** Defaults to pretty terminal output on a TTY and JSON elsewhere. */
  pretty?: boolean;
  colorize?: boolean;
}>;

export const silentStudioLogger: StudioLogger = {
  info() {},
  error() {},
};

/**
 * Creates the local Studio logger. Pino keeps the source event structured for
 * terminal filtering and later transport replacement, while pino-pretty gives
 * developers a concise, coloured local view without hand-rolled ANSI output.
 */
export function createStudioConsoleLogger(options: CreateStudioConsoleLoggerOptions = {}): StudioLogger {
  const shouldPrettyPrint = options.pretty ?? (options.colorize !== undefined || process.stdout.isTTY === true);
  const logger = pino({
    name: "tessera-studio",
    level: options.level ?? configuredStudioLogLevel(),
    base: { service: "tessera-studio" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "url",
        "databaseName",
        "databaseUrl",
        "connectionString",
        "sql",
        "headers",
        "body",
        "authorization",
        "cookie",
        "error",
        "err",
        "request.headers",
        "request.body",
      ],
      remove: true,
    },
  }, shouldPrettyPrint
    ? pretty({
      colorize: options.colorize ?? process.stdout.isTTY === true,
      colorizeObjects: true,
      levelFirst: true,
      translateTime: "SYS:standard",
      singleLine: true,
      ignore: "pid,hostname,name,service",
    })
    : undefined);

  return {
    debug(event) { writePinoStudioEvent(logger, "debug", event); },
    info(event) { writePinoStudioEvent(logger, "info", event); },
    warn(event) { writePinoStudioEvent(logger, "warn", event); },
    error(event) { writePinoStudioEvent(logger, "error", event); },
  };
}

function configuredStudioLogLevel(): StudioLogLevel {
  const value = process.env.TESSERA_LOG_LEVEL?.trim().toLocaleLowerCase("en-US");
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

function writePinoStudioEvent(logger: PinoLogger, level: StudioLogLevel, event: StudioLogEvent): void {
  const fields = toPinoFields(event);
  const message = studioLogMessage(event);
  if (level === "debug") {
    logger.debug(fields, message);
    return;
  }
  if (level === "warn") {
    logger.warn(fields, message);
    return;
  }
  if (level === "error") {
    logger.error(fields, message);
    return;
  }
  logger.info(fields, message);
}

/** Keeps logging payloads constrained even if future callers widen their event object. */
function toPinoFields(event: StudioLogEvent): Record<string, string | number> {
  const fields: Record<string, string | number> = { event: event.event };
  if (isStudioLogStage(event.stage)) fields.stage = event.stage;
  if (event.requestId !== undefined) fields.requestId = event.requestId;
  if (event.runId !== undefined) fields.runId = event.runId;
  if (event.method !== undefined) fields.method = event.method;
  if (event.operation !== undefined) fields.operation = event.operation;
  if (event.status !== undefined) fields.status = event.status;
  if (isStudioLogCode(event.code)) fields.code = event.code;
  if (event.outcome !== undefined) fields.outcome = event.outcome;
  if (event.durationMs !== undefined) fields.durationMs = event.durationMs;
  if (event.tool !== undefined) fields.tool = event.tool;
  if (event.toolState !== undefined) fields.toolState = event.toolState;
  if (event.agentStage !== undefined) fields.agentStage = event.agentStage;
  if (event.agentStageStatus !== undefined) fields.agentStageStatus = event.agentStageStatus;
  if (event.runStatus !== undefined) fields.runStatus = event.runStatus;
  if (event.listenPort !== undefined) fields.listenPort = event.listenPort;
  if (event.idleTimeoutSeconds !== undefined) fields.idleTimeoutSeconds = event.idleTimeoutSeconds;
  return fields;
}

const studioLogStages = new Set<StudioLogStage>([
  "ready",
  "failed",
  "stopped",
  "received",
  "completed",
  "http_failed",
  "catalog_started",
  "catalog_completed",
  "catalog_failed",
  "run_started",
  "run_completed",
  "run_failed",
  "started",
  "first_event",
  "tool",
  "cancelled",
  "analysis_stage",
]);

const studioLogCodes = new Set([
  "agent_output_invalid",
  "agent_run_failed",
  "agent_unavailable",
  "authentication_required",
  "catalog_unavailable",
  "connection_unavailable",
  "database_action_denied",
  "database_action_failed",
  "database_action_not_found",
  "database_actions_unavailable",
  "internal_error",
  "invalid_database_action",
  "invalid_chat_request",
  "invalid_json",
  "invalid_run_request",
  "json_required",
  "not_found",
  "origin_denied",
  "request_too_large",
  "invalid_settings",
  "runtime_unavailable",
  "server_start_failed",
  "settings_unavailable",
  "table_not_found",
  "table_not_previewable",
  "table_preview_unavailable",
  "invalid_thread_request",
  "session_unavailable",
  "thread_not_found",
]);

function isStudioLogStage(value: unknown): value is StudioLogStage {
  return typeof value === "string" && studioLogStages.has(value as StudioLogStage);
}

function isStudioLogCode(value: unknown): value is string {
  return typeof value === "string" && studioLogCodes.has(value);
}

function studioLogMessage(event: StudioLogEvent): string {
  switch (event.event) {
    case "startup": return event.stage === "failed"
      ? "Tessera Studio failed to start"
      : "Tessera Studio ready";
    case "shutdown": return "Tessera Studio stopped";
    case "request": return "HTTP request received";
    case "response": return "HTTP request completed";
    case "error": return "HTTP request failed";
    case "agent": return agentLogMessage(event.stage);
    case "stream": return streamLogMessage(event.stage);
  }
}

function agentLogMessage(stage: StudioLogStage | undefined): string {
  switch (stage) {
    case "catalog_started": return "Agent catalog load started";
    case "catalog_completed": return "Agent catalog load completed";
    case "catalog_failed": return "Agent catalog load failed";
    case "run_started": return "Agent run started";
    case "run_completed": return "Agent run completed";
    case "run_failed": return "Agent run failed";
    default: return "Agent lifecycle event";
  }
}

function streamLogMessage(stage: StudioLogStage | undefined): string {
  switch (stage) {
    case "started": return "Agent stream opened";
    case "first_event": return "Agent stream produced its first event";
    case "tool": return "Agent tool state changed";
    case "completed": return "Agent stream completed";
    case "failed": return "Agent stream failed";
    case "cancelled": return "Agent stream cancelled";
    default: return "Agent stream event";
  }
}
