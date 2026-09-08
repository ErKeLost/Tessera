import { toAISdkStream } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import type { FinishReason } from "ai";
import { z } from "zod";
import type {
  TesseraAgentCoreOptions,
  TesseraAgentDiagnostic,
  TesseraAgentEvent,
  TesseraAgentIdentity,
  TesseraAgentRun,
  TesseraAgentRunInput,
  TesseraAgentRunner,
  TesseraAgentToolName,
} from "./contracts";
import { tesseraAgentIdentitySchema } from "./contracts";
import { boundedDisplayText, publicEvidence } from "./evidence";
import { tesseraAgentResourceId } from "./identity";
import {
  createTesseraCopilotRuntime,
  createTesseraDataCopilotAgent,
  type TesseraCopilotRuntime,
} from "./mastra-agent";
import { tesseraWorkingMemoryOptions } from "./memory";
import { modelReasoningOptions } from "./model-config";
import { buildCurrentDateSystemMessage } from "./prompt";
import type {
  TesseraExecuteSqlToolOutput,
  TesseraListDatabaseToolOutput,
  TesseraPrepareAnalysisToolOutput,
  TesseraSearchDataContextToolOutput,
  TesseraUIMessageChunk,
} from "./protocol";
import { createTesseraRequestContext } from "./request-context";

const GENERIC_PUBLIC_STREAM_ERROR = "The Tessera Agent stream could not be processed.";

export type TesseraAgentPublicError = Readonly<{
  message: string;
  phase: "provider" | "stream";
}>;

export type TesseraAgentPublicErrorContext = Readonly<{
  error: unknown;
  model: string;
}>;

export type CreateTesseraAgentOptions = TesseraAgentCoreOptions & Readonly<{
  /** Host-owned mapping for provider-aware public errors. Raw errors stay server-side. */
  mapPublicError?: (
    context: TesseraAgentPublicErrorContext,
  ) => TesseraAgentPublicError;
}>;

export interface TesseraAgent extends TesseraAgentRunner {
  stream: NonNullable<TesseraAgentRunner["stream"]>;
  /** Native AI SDK v7 stream preserving Markdown, tool, and suspension parts. */
  streamUI(input: TesseraAgentRunInput): ReadableStream<TesseraUIMessageChunk>;
}

/**
 * Creates the headless Tessera Agent boundary. Environment parsing, HTTP/SSE,
 * public provider diagnostics, and database mutation policy remain Host-owned.
 */
export function createTesseraAgent(options: CreateTesseraAgentOptions): TesseraAgent {
  const queue = createThreadQueue();

  return {
    run: (input) => queue.run(threadQueueKey(options, input), async () => {
      const enriched = await withContinualContext(options, input);
      const run = await runTesseraAgentTurn(options, enriched);
      submitContinualTurn(options, enriched, run.message);
      return run;
    }),
    stream: (input, emit) => queue.run(threadQueueKey(options, input), async () => {
      const enriched = await withContinualContext(options, input);
      const run = await streamTesseraAgentTurn(options, enriched, emit);
      submitContinualTurn(options, enriched, run.message);
      return run;
    }),
    streamUI: (input) => streamTesseraAgentTurnUI(
      options,
      input,
      queue,
    ),
  };
}

async function runTesseraAgentTurn(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
): Promise<TesseraAgentRun> {
  const runtime = createTesseraCopilotRuntime();
  const agent = createAgentForTurn(options, input, runtime);
  const output = await agent.stream(
    agentUserContent(input),
    generationOptions(options, input),
  );
  const result = await consumeCopilotUIStream(
    appendCopilotOutcome(
      filterTesseraPublicToolParts(toPublicUIStream(options, input, output)),
    ),
  );
  const message = safeAssistantNarration(result.response)
    ?? assistantNarrationFromOutput(output);
  if (result.aborted || input.signal.aborted) throw createAbortError();
  if (result.failed
    || result.finishReason !== "stop"
    || !message) {
    throw new Error("The Tessera Agent did not return a usable response.");
  }
  return runFrom(runtime, message);
}

