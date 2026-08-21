/**
 * Local, thread-isolated conversation storage for Tessera Studio.
 *
 * Mastra message history is private model context. The browser receives a
 * separate, allowlisted UI transcript stored in thread metadata so tool
 * calls and reasoning can be restored without replaying raw model messages.
 */
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import type { StorageThreadType } from "@mastra/core/memory";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TesseraUIMessage } from "./protocol";

const SESSION_DIRECTORY = ".tessera";
const SESSION_DATABASE_FILE = "memory.db";
const UI_TRANSCRIPT_METADATA_KEY = "tesseraUiTranscriptV1";
const DEFAULT_HISTORY_MESSAGE_LIMIT = 32;
const MAX_THREAD_TITLE_LENGTH = 120;
const MAX_UI_MESSAGES = 64;
const MAX_UI_PARTS_PER_MESSAGE = 32;
const MAX_UI_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_USER_TEXT_LENGTH = 12_000;
const MAX_ASSISTANT_TEXT_LENGTH = 30_000;
const MAX_REASONING_TEXT_LENGTH = 30_000;
const HISTORY_TOOL_FAILURE = "This governed tool call did not complete.";

/** Stable principal for a loopback Studio without a host identity provider. */
export const LOCAL_STUDIO_IDENTITY = Object.freeze({
  subject: "local-user",
  tenantId: "local-studio",
});

export type TesseraSessionThread = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}>;

/** A browser-safe AI SDK message, never a Mastra memory message. */
export type TesseraSessionMessage = TesseraUIMessage;

export type TesseraSessionMemory = Readonly<{
  memory: Memory;
  createThread(input: Readonly<{ id: string; resourceId: string; title?: string }>): Promise<TesseraSessionThread>;
  getThread(input: Readonly<{ id: string; resourceId: string }>): Promise<TesseraSessionThread | undefined>;
  listThreads(input: Readonly<{ resourceId: string; limit?: number }>): Promise<readonly TesseraSessionThread[]>;
  renameThread(input: Readonly<{ id: string; resourceId: string; title: string }>): Promise<TesseraSessionThread | undefined>;
  deleteThread(input: Readonly<{ id: string; resourceId: string }>): Promise<boolean>;
  clearThreads(input: Readonly<{ resourceId: string }>): Promise<readonly string[]>;
  appendUiMessages(input: Readonly<{
    id: string;
    resourceId: string;
    messages: readonly unknown[];
  }>): Promise<void>;
  readMessages(input: Readonly<{ id: string; resourceId: string }>): Promise<readonly TesseraSessionMessage[] | undefined>;
  close(): Promise<void>;
}>;

export type CreateTesseraSessionMemoryOptions = Readonly<{
  /** Defaults to the current project directory, not the analysed database. */
  rootDirectory?: string;
  databaseFileName?: string;
  lastMessages?: number;
}>;

type StoredUiTranscript = Readonly<{
  version: 1;
  messages: readonly TesseraSessionMessage[];
}>;

type SanitizationContext = Readonly<{
  messageId: string;
}>;

/**
 * Creates the private SQLite store used for Studio sessions. The folder is
 * intentionally local to the project and guarded like settings files because
 * chat history can contain sensitive business context.
 */
