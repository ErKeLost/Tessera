import pino, { type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";

export type StudioApiOperation = "catalog" | "chat" | "connection" | "data_preview" | "database_actions" | "generative_ui" | "meta" | "runs" | "settings" | "threads" | "unknown";
export type StudioStreamOutcome = "completed" | "suspended" | "failed" | "cancelled";
export type StudioToolName = "list_database" | "search_data_context" | "prepare_analysis" | "execute_sql";
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
export type StudioErrorPhase = "catalog" | "provider" | "tool-input" | "tool-output" | "persistence" | "presentation" | "stream" | "transport";
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
  | "suspended"
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
  diagnosticCode?: string;
  errorPhase?: StudioErrorPhase;
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
  if (isSafeDiagnosticToken(event.diagnosticCode)) fields.diagnosticCode = event.diagnosticCode;
  if (event.errorPhase !== undefined) fields.errorPhase = event.errorPhase;
  if (isSafeDiagnosticToken(event.errorType)) fields.errorType = event.errorType;
  if (event.errorMessage !== undefined) {
    const errorMessage = sanitizeStudioErrorText(event.errorMessage);
    if (errorMessage !== undefined) fields.errorMessage = errorMessage;
  }
  if (isSafeDiagnosticToken(event.field)) fields.field = event.field;
  if (isSafeDiagnosticToken(event.reason)) fields.reason = event.reason;
  if (event.truncated !== undefined) fields.truncated = event.truncated ? 1 : 0;
  if (isSafeCount(event.omittedSchemas)) fields.omittedSchemas = event.omittedSchemas;
  if (isSafeCount(event.omittedTables)) fields.omittedTables = event.omittedTables;
  if (isSafeCount(event.omittedColumns)) fields.omittedColumns = event.omittedColumns;
  if (isSafeCount(event.omittedForeignKeys)) fields.omittedForeignKeys = event.omittedForeignKeys;
  if (isSafeCount(event.omittedEntities)) fields.omittedEntities = event.omittedEntities;
  if (isSafeCount(event.omittedFields)) fields.omittedFields = event.omittedFields;
  if (isSafeCount(event.omittedMetrics)) fields.omittedMetrics = event.omittedMetrics;
  if (isSafeCount(event.omittedRelationships)) fields.omittedRelationships = event.omittedRelationships;
  if (event.outcome !== undefined) fields.outcome = event.outcome;
  if (event.durationMs !== undefined) fields.durationMs = event.durationMs;
  if (event.tool !== undefined) fields.tool = event.tool;
  if (event.toolState !== undefined) fields.toolState = event.toolState;
  if (event.agentStage !== undefined) fields.agentStage = event.agentStage;
  if (event.agentStageStatus !== undefined) fields.agentStageStatus = event.agentStageStatus;
  if (event.runStatus !== undefined) fields.runStatus = event.runStatus;
  if (event.finishReason !== undefined) fields.finishReason = event.finishReason;
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
  "suspended",
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

function isSafeDiagnosticToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type SafeStudioErrorDetails = Readonly<{
  diagnosticCode?: string;
  errorType: string;
  errorMessage: string;
}>;

const MAX_STUDIO_ERROR_MESSAGE_CHARACTERS = 16_000;
const REDACTED_VALUE = "[REDACTED]";

/**
 * Extracts the complete useful Error message and cause chain without serializing
 * driver/provider objects, request payloads, SQL, credentials, or stack traces.
 */
export function safeStudioErrorDetails(error: unknown): SafeStudioErrorDetails {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = error;
  let errorType = "Error";
  let diagnosticCode: string | undefined;

  for (let depth = 0; current !== undefined && current !== null && depth < 8 && !visited.has(current); depth += 1) {
    visited.add(current);
    const record = isRecord(current) ? current : undefined;
    const currentType = errorTypeFrom(current, record);
    if (depth === 0) {
      errorType = currentType;
      diagnosticCode = diagnosticCodeFrom(record);
    }
    const message = errorMessageFrom(current, record);
    const extras = diagnosticExtras(record);
    const complete = [message, ...extras].filter((value): value is string => value !== undefined).join(" ");
    if (complete) messages.push(depth === 0 ? complete : `Caused by ${currentType}: ${complete}`);
    current = record?.cause;
  }

  const errorMessage = sanitizeStudioErrorText(messages.join(" "))
    ?? "The operation failed without an Error message.";
  return {
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    errorType,
    errorMessage,
  };
}

export type PublicStudioStreamError = Readonly<{
  message: string;
  phase: Extract<StudioErrorPhase, "provider" | "stream">;
}>;

const GENERIC_PUBLIC_STREAM_ERROR = "The Tessera Agent stream could not be processed.";

/**
 * Produces the only error shape allowed to cross the Studio stream boundary.
 * The error graph is inspected solely for an HTTP status; no error-owned text
 * or metadata is copied into the browser response.
 */
export function publicStudioStreamError(
  error: unknown,
  model?: string,
): PublicStudioStreamError {
  const status = providerHttpStatus(error);
  if (status === undefined) {
    return { message: GENERIC_PUBLIC_STREAM_ERROR, phase: "stream" };
  }
  return {
    message: `${publicProviderName(model)} ${status}: ${publicHttpReason(status)}. ${publicProviderFailureDetail(status)}`,
    phase: "provider",
  };
}

function publicProviderFailureDetail(status: number): string {
  switch (status) {
    case 401: return "The configured API credentials were rejected.";
    case 403: return "This account or model is not authorized for the request.";
    case 429: return "The rate or usage limit was reached.";
    default: return status >= 500
      ? "The provider is temporarily unavailable."
      : "The provider rejected the model request.";
  }
}

const PUBLIC_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  google: "Google",
  groq: "Groq",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  xai: "xAI",
};