/** Streams the Agent to simple event consumers without replaying accumulated text. */
async function streamTesseraAgentTurn(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  emit: (event: TesseraAgentEvent) => void | Promise<void>,
): Promise<TesseraAgentRun> {
  const runtime = createTesseraCopilotRuntime();
  const agent = createAgentForTurn(options, input, runtime);
  const output = await agent.stream(
    agentUserContent(input),
    generationOptions(options, input),
  );
  const source = appendCopilotOutcome(
    filterTesseraPublicToolParts(toPublicUIStream(options, input, output)),
  );
  const activeTools = new Map<string, TesseraAgentToolName>();
  const result = await consumeCopilotUIStream(source, async (chunk) => {
    if (chunk.type === "text-delta") {
      await emit({ type: "text-delta", text: chunk.delta });
      return;
    }
    if (chunk.type === "error"
      || (chunk.type === "finish" && chunk.finishReason === "error")) {
      return;
    }
    await emitLegacyToolEvent(chunk, activeTools, emit);
  });

  const message = safeAssistantNarration(result.response)
    ?? assistantNarrationFromOutput(output);
  if (result.aborted || input.signal.aborted) throw createAbortError();
  if (result.failed
    || result.finishReason !== "stop"
    || !message) {
    throw new Error("The Tessera Agent did not return a usable response.");
  }
  return runFrom(runtime, message);
}

function streamTesseraAgentTurnUI(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  queue: ReturnType<typeof createThreadQueue>,
): ReadableStream<TesseraUIMessageChunk> {
  const controller = new AbortController();
  let cancelled = false;
  let started = false;
  let sourceReader: ReadableStreamDefaultReader<TesseraUIMessageChunk> | undefined;
  const cancelSourceReader = () => {
    void sourceReader?.cancel().catch(() => undefined);
  };

  return new ReadableStream<TesseraUIMessageChunk>({
    start(streamController) {
      const abort = () => {
        controller.abort();
        cancelSourceReader();
      };
      if (input.signal.aborted) {
        cancelled = true;
        controller.abort();
        streamController.close();
        return;
      }
      input.signal.addEventListener("abort", abort, { once: true });
      void queue.run(threadQueueKey(options, input), async () => {
        const runtime = createTesseraCopilotRuntime();
        try {
          // The request may be cancelled while an earlier turn owns the queue.
          if (controller.signal.aborted) return;
          const enrichedInput = await withContinualContext(options, {
            ...input,
            signal: controller.signal,
            allowRuntimeSuspension: true,
          });
          const agent = createAgentForTurn(options, enrichedInput, runtime);
          const resumed = input.resumeData === undefined
            ? undefined
            : await resolvePendingMutationResume(options, agent, input);
          const executionInput = resumed === undefined
            ? enrichedInput
            : {
                ...enrichedInput,
                runId: resumed.runId,
                toolCallId: resumed.toolCallId,
                resumeData: resumed.resumeData,
                signal: controller.signal,
              };
          const output = input.resumeData === undefined
            ? await agent.stream(
                agentUserContent(enrichedInput),
                generationOptions(options, executionInput),
              )
            : await agent.resumeStream(
                executionInput.resumeData,
                generationOptions(options, executionInput),
              );
          const source = appendCopilotOutcome(
            normalizeTesseraToolInvocationOrder(filterTesseraPublicToolParts(toPublicUIStream(options, input, output))),
          );
          const reader = source.getReader();
          sourceReader = reader;
          try {
            if (controller.signal.aborted) {
              await reader.cancel();
              return;
            }
            while (true) {
              const next = await reader.read();
              if (cancelled || controller.signal.aborted || next.done) break;
              if (next.value.type === "start") started = true;
              streamController.enqueue(next.value);
            }
          } finally {
            sourceReader = undefined;
            reader.releaseLock();
          }
        } catch (error) {
          if (!cancelled && !controller.signal.aborted) {
            const publicError = reportPublicStreamError(options, input, error);
            if (!started) {
              streamController.enqueue({
                type: "start",
                messageId: `message-${input.runId}`,
              });
            }
            streamController.enqueue({ type: "error", errorText: publicError.message });
            streamController.enqueue({ type: "finish", finishReason: "error" });
          }
        } finally {
          input.signal.removeEventListener("abort", abort);
          if (!cancelled) streamController.close();
        }
      });
    },
    cancel() {
      cancelled = true;
      controller.abort();
      cancelSourceReader();
    },
  });
}

const pendingMutationResumeSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  requestId: z.string().min(1).max(512),
  checkpointId: z.string().min(1).max(512),
}).strict();

const pendingMutationSuspendPayloadSchema = z.object({
  requestId: z.string().min(1).max(512),
  checkpointId: z.string().min(1).max(512),
}).passthrough();

export class PendingMutationResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingMutationResumeError";
  }
}

/** Resolves a browser decision against Mastra's storage-backed suspension. */
async function resolvePendingMutationResume(
  options: CreateTesseraAgentOptions,
  agent: Agent,
  input: TesseraAgentRunInput,
): Promise<Readonly<{
  runId: string;
  toolCallId: string;
  resumeData: z.infer<typeof pendingMutationResumeSchema>;
}>> {
  const requestedResume = pendingMutationResumeSchema.safeParse(input.resumeData);
  if (!requestedResume.success || input.toolCallId === undefined) {
    throw new PendingMutationResumeError("This database approval request is invalid.");
  }

  const identity = identityFor(options, input);
  const { runs } = await agent.listSuspendedRuns({
    threadId: input.threadId,
    resourceId: resourceIdFor(options, identity),
  });
  const matches = runs.flatMap((run) => run.toolCalls.flatMap((toolCall) => {
    const toolCallId = toolCall.toolCallId;
    if (toolCallId === undefined
      || toolCallId !== input.toolCallId
      || toolCall.toolName !== "execute_sql"
      || toolCall.requiresApproval) {
      return [];
    }
    const suspendPayload = pendingMutationSuspendPayloadSchema.safeParse(
      toolCall.suspendPayload,
    );
    return suspendPayload.success
      ? [{ runId: run.runId, toolCallId, suspendPayload: suspendPayload.data }]
      : [];
  }));

  if (matches.length === 0) {
    throw new PendingMutationResumeError(
      "This database approval is no longer pending. It may already have been completed, rejected, or expired.",
    );
  }
  if (matches.length > 1) {
    throw new PendingMutationResumeError(
      "The database approval could not be uniquely identified. Please retry the original action.",
    );
  }

  const match = matches[0]!;
  return {
    runId: match.runId,
    toolCallId: match.toolCallId,
    resumeData: {
      decision: requestedResume.data.decision,
      requestId: match.suspendPayload.requestId,
      checkpointId: match.suspendPayload.checkpointId,
    },
  };
}

/**
 * Mastra can suspend a tool after streaming its arguments but before emitting
 * the regular tool-call part. Materialize the public invocation first so a UI
 * can later attach the resumed output to a stable tool call.
 */