export function createTesseraSessionMemory(
  options: CreateTesseraSessionMemoryOptions = {},
): TesseraSessionMemory {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const databaseFileName = options.databaseFileName ?? SESSION_DATABASE_FILE;
  if (!isSafeFileName(databaseFileName)) {
    throw new TypeError("Tessera Studio session storage is unavailable.");
  }

  const directory = join(rootDirectory, SESSION_DIRECTORY);
  ensurePrivateDirectory(directory);
  const databasePath = join(directory, databaseFileName);
  const storage = new LibSQLStore({
    id: "tessera-studio-memory",
    url: pathToFileURL(databasePath).href,
  });
  const memory = new Memory({
    storage,
    // A vector store is unnecessary here. More importantly, leaving it off
    // prevents semantic recall from ever crossing a session boundary.
    vector: false,
    options: {
      lastMessages: boundedInteger(options.lastMessages ?? DEFAULT_HISTORY_MESSAGE_LIMIT, 1, 128),
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
      generateTitle: false,
    },
  });
  const transcriptUpdates = new Map<string, Promise<void>>();

  const queueTranscriptUpdate = async <T>(
    input: Readonly<{ id: string; resourceId: string }>,
    work: () => Promise<T>,
  ): Promise<T> => {
    const key = `${input.resourceId}\u001f${input.id}`;
    const previous = transcriptUpdates.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    const completion = task.then(() => {}, () => {});
    transcriptUpdates.set(key, completion);
    try {
      return await task;
    } finally {
      if (transcriptUpdates.get(key) === completion) transcriptUpdates.delete(key);
    }
  };

  const waitForTranscriptUpdate = async (input: Readonly<{ id: string; resourceId: string }>): Promise<void> => {
    const key = `${input.resourceId}\u001f${input.id}`;
    await transcriptUpdates.get(key);
  };

  const deleteOwnedThread = (input: Readonly<{ id: string; resourceId: string }>): Promise<boolean> => (
    queueTranscriptUpdate(input, async () => {
      const existing = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
      if (!existing) return false;
      await memory.deleteThread(input.id);
      return true;
    })
  );

  return Object.freeze({
    memory,
    async createThread(input) {
      const existing = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
      if (existing) return publicThread(existing);
      const thread = await memory.createThread({
        threadId: input.id,
        resourceId: input.resourceId,
        ...(input.title === undefined ? {} : { title: normalizeThreadTitle(input.title) }),
      });
      return publicThread(thread);
    },
    async getThread(input) {
      const thread = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
      return thread ? publicThread(thread) : undefined;
    },
    async listThreads(input) {
      const result = await memory.listThreads({
        filter: { resourceId: input.resourceId },
        page: 0,
        perPage: boundedInteger(input.limit ?? 100, 1, 200),
        orderBy: { field: "updatedAt", direction: "DESC" },
      });
      return result.threads.map(publicThread);
    },
    async renameThread(input) {
      const existing = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
      if (!existing) return undefined;
      const thread = await memory.updateThread({
        id: input.id,
        title: normalizeThreadTitle(input.title),
      });
      return publicThread(thread);
    },
    deleteThread: deleteOwnedThread,
    async clearThreads(input) {
      const result = await memory.listThreads({
        filter: { resourceId: input.resourceId },
        perPage: false,
      });
      const deletedThreadIds: string[] = [];
      for (const thread of result.threads) {
        if (await deleteOwnedThread({ id: thread.id, resourceId: input.resourceId })) {
          deletedThreadIds.push(thread.id);
        }
      }
      return deletedThreadIds;
    },
    async appendUiMessages(input) {
      if (input.messages.length === 0) return;
      await queueTranscriptUpdate(input, async () => {
        const thread = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
        if (!thread) throw new TypeError("Tessera Studio session storage is unavailable.");

        const existing = sanitizeStoredTranscript(thread.metadata?.[UI_TRANSCRIPT_METADATA_KEY]);
        const appended = input.messages.flatMap((message) => {
          const sanitized = sanitizeUiMessage(message);
          return sanitized === undefined ? [] : [sanitized];
        });
        if (appended.length === 0) return;

        const transcript = boundedTranscript([...existing.messages, ...appended]);
        await memory.updateThread({
          id: input.id,
          metadata: { [UI_TRANSCRIPT_METADATA_KEY]: transcript },
        });
      });
    },
    async readMessages(input) {
      await waitForTranscriptUpdate(input);
      const thread = await memory.getThreadById({ threadId: input.id, resourceId: input.resourceId });
      if (!thread) return undefined;
      return sanitizeStoredTranscript(thread.metadata?.[UI_TRANSCRIPT_METADATA_KEY]).messages;
    },
    async close() {
      await Promise.all([...transcriptUpdates.values()]);
      await storage.close();
      // LibSQL creates the file lazily. Tighten its mode only after it exists
      // and never follow a symlink when doing so.
      if (existsSync(databasePath)) {
        const metadata = lstatSync(databasePath);
        if (metadata.isFile() && !metadata.isSymbolicLink()) chmodSync(databasePath, 0o600);
      }
    },
  });
}