function publicProviderName(model: string | undefined): string {
  const provider = typeof model === "string"
    ? model.split("/", 1)[0]?.trim().toLocaleLowerCase("en-US")
    : undefined;
  return provider === undefined ? "Model provider" : PUBLIC_PROVIDER_NAMES[provider] ?? "Model provider";
}

const MAX_PUBLIC_ERROR_NODES = 24;
const MAX_PUBLIC_RETRY_ERRORS = 8;

function providerHttpStatus(error: unknown): number | undefined {
  const pending: unknown[] = [error];
  const visited = new Set<object>();

  for (let inspected = 0; inspected < MAX_PUBLIC_ERROR_NODES && pending.length > 0; inspected += 1) {
    const current = pending.shift();
    if (!isObjectLike(current) || visited.has(current)) continue;
    visited.add(current);

    const response = safeProperty(current, "response");
    const metadata = safeProperty(current, "$metadata");
    for (const candidate of [
      safeProperty(current, "statusCode"),
      safeProperty(current, "status"),
      safeProperty(current, "code"),
      safeProperty(response, "status"),
      safeProperty(metadata, "httpStatusCode"),
    ]) {
      const status = publicHttpStatus(candidate);
      if (status !== undefined) return status;
    }

    pending.push(
      safeProperty(current, "lastError"),
      safeProperty(current, "cause"),
      ...safeArrayPrefix(safeProperty(current, "errors"), MAX_PUBLIC_RETRY_ERRORS).reverse(),
    );
  }
  return undefined;
}

function publicHttpStatus(value: unknown): number | undefined {
  const status = typeof value === "string" && /^\d{3}$/u.test(value)
    ? Number(value)
    : value;
  return typeof status === "number"
    && Number.isInteger(status)
    && status >= 100
    && status <= 599
    ? status
    : undefined;
}

function safeArrayPrefix(value: unknown, limit: number): unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const length = Math.min(value.length, limit);
    const items: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      items.push(safeProperty(value, index));
    }
    return items;
  } catch {
    return [];
  }
}

function safeProperty(value: unknown, key: PropertyKey): unknown {
  if (!isObjectLike(value)) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function publicHttpReason(status: number): string {
  switch (status) {
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 413: return "Content Too Large";
    case 415: return "Unsupported Media Type";
    case 422: return "Unprocessable Content";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    case 504: return "Gateway Timeout";
    default: return status >= 500 ? "Provider Error" : "Request Failed";
  }
}

/** Final safety boundary for terminal-facing diagnostic strings. */
export function sanitizeStudioErrorText(value: string): string | undefined {
  let text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  if (!text) return undefined;

  text = text
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|libsql|https?|wss?):\/\/[^\s"'<>]+/gi, REDACTED_VALUE)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, `$1 ${REDACTED_VALUE}`)
    .replace(/\b(?:api[-_ ]?key|authorization|auth[-_ ]?token|access[-_ ]?token|password|passwd|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)} ${REDACTED_VALUE}`)
    .replace(/\b(?:sk|pk)-(?:or-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED_VALUE)
    .replace(/\bor-v1-[A-Za-z0-9_-]{12,}\b/g, REDACTED_VALUE)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED_VALUE)
    .replace(/\b(sql|query|statement)(\s*[:=]\s*)(?:"[\s\S]*?"|'[\s\S]*?'|(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b[\s\S]*?(?=\s+\b(?:response\s*body|responseBody|provider\s*payload|request\s*body|api[-_ ]?key|authorization|error|cause|detail|hint)\s*[:=]|$))/gi, (_match, label: string, separator: string) => `${label}${separator}[REDACTED_SQL]`)
    .replace(/(^|[\r\n])\s*(?:SELECT|WITH|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE)\b[^\r\n]*/gi, `$1[REDACTED_SQL]`)
    .replace(/\b(?:response\s*body|responseBody|provider\s*payload|request\s*body)\s*[:=]\s*(?:\{[\s\S]*\}|\[[\s\S]*\])/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)} [REDACTED_PROVIDER_PAYLOAD]`);

  if (text.length <= MAX_STUDIO_ERROR_MESSAGE_CHARACTERS) return text;
  return `${text.slice(0, MAX_STUDIO_ERROR_MESSAGE_CHARACTERS)} [diagnostic truncated]`;
}

function errorTypeFrom(value: unknown, record: Record<string, unknown> | undefined): string {
  const name = typeof record?.name === "string" ? record.name : undefined;
  const constructorName = typeof value === "object" && value !== null
    ? value.constructor?.name
    : undefined;
  const candidate = name ?? constructorName ?? (typeof value === "string" ? "Error" : typeof value);
  return isSafeDiagnosticToken(candidate) ? candidate : "Error";
}

function diagnosticCodeFrom(record: Record<string, unknown> | undefined): string | undefined {
  const value = record?.code ?? record?.statusCode;
  const candidate = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  return isSafeDiagnosticToken(candidate) ? candidate : undefined;
}

function errorMessageFrom(value: unknown, record: Record<string, unknown> | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof record?.message === "string") return record.message;
  const nestedError = isRecord(record?.error) ? record.error : undefined;
  return typeof nestedError?.message === "string" ? nestedError.message : undefined;
}

function diagnosticExtras(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const extras: string[] = [];
  if (typeof record.detail === "string" && record.detail !== record.message) extras.push(`Detail: ${record.detail}`);
  if (typeof record.hint === "string") extras.push(`Hint: ${record.hint}`);
  if (typeof record.position === "string" || typeof record.position === "number") extras.push(`Position: ${String(record.position)}`);
  return extras;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
