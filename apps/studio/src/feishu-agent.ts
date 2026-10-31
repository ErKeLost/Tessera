import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Memory } from "@mastra/memory";
import {
  createTesseraFeishuCopilotAgent,
  createTesseraFeishuCopilotRuntime,
  feishuAISdkStream,
  feishuEvidence,
  feishuMemoryOptions,
  feishuUserContent,
  type TesseraAgent,
  type TesseraAgentIdentity,
  type TesseraAgentLlmConfig,
  type TesseraAgentRun,
  type TesseraAgentRunInput,
  type TesseraFeishuReader,
  type TesseraUIMessageChunk,
} from "@open-tessera/agent";
import { modelReasoningOptions, buildCurrentDateSystemMessage, appendCopilotOutcome } from "@open-tessera/agent";
import { tesseraSessionResourceId } from "./session-memory";
import { publicStudioStreamError } from "./studio-logger";

export type TesseraStudioFeishuAgentOptions = Readonly<{
  reader: TesseraFeishuReader;
  memory: Memory;
  llm: TesseraAgentLlmConfig;
  model: MastraModelConfig;
  mastra?: Mastra;
  defaultIdentity: TesseraAgentIdentity;
}>;

export type TesseraStudioFeishuAgent = TesseraAgent & Readonly<{
  agentType: "feishu";
}>;

/**
 * Studio adapter for the Feishu-specific Mastra Agent. It implements the same
 * transport contract as the database Agent so the existing Chat UI can render
 * either source without knowing which tool set is active.
 */
export function createTesseraStudioFeishuAgent(
  options: TesseraStudioFeishuAgentOptions,
): TesseraStudioFeishuAgent {
  const mastra = options.mastra ?? new Mastra({ logger: false, storage: options.memory.storage });
  options = { ...options, mastra };
  const run = async (input: TesseraAgentRunInput): Promise<TesseraAgentRun> => {
    const runtime = createTesseraFeishuCopilotRuntime();
    const agent = createAgent(options, input, runtime);
    const output = await agent.stream(
      feishuUserContent(input),
      generationOptions(options, input),
    );
    const reader = feishuAISdkStream(output).getReader();
    try { while (!(await reader.read()).done) { /* Consume the Mastra run before reading its messages. */ } }
    finally { reader.releaseLock(); }
    const message = assistantNarrationFromOutput(output);
    if (!message) throw new Error("The Feishu Agent did not return a usable response.");
    return {
      status: "completed",
      message,
      evidence: feishuEvidence(runtime).map((item) => ({
        queryId: `feishu:${item.documentId}`,
        label: item.title,
      })),
    };
  };

  const streamUI = (input: TesseraAgentRunInput): ReadableStream<TesseraUIMessageChunk> => {
    const controller = new AbortController();
    let cancelled = false;
    let sourceReader: ReadableStreamDefaultReader<TesseraUIMessageChunk> | undefined;
    const stream = new ReadableStream<TesseraUIMessageChunk>({
      start(streamController) {
        const abort = () => { controller.abort(); void sourceReader?.cancel().catch(() => undefined); };
        if (input.signal.aborted) {
          streamController.close();
          return;
        }
        input.signal.addEventListener("abort", abort, { once: true });
        void (async () => {
          const runtime = createTesseraFeishuCopilotRuntime();
          const agent = createAgent(options, { ...input, signal: controller.signal }, runtime);
          const output = await agent.stream(
            feishuUserContent(input),
            generationOptions(options, { ...input, signal: controller.signal }),
          );
          const source = appendCopilotOutcome(feishuAISdkStream(
            output,
            (error) => feishuStreamErrorText(options, error),
          ));
          const reader = source.getReader();
          sourceReader = reader;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (!controller.signal.aborted) streamController.enqueue(next.value);
            }
          } finally {
            sourceReader = undefined;
            reader.releaseLock();
          }
        })().catch((error: unknown) => {
          if (!controller.signal.aborted) {
            try { input.reportDiagnostic?.({ phase: "stream", error }); } catch { /* Diagnostics cannot interrupt the stream. */ }
            if (!cancelled) {
              streamController.enqueue({ type: "error", errorText: "飞书文档分析未能完成，请检查授权后重试。" });
            }
          }
        }).finally(() => {
          input.signal.removeEventListener("abort", abort);
          if (!cancelled) streamController.close();
        });
      },
      cancel() {
        cancelled = true;
        controller.abort();
        void sourceReader?.cancel().catch(() => undefined);
      },
    });
    return stream;
  };

  const stream = async (
    input: TesseraAgentRunInput,
    emit: Parameters<NonNullable<TesseraAgent["stream"]>>[1],
  ): Promise<TesseraAgentRun> => {
    const source = streamUI(input);
    const reader = source.getReader();
    let message = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (chunk.type === "text-delta") {
          message += chunk.delta;
          await emit({ type: "text-delta", text: chunk.delta });
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!message.trim()) throw new Error("The Feishu Agent did not return a usable response.");
    return { status: "completed", message: message.trim() };
  };

  return {
    agentType: "feishu",
    run,
    stream,
    streamUI,
  };
}

/**
 * Keeps provider rejections diagnosable. A provider HTTP status carries no
 * model-owned text, so it is safe to publish; anything else keeps the opaque
 * Feishu wording rather than leaking internal stream detail.
 */
function feishuStreamErrorText(
  options: TesseraStudioFeishuAgentOptions,
  error: unknown,
): string {
  const publicError = publicStudioStreamError(error, options.llm.model);
  return publicError.phase === "provider"
    ? publicError.message
    : "The Feishu Agent stream could not be processed.";
}

function createAgent(
  options: TesseraStudioFeishuAgentOptions,
  input: TesseraAgentRunInput,
  runtime: ReturnType<typeof createTesseraFeishuCopilotRuntime>,
): Agent {
  return createTesseraFeishuCopilotAgent({
    input,
    reader: options.reader,
    memory: options.memory,
    model: options.model,
    llm: options.llm,
    mastra: options.mastra!,
    defaultIdentity: options.defaultIdentity,
    runtime,
  });
}

function generationOptions(
  options: TesseraStudioFeishuAgentOptions,
  input: TesseraAgentRunInput,
) {
  return {
    abortSignal: input.signal,
    runId: input.runId,
    memory: { ...feishuMemoryOptions({ input, defaultIdentity: options.defaultIdentity }), resource: tesseraSessionResourceId(input.identity ?? options.defaultIdentity) },
    savePerStep: true,
    toolCallConcurrency: 1,
    system: buildCurrentDateSystemMessage(),
    maxSteps: options.llm.maxSteps,
    modelSettings: {
      maxOutputTokens: options.llm.maxOutputTokens,
      temperature: options.llm.temperature,
    },
    ...modelReasoningOptions(options.llm),
  } as const;
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
    if (text.length > 0) return text;
  }
  return undefined;
}