/** A deterministic resource owner. It is authorization only, never recall scope. */
export function tesseraSessionResourceId(identity?: Readonly<{ tenantId: string; subject: string }>): string {
  if (!identity
    || (identity.tenantId === LOCAL_STUDIO_IDENTITY.tenantId
      && identity.subject === LOCAL_STUDIO_IDENTITY.subject)) return "local-studio";
  return `tenant:${identity.tenantId}\u001fsubject:${identity.subject}`;
}

/** Produces a compact local title without a second model call. */
export function tesseraThreadTitleFromMessage(value: string): string {
  return normalizeThreadTitle(value);
}

function publicThread(thread: StorageThreadType): TesseraSessionThread {
  return Object.freeze({
    id: thread.id,
    title: normalizeThreadTitle(thread.title ?? "New analysis"),
    createdAt: toIsoString(thread.createdAt),
    updatedAt: toIsoString(thread.updatedAt),
  });
}

function sanitizeStoredTranscript(input: unknown): StoredUiTranscript {
  const record = asRecord(input);
  if (record?.version !== 1 || !Array.isArray(record.messages)) return emptyTranscript();
  const messages = record.messages.flatMap((message) => {
    const sanitized = sanitizeUiMessage(message);
    return sanitized === undefined ? [] : [sanitized];
  });
  return boundedTranscript(messages);
}

function sanitizeUiMessage(input: unknown): TesseraSessionMessage | undefined {
  const source = asRecord(input);
  if (!source || (source.role !== "user" && source.role !== "assistant") || !Array.isArray(source.parts)) {
    return undefined;
  }
  const messageId = `tessera-ui-${randomUUID()}`;
  const context: SanitizationContext = { messageId };
  const maximumText = source.role === "user" ? MAX_USER_TEXT_LENGTH : MAX_ASSISTANT_TEXT_LENGTH;
  let remainingText = maximumText;
  let remainingReasoning = MAX_REASONING_TEXT_LENGTH;
  const parts: TesseraUIMessage["parts"] = [];

  for (const sourcePart of source.parts.slice(0, MAX_UI_PARTS_PER_MESSAGE)) {
    const part = asRecord(sourcePart);
    if (!part || typeof part.type !== "string") continue;

    if (part.type === "text" && typeof part.text === "string" && remainingText > 0) {
      const text = sanitizeDisplayText(part.text, remainingText);
      if (!text) continue;
      remainingText -= text.length;
      parts.push({ type: "text", text });
      continue;
    }

    if (source.role !== "assistant") continue;
    if (part.type === "reasoning" && typeof part.text === "string" && remainingReasoning > 0) {
      const text = sanitizeDisplayText(part.text, remainingReasoning);
      if (!text) continue;
      remainingReasoning -= text.length;
      parts.push({
        type: "reasoning",
        id: `${messageId}-reasoning-${parts.length + 1}`,
        text,
        state: "done",
      });
      continue;
    }
    if (part.type === "tool-list_database") {
      parts.push(sanitizeListDatabaseToolPart(part, context, parts.length));
      continue;
    }
    if (part.type === "tool-list_catalog") {
      parts.push(sanitizeListCatalogToolPart(part, context, parts.length));
      continue;
    }
    if (part.type === "tool-execute_sql") {
      parts.push(sanitizeExecuteSqlToolPart(part, context, parts.length));
      continue;
    }
    if (part.type === "tool-run_analysis") {
      parts.push(sanitizeAnalysisToolPart(part, context, parts.length));
      continue;
    }
  }

  if (parts.length === 0) return undefined;
  return { id: messageId, role: source.role, parts };
}