export function normalizeTesseraToolInvocationOrder(
  source: ReadableStream<TesseraUIMessageChunk>,
): ReadableStream<TesseraUIMessageChunk> {
  const startedTools = new Map<string, TesseraAgentToolName>();
  const availableTools = new Set<string>();

  return source.pipeThrough(
    new TransformStream<TesseraUIMessageChunk, TesseraUIMessageChunk>({
      transform(chunk, controller) {
        const publishInput = (
          toolCallId: string,
          toolName: TesseraAgentToolName,
        ) => {
          if (availableTools.has(toolCallId)) return;
          availableTools.add(toolCallId);
          controller.enqueue({
            type: "tool-input-available",
            toolCallId,
            toolName,
            input: publicTesseraToolInput(toolName),
            providerExecuted: true,
          } as TesseraUIMessageChunk);
        };

        if (chunk.type === "tool-input-start") {
          const toolName = asTesseraToolName(chunk.toolName);
          if (toolName !== undefined) {
            startedTools.set(chunk.toolCallId, toolName);
          }
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type === "tool-input-available") {
          const toolName = asTesseraToolName(chunk.toolName);
          if (toolName !== undefined) {
            startedTools.set(chunk.toolCallId, toolName);
            if (availableTools.has(chunk.toolCallId)) return;
            availableTools.add(chunk.toolCallId);
          }
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type === "data-tool-call-suspended") {
          const data = isRecord(chunk.data) ? chunk.data : undefined;
          const toolCallId = typeof data?.toolCallId === "string"
            ? data.toolCallId
            : undefined;
          const toolName = asTesseraToolName(data?.toolName)
            ?? (toolCallId === undefined ? undefined : startedTools.get(toolCallId));
          if (toolCallId !== undefined && toolName !== undefined) {
            startedTools.set(toolCallId, toolName);
            publishInput(toolCallId, toolName);
          }
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

/** Keeps Mastra's memory-management tools private to the Agent runtime. */
export function filterTesseraPublicToolParts(
  source: ReadableStream<TesseraUIMessageChunk>,
): ReadableStream<TesseraUIMessageChunk> {
  const internalToolCalls = new Set<string>();

  return source.pipeThrough(
    new TransformStream<TesseraUIMessageChunk, TesseraUIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === "tool-input-start"
          || chunk.type === "tool-input-available") {
          if (asTesseraToolName(chunk.toolName) === undefined) {
            internalToolCalls.add(chunk.toolCallId);
            return;
          }
        }

        if ((chunk.type === "tool-input-delta"
          || chunk.type === "tool-input-error"
          || chunk.type === "tool-output-available"
          || chunk.type === "tool-output-error")
          && internalToolCalls.has(chunk.toolCallId)) {
          if (chunk.type === "tool-input-error"
            || chunk.type === "tool-output-available"
            || chunk.type === "tool-output-error") {
            internalToolCalls.delete(chunk.toolCallId);
          }
          return;
        }

        controller.enqueue(chunk);
      },
    }),
  );
}

/** Validates a terminal answer without consuming Mastra's fullStream twice. */
export function appendCopilotOutcome(
  source: ReadableStream<TesseraUIMessageChunk>,
): ReadableStream<TesseraUIMessageChunk> {
  let terminal = false;
  let hasVisibleText = false;
  let response = "";
  let suspended = false;
  let pendingError:
    | Extract<TesseraUIMessageChunk, { type: "error" }>
    | undefined;

  return source.pipeThrough(
    new TransformStream<TesseraUIMessageChunk, TesseraUIMessageChunk>({
      async transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          response += chunk.delta;
          hasVisibleText ||= hasVisibleCopilotText(chunk.delta);
        }

        if (chunk.type === "data-tool-call-suspended") {
          suspended = true;
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type === "error") {
          // Tool-call validation errors may be recovered by a later model step.
          pendingError = chunk;
          return;
        }

        if (chunk.type === "abort") {
          terminal = true;
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type === "finish" && !terminal) {
          terminal = true;
          if (suspended || (chunk.finishReason as string | undefined) === "suspended") {
            controller.enqueue(chunk);
            return;
          }

          if (chunk.finishReason !== "stop") {
            controller.enqueue(pendingError ?? {
              type: "error",
              errorText: chunk.finishReason === "error"
                ? "The Tessera Agent could not complete this analysis."
                : "The Tessera Agent stopped before it returned a complete response.",
            });
            controller.enqueue(chunk);
            return;
          }

          if (!hasVisibleText) {
            controller.enqueue(pendingError ?? {
              type: "error",
              errorText: "The Tessera Agent stopped before it returned a visible response.",
            });
            controller.enqueue({ type: "finish", finishReason: "error" });
            return;
          }

          const message = hasVisibleText
            ? safeAssistantNarration(response)
            : undefined;
          if (hasVisibleText && !message) {
            controller.enqueue({
              type: "error",
              errorText: "The Tessera Agent stopped before it returned a usable response.",
            });
            controller.enqueue({ type: "finish", finishReason: "error" });
            return;
          }

        }

        controller.enqueue(chunk);
      },
      flush(controller) {
        // A runtime suspension may close without a conventional finish part.
        if (terminal || suspended) return;
        terminal = true;
        controller.enqueue(pendingError ?? {
          type: "error",
          errorText: "The Tessera Agent stream ended before it returned a terminal response.",
        });
        controller.enqueue({ type: "finish", finishReason: "error" });
      },
    }),
  );
}