function sanitizeListDatabaseToolPart(
  part: Record<string, unknown>,
  context: SanitizationContext,
  index: number,
): TesseraUIMessage["parts"][number] {
  const input = { action: "list_database" as const };
  const output = asRecord(part.output);
  const status = sanitizedToolStatus(output?.status);
  if (part.state !== "output-available" || status === "failed") {
    return {
      type: "tool-list_database",
      toolCallId: `${context.messageId}-tool-${index + 1}`,
      state: "output-error",
      input,
      errorText: HISTORY_TOOL_FAILURE,
      providerExecuted: true,
      title: "List database context",
    };
  }
  const scope = output?.scope === "current" || output?.scope === "schema" || output?.scope === "capabilities"
    ? output.scope
    : undefined;
  const entityCount = safeInteger(output?.entityCount, 0, 10_000);
  const tableCount = safeInteger(output?.tableCount, 0, 10_000);
  const columnCount = safeInteger(output?.columnCount, 0, 10_000);
  const foreignKeyCount = safeInteger(output?.foreignKeyCount, 0, 10_000);
  const componentCount = safeInteger(output?.componentCount, 0, 10_000);
  return {
    type: "tool-list_database",
    toolCallId: `${context.messageId}-tool-${index + 1}`,
    state: "output-available",
    input,
    output: {
      status,
      ...(scope === undefined ? {} : { scope }),
      ...(entityCount === undefined ? {} : { entityCount }),
      ...(tableCount === undefined ? {} : { tableCount }),
      ...(columnCount === undefined ? {} : { columnCount }),
      ...(foreignKeyCount === undefined ? {} : { foreignKeyCount }),
      ...(typeof output?.dialect === "string" ? { dialect: output.dialect.slice(0, 32) } : {}),
      ...(componentCount === undefined ? {} : { componentCount }),
      ...(typeof output?.truncated === "boolean" ? { truncated: output.truncated } : {}),
    },
    providerExecuted: true,
    title: "List database context",
  };
}

function sanitizeListCatalogToolPart(
  part: Record<string, unknown>,
  context: SanitizationContext,
  index: number,
): TesseraUIMessage["parts"][number] {
  const input = { action: "list_catalog" as const };
  const output = asRecord(part.output);
  const status = sanitizedToolStatus(output?.status);
  if (part.state !== "output-available" || status === "failed") {
    return {
      type: "tool-list_catalog",
      toolCallId: `${context.messageId}-tool-${index + 1}`,
      state: "output-error",
      input,
      errorText: HISTORY_TOOL_FAILURE,
      providerExecuted: true,
      title: "List data catalog",
    };
  }
  const mode = output?.mode === "search" || output?.mode === "describe" ? output.mode : undefined;
  const entityCount = safeInteger(output?.entityCount, 0, 10_000);
  return {
    type: "tool-list_catalog",
    toolCallId: `${context.messageId}-tool-${index + 1}`,
    state: "output-available",
    input,
    output: {
      status,
      ...(mode === undefined ? {} : { mode }),
      ...(entityCount === undefined ? {} : { entityCount }),
      ...(typeof output?.truncated === "boolean" ? { truncated: output.truncated } : {}),
    },
    providerExecuted: true,
    title: "List data catalog",
  };
}