/** Reads a UI stream once and preserves provider text deltas in order. */
async function consumeCopilotUIStream(
  source: ReadableStream<TesseraUIMessageChunk>,
  onChunk?: (chunk: TesseraUIMessageChunk) => void | Promise<void>,
): Promise<Readonly<{
  response: string;
  failed: boolean;
  aborted: boolean;
  finishReason?: FinishReason;
}>> {
  const reader = source.getReader();
  let response = "";
  let failed = false;
  let aborted = false;
  let finishReason: FinishReason | undefined;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "text-delta") response += chunk.delta;
      if (chunk.type === "error") failed = true;
      if (chunk.type === "abort") aborted = true;
      if (chunk.type === "finish") {
        finishReason = chunk.finishReason;
        if (chunk.finishReason !== undefined && chunk.finishReason !== "stop") {
          failed = true;
        }
      }
      await onChunk?.(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    response,
    failed,
    aborted,
    ...(finishReason === undefined ? {} : { finishReason }),
  };
}

async function emitLegacyToolEvent(
  chunk: TesseraUIMessageChunk,
  activeTools: Map<string, TesseraAgentToolName>,
  emit: (event: TesseraAgentEvent) => void | Promise<void>,
): Promise<void> {
  if (chunk.type === "tool-input-start"
    || chunk.type === "tool-input-available") {
    const tool = asTesseraToolName(chunk.toolName);
    if (tool === undefined) return;
    const previous = activeTools.get(chunk.toolCallId);
    activeTools.set(chunk.toolCallId, tool);
    if (previous === undefined) {
      await emit({ type: "tool", tool, state: "started" });
    }
    return;
  }

  if (chunk.type === "tool-input-error" || chunk.type === "tool-output-error") {
    const tool = activeTools.get(chunk.toolCallId);
    if (tool !== undefined) {
      activeTools.delete(chunk.toolCallId);
      await emit({ type: "tool", tool, state: "failed" });
    }
    return;
  }

  if (chunk.type === "tool-output-available") {
    const tool = activeTools.get(chunk.toolCallId);
    if (tool === undefined) return;
    activeTools.delete(chunk.toolCallId);
    await emit({ type: "tool", tool, state: legacyToolState(chunk.output) });
  }
}

function asTesseraToolName(value: unknown): TesseraAgentToolName | undefined {
  return value === "list_database"
    || value === "search_data_context"
    || value === "execute_sql"
    || value === "prepare_analysis"
    ? value
    : undefined;
}

function legacyToolState(
  output: unknown,
): Extract<TesseraAgentEvent, { type: "tool" }>["state"] {
  if (!isRecord(output)) return "completed";
  return output.status === "blocked" || output.status === "failed"
    ? output.status
    : output.status === "unavailable"
      ? "blocked"
      : "completed";
}

function publicTesseraToolInput(
  tool: TesseraAgentToolName,
): Record<string, string> {
  if (tool === "list_database") return { action: "list_database" };
  if (tool === "search_data_context") return { action: "search_data_context" };
  if (tool === "execute_sql") return { action: "execute_sql" };
  return { action: "prepare_analysis" };
}

function createAgentForTurn(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  runtime: TesseraCopilotRuntime,
): Agent {
  return createTesseraDataCopilotAgent({
    input,
    dataAgent: options.dataAgent,
    memory: options.memory,
    model: options.model,
    llm: options.llm,
    mastra: options.mastra,
    runtime,
    defaultIdentity: options.defaultIdentity,
    ...(options.formatError === undefined
      ? {}
      : { formatError: options.formatError }),
    ...(options.permissionContext === undefined
      ? {}
      : { permissionContext: options.permissionContext }),
    ...(options.databaseActions === undefined
      ? {}
      : { databaseActions: options.databaseActions }),
    databaseDialect: options.databaseDialect ?? options.dataAgent.dialect,
  });
}