function sanitizeExecuteSqlToolPart(
  part: Record<string, unknown>,
  context: SanitizationContext,
  index: number,
): TesseraUIMessage["parts"][number] {
  const input = { action: "execute_sql" as const };
  const output = asRecord(part.output);
  const status = output?.status === "approval_required" ? "approval_required" : sanitizedToolStatus(output?.status);
  if (part.state !== "output-available" || status === "failed") {
    return {
      type: "tool-execute_sql",
      toolCallId: `${context.messageId}-tool-${index + 1}`,
      state: "output-error",
      input,
      errorText: HISTORY_TOOL_FAILURE,
      providerExecuted: true,
      title: "Execute SQL",
    };
  }
  const mode = output?.mode === "read" || output?.mode === "mutation" ? output.mode : undefined;
  const rowCount = safeInteger(output?.rowCount, 0, 10_000);
  const affectedRows = safeInteger(output?.affectedRows, 0, 10_000);
  const requestId = safeOpaqueHandle(output?.requestId);
  const checkpointId = safeOpaqueHandle(output?.checkpointId);
  return {
    type: "tool-execute_sql",
    toolCallId: `${context.messageId}-tool-${index + 1}`,
    state: "output-available",
    input,
    output: {
      status,
      ...(mode === undefined ? {} : { mode }),
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(affectedRows === undefined ? {} : { affectedRows }),
      ...(typeof output?.truncated === "boolean" ? { truncated: output.truncated } : {}),
      ...(status === "approval_required" && requestId !== undefined && checkpointId !== undefined
        ? { requestId, checkpointId }
        : {}),
    },
    providerExecuted: true,
    title: "Execute SQL",
  };
}

function sanitizedToolStatus(value: unknown): "completed" | "blocked" | "failed" {
  if (value === "completed" || value === "blocked" || value === "failed") return value;
  return value === "unavailable" || value === "rejected" ? "blocked" : "failed";
}

function safeOpaqueHandle(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function sanitizeAnalysisToolPart(
  part: Record<string, unknown>,
  context: SanitizationContext,
  index: number,
): TesseraUIMessage["parts"][number] {
  const input = { action: "run_governed_analysis" as const };
  const output = asRecord(part.output);
  const status = output?.status === "completed" || output?.status === "blocked" || output?.status === "failed"
    ? output.status
    : "failed";
  if (part.state !== "output-available" || status === "failed") {
    return {
      type: "tool-run_analysis",
      toolCallId: `${context.messageId}-tool-${index + 1}`,
      state: "output-error",
      input,
      errorText: HISTORY_TOOL_FAILURE,
      providerExecuted: true,
      title: "Run governed analysis",
    };
  }
  const rowCount = safeInteger(output?.rowCount, 0, 10_000);
  return {
    type: "tool-run_analysis",
    toolCallId: `${context.messageId}-tool-${index + 1}`,
    state: "output-available",
    input,
    output: {
      status,
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(typeof output?.truncated === "boolean" ? { truncated: output.truncated } : {}),
    },
    providerExecuted: true,
    title: "Run governed analysis",
  };
}

function boundedTranscript(messages: readonly TesseraSessionMessage[]): StoredUiTranscript {
  const bounded = messages.slice(-MAX_UI_MESSAGES);
  while (bounded.length > 0 && jsonByteLength({ version: 1, messages: bounded }) > MAX_UI_TRANSCRIPT_BYTES) {
    bounded.shift();
  }
  return Object.freeze({ version: 1, messages: Object.freeze(bounded) });
}

function emptyTranscript(): StoredUiTranscript {
  return Object.freeze({ version: 1, messages: Object.freeze([]) });
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizeDisplayText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value
    .replace(/```sql\b[\s\S]*?```/gi, "```text\n[SQL omitted from session history]\n```")
   .replace(/\b(?:postgres(?:ql)?|mysql|libsql|turso|sqlite|mongodb(?:\+srv)?):\/\/[^\s<>\"'`]+/gi, "[database connection redacted]")
   .replace(/\bfile:[^\s<>\"'`]+/gi, "[database connection redacted]")
    .replace(/\b(?:sk-or-v1|sk-proj|sk-ant|sk-live|sk-test)-[A-Za-z0-9_-]{8,}\b/g, "[credential redacted]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  if (!sanitized) return undefined;
  return sanitized.slice(0, Math.max(0, maximum));
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError("Tessera Studio session storage is unavailable.");
  }
  chmodSync(path, 0o700);
}

function normalizeThreadTitle(value: string): string {
  const compact = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "New analysis";
  return compact.slice(0, MAX_THREAD_TITLE_LENGTH);
}

function toIsoString(value: Date): string {
  return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isSafeFileName(value: string): boolean {
  return value.length > 0 && value === value.split(/[\\/]/).at(-1) && value !== "." && value !== "..";
}