function generationOptions(
  options: CreateTesseraAgentOptions,
  input: Pick<
    TesseraAgentRunInput,
    | "runId"
    | "signal"
    | "threadId"
    | "identity"
    | "turnContext"
    | "runtimeSignals"
    | "toolCallId"
  >,
) {
  return {
    abortSignal: input.signal,
    runId: input.runId,
    system: buildCurrentDateSystemMessage(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    toolCallConcurrency: 1,
    memory: memoryOptionsFor(options, input),
    savePerStep: true,
    requestContext: createTesseraRequestContext(input),
    maxSteps: options.llm.maxSteps,
    modelSettings: {
      maxOutputTokens: options.llm.maxOutputTokens,
      temperature: options.llm.temperature,
    },
    ...modelReasoningOptions(options.llm),
  };
}

function agentUserContent(
  input: Pick<TesseraAgentRunInput, "message" | "images">,
) {
  if (!input.images?.length) return input.message;
  return [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: input.message },
      ...input.images.map((image) => ({
        type: "image" as const,
        image: image.dataUrl,
        mimeType: image.mediaType,
      })),
    ],
  }];
}

function memoryOptionsFor(
  options: CreateTesseraAgentOptions,
  input: Pick<TesseraAgentRunInput, "threadId" | "identity">,
) {
  return {
    thread: input.threadId,
    resource: resourceIdFor(options, identityFor(options, input)),
    options: {
      semanticRecall: false,
      workingMemory: tesseraWorkingMemoryOptions,
      observationalMemory: false,
    },
  } as const;
}

function toPublicUIStream(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  output: Awaited<ReturnType<Agent["stream"]>>,
): ReadableStream<TesseraUIMessageChunk> {
  const source = toAISdkStream(output, {
    from: "agent",
    sendReasoning: true,
    version: "v7",
    onError: (error) => reportPublicStreamError(options, input, error).message,
  }) as ReadableStream<TesseraUIMessageChunk>;
  return source;
}

function reportPublicStreamError(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  error: unknown,
): TesseraAgentPublicError {
  let mapped: TesseraAgentPublicError | undefined;
  try {
    mapped = validatePublicError(options.mapPublicError?.({
      error,
      model: options.llm.model,
    }));
  } catch (mappingError) {
    reportDiagnostic(input, {
      phase: "stream",
      error: mappingError,
      reason: "public_error_mapping_failed",
    });
  }

  const publicError = mapped ?? {
    message: GENERIC_PUBLIC_STREAM_ERROR,
    phase: "stream" as const,
  };
  reportDiagnostic(input, { phase: publicError.phase, error });
  return publicError;
}

function validatePublicError(value: unknown): TesseraAgentPublicError | undefined {
  if (!isRecord(value)
    || (value.phase !== "provider" && value.phase !== "stream")) {
    return undefined;
  }
  const message = boundedDisplayText(value.message, 2_000);
  return message === undefined ? undefined : { message, phase: value.phase };
}

function reportDiagnostic(
  input: TesseraAgentRunInput,
  diagnostic: TesseraAgentDiagnostic,
): void {
  try {
    input.reportDiagnostic?.(diagnostic);
  } catch {
    // Diagnostics must never alter an Agent result or stream.
  }
}

async function withContinualContext(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
): Promise<TesseraAgentRunInput> {
  const continual = options.continualHarness;
  if (continual === undefined) return input;
  const identity = identityFor(options, input);
  const context = await continual.contextFor({
    resourceId: resourceIdFor(options, identity),
    threadId: input.threadId,
  });
  if (!context) return input;
  return {
    ...input,
    runtimeSignals: [...(input.runtimeSignals ?? []), context],
  };
}

function submitContinualTurn(
  options: CreateTesseraAgentOptions,
  input: TesseraAgentRunInput,
  assistantText: string,
): void {
  const continual = options.continualHarness;
  if (continual === undefined) return;
  const identity = identityFor(options, input);
  continual.submitCompletedTurn({
    runId: input.runId,
    resourceId: resourceIdFor(options, identity),
    threadId: input.threadId,
    userText: input.message,
    assistantText,
  });
}

function identityFor(
  options: CreateTesseraAgentOptions,
  input: Pick<TesseraAgentRunInput, "identity">,
): TesseraAgentIdentity {
  return tesseraAgentIdentitySchema.parse(
    input.identity ?? options.defaultIdentity,
  );
}

function resourceIdFor(
  options: CreateTesseraAgentOptions,
  identity: TesseraAgentIdentity,
): string {
  return options.resourceIdForIdentity?.(identity)
    ?? tesseraAgentResourceId(identity);
}

/** An empty or whitespace-only turn is not a visible response. */
export function hasVisibleCopilotText(value: string): boolean {
  return value.trim().length > 0;
}

export function hasVisibleCopilotOutput(value: unknown): boolean {
  const message = isRecord(value) ? value : undefined;
  if (message?.role !== "assistant" || !Array.isArray(message.parts)) return false;
  return message.parts.some((part) => {
    const record = isRecord(part) ? part : undefined;
    return record?.type === "text"
      && typeof record.text === "string"
      && hasVisibleCopilotText(record.text);
  });
}

/** Normalize empty answers while preserving the model's Markdown verbatim. */
export function safeAssistantNarration(
  value: string | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

export function publicToolOutput(
  tool: TesseraAgentToolName,
  status: "completed" | "blocked" | "failed",
  rawOutput: unknown,
): TesseraListDatabaseToolOutput
  | TesseraSearchDataContextToolOutput
  | TesseraExecuteSqlToolOutput
  | TesseraPrepareAnalysisToolOutput {
  const output = isRecord(rawOutput) ? rawOutput : {};

  if (tool === "list_database") {
    const operation = output.operation === "list_relations"
      || output.operation === "describe_schema"
      || output.operation === "describe_relation"
      || output.operation === "current_relation"
      || output.operation === "capabilities"
      || output.operation === "extensions"
      || output.operation === "rls_policies"
      ? output.operation
      : undefined;
    const schema = isRecord(output.schema) ? output.schema : undefined;
    const tables = Array.isArray(schema?.tables) ? schema.tables : undefined;
    const entityCount = safeInteger(output.entityCount, 0, 10_000);
    const schemaCount = safeInteger(output.schemaCount, 0, 10_000);
    const relationCount = safeInteger(output.relationCount, 0, 10_000);
    const tableCount = safeInteger(
      output.tableCount ?? tables?.length,
      0,
      10_000,
    );
    const countTableItems = (field: "columns" | "foreignKeys" | "indexes") =>
      tables?.reduce((count, table) => {
        const record = isRecord(table) ? table : undefined;
        return count + (record && Array.isArray(record[field])
          ? record[field].length
          : 0);
      }, 0);
    const columnCount = safeInteger(
      output.columnCount ?? countTableItems("columns"),
      0,
      10_000,
    );
    const foreignKeyCount = safeInteger(
      output.foreignKeyCount ?? countTableItems("foreignKeys"),
      0,
      10_000,
    );
    const indexCount = safeInteger(
      output.indexCount ?? countTableItems("indexes"),
      0,
      10_000,
    );
    const components = Array.isArray(output.components)
      ? output.components
      : undefined;
    const extensions = Array.isArray(output.extensions)
      ? output.extensions
      : undefined;
    const relations = Array.isArray(output.relations)
      ? output.relations
      : undefined;
    const extensionCount = safeInteger(
      output.extensionCount ?? extensions?.length,
      0,
      10_000,
    );
    const installedCount = safeInteger(
      output.installedCount ?? extensions?.filter(
        (extension) => isRecord(extension) && extension.installed === true,
      ).length,
      0,
      10_000,
    );
    const policyCount = safeInteger(output.policyCount, 0, 10_000);
    const dialect = typeof output.dialect === "string"
      ? output.dialect
      : undefined;
    const reason = boundedDisplayText(output.reason, 128);
    const message = boundedDisplayText(output.message, 500);

    return {
      status,
      ...(operation === undefined ? {} : { operation }),
      ...(entityCount === undefined ? {} : { entityCount }),
      ...(schemaCount === undefined ? {} : { schemaCount }),
      ...(relationCount === undefined ? {} : { relationCount }),
      ...(tableCount === undefined ? {} : { tableCount }),
      ...(columnCount === undefined ? {} : { columnCount }),
      ...(foreignKeyCount === undefined ? {} : { foreignKeyCount }),
      ...(indexCount === undefined ? {} : { indexCount }),
      ...(dialect === undefined ? {} : { dialect }),
      ...(components === undefined
        ? {}
        : { componentCount: Math.min(256, components.length) }),
      ...(extensionCount === undefined ? {} : { extensionCount }),
      ...(installedCount === undefined ? {} : { installedCount }),
      ...(relations === undefined
        ? {}
        : { relationCount: Math.min(512, relations.length) }),
      ...(policyCount === undefined ? {} : { policyCount }),
      ...(output.catalogCoverage === "complete"
        || output.catalogCoverage === "partial"
        || output.catalogCoverage === "unknown"
        ? { catalogCoverage: output.catalogCoverage }
        : {}),
      ...(output.truncated === true ? { truncated: true } : {}),
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
    };
  }

  if (tool === "search_data_context") {
    const mode = output.mode === "search" || output.mode === "describe"
      ? output.mode
      : undefined;
    const entityCount = safeInteger(output.entityCount, 0, 10_000);
    const reason = boundedDisplayText(output.reason, 128);
    const message = boundedDisplayText(output.message, 500);
    return {
      status,
      ...(mode === undefined ? {} : { mode }),
      ...(entityCount === undefined ? {} : { entityCount }),
      ...(output.truncated === true ? { truncated: true } : {}),
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
    };
  }

  if (tool === "execute_sql") {
    const mode = output.mode === "read"
      || output.mode === "analysis"
      || output.mode === "mutation"
      ? output.mode
      : undefined;
    const toolStatus = output.status === "approval_required"
      ? "approval_required"
      : status;
    const rowCount = safeInteger(output.rowCount, 0, 20_000);
    const affectedRows = safeInteger(output.affectedRows, 0, 10_000);
    const requestId = boundedDisplayText(output.requestId, 256);
    const checkpointId = boundedDisplayText(output.checkpointId, 256);
    const reason = boundedDisplayText(output.reason, 128);
    const message = boundedDisplayText(output.message, 500);
    const nextAction = boundedDisplayText(output.nextAction, 64);
    return {
      status: toolStatus,
      ...(mode === undefined ? {} : { mode }),
      ...(rowCount === undefined ? {} : { rowCount }),
      ...(affectedRows === undefined ? {} : { affectedRows }),
      ...(output.truncated === true ? { truncated: true } : {}),
      ...(toolStatus !== "approval_required"
        || requestId === undefined
        || checkpointId === undefined
        ? {}
        : { requestId, checkpointId }),
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
      ...(nextAction === undefined ? {} : { nextAction }),
    };
  }

  if (tool === "prepare_analysis") {
    const reason = boundedDisplayText(output.reason, 128);
    const message = boundedDisplayText(output.message, 500);
    return {
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(message === undefined ? {} : { message }),
    };
  }

  return { status };
}

function runFrom(
  runtime: TesseraCopilotRuntime,
  message: string,
): TesseraAgentRun {
  return {
    status: "completed",
    message,
    evidence: runtime.analyses.map(publicEvidence),
  };
}

function assistantNarrationFromOutput(
  output: Awaited<ReturnType<Agent["stream"]>>,
): string | undefined {
  const messages = output.messageList.get.all.db();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const safe = safeAssistantNarration(text);
    if (safe !== undefined) return safe;
  }
  return undefined;
}

function threadQueueKey(
  options: CreateTesseraAgentOptions,
  input: Pick<TesseraAgentRunInput, "threadId" | "identity">,
): string {
  const identity = identityFor(options, input);
  return JSON.stringify([resourceIdFor(options, identity), input.threadId]);
}

function createAbortError(): DOMException {
  return new DOMException("The Tessera Agent stream was aborted.", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum
    ? value
    : undefined;
}

function createThreadQueue() {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release: (() => void) | undefined;
      const tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chained = previous.then(() => tail);
      tails.set(key, chained);
      await previous;
      try {
        return await work();
      } finally {
        release?.();
        if (tails.get(key) === chained) tails.delete(key);
      }
    },
  };
}
