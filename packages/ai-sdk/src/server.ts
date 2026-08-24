import {
  openGenerativeSurfaceStreamSchema,
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type OpenGenerativeSurfaceStream,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  createOpenGenerativeHost,
  type OpenGenerativeAuthority,
  type OpenGenerativeDatasetResource,
  type OpenGenerativeHost,
  type OpenGenerativeTurn,
  type PrepareOpenGenerativeTurnInput,
} from "@open-generative/host";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream as convertToUIMessageStream,
  type Instructions,
  type PrepareStepFunction,
  type PrepareStepResult,
  type StreamTextResult,
  type StreamTextTransform,
  type UIMessageStreamOptions,
} from "ai";
import {
  OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
  type OpenGenerativeSurfaceDataChunk,
  type OpenGenerativeUIMessage,
} from "./wire";

export type AISdkOpenGenerativeStepContext = Parameters<PrepareStepFunction<any, any>>[0];

export type CreateOpenGenerativeProcessorOptions = Readonly<{
  resources?(context: AISdkOpenGenerativeStepContext):
    | readonly OpenGenerativeDatasetResource[]
    | Promise<readonly OpenGenerativeDatasetResource[]>;
  authority(context: AISdkOpenGenerativeStepContext):
    | OpenGenerativeAuthority
    | Promise<OpenGenerativeAuthority>;
  turn?: Omit<PrepareOpenGenerativeTurnInput, "resources" | "authority">;
  activation?: "always" | "when-resources";
  host?: OpenGenerativeHost | Promise<OpenGenerativeHost>;
  prepareStep?: PrepareStepFunction<any, any>;
}>;

export type OpenGenerativeAISdkProcessor = Readonly<{
  prepareStep: PrepareStepFunction<any, any>;
  transform: StreamTextTransform<any>;
  toUIMessageStream(
    result: Pick<StreamTextResult<any, any, any>, "stream">,
    options?: UIMessageStreamOptions<OpenGenerativeUIMessage>,
  ): ReadableStream<import("ai").InferUIMessageChunk<OpenGenerativeUIMessage>>;
  toUIMessageStreamResponse(
    result: Pick<StreamTextResult<any, any, any>, "stream">,
    options?: Omit<Parameters<typeof createUIMessageStreamResponse>[0], "stream">,
  ): Response;
}>;

type ActiveTurn = {
  status: "active" | "finished" | "aborted";
  turn: OpenGenerativeTurn;
  session: Awaited<ReturnType<OpenGenerativeTurn["createSession"]>>;
  events: SurfaceEventEnvelope[];
};

const SYSTEM_MARKER = "<open-generative-language-instructions>";
const SYSTEM_END_MARKER = "</open-generative-language-instructions>";

let defaultHost: Promise<OpenGenerativeHost> | undefined;

/**
 * AI SDK v7 adapter with no injected tools. Add prepareStep and transform to
 * streamText, then use the returned UI stream helper for cumulative Surfaces.
 */
export function createOpenGenerativeProcessor(
  options: CreateOpenGenerativeProcessorOptions,
): OpenGenerativeAISdkProcessor {
  const activation = options.activation ?? (options.resources ? "when-resources" : "always");
  const queue = new AsyncQueue<OpenGenerativeSurfaceDataChunk>();
  let active: ActiveTurn | undefined;
  let uiStreamClaimed = false;

  const prepareStep: PrepareStepFunction<any, any> = async (context) => {
    const inherited = await options.prepareStep?.(context);
    if (!active) {
      const resources = await options.resources?.(context) ?? [];
      if (activation === "when-resources" && resources.length === 0) return inherited;
      const [host, authority] = await Promise.all([
        options.host ?? resolveDefaultHost(),
        options.authority(context),
      ]);
      const turn = await host.prepareTurn({ ...options.turn, authority, resources });
      if (!turn) return inherited;
      active = {
        status: "active",
        turn,
        session: await turn.createSession(),
        events: [],
      };
    }
    if (active.status !== "active") return inherited;
    const baseInstructions = inherited?.instructions
      ?? inherited?.system
      ?? context.instructions;
    return {
      ...inherited,
      instructions: withLanguageInstructions(baseInstructions, active.turn.language.systemPrompt),
    } as PrepareStepResult<any, any>;
  };

  const transform: StreamTextTransform<any> = () => new TransformStream({
    async transform(part, controller) {
      const current = active;
      if (!current || current.status !== "active") {
        controller.enqueue(part);
        return;
      }
      if (part.type === "text-start" || part.type === "text-end") return;
      if (part.type === "text-delta") {
        await current.session.pushTextDelta(part.text);
        await publishEvents(current, queue);
        return;
      }
      if (part.type === "finish-step" && part.finishReason !== "tool-calls") {
        await finishTurn(current, queue);
      } else if (part.type === "finish") {
        await finishTurn(current, queue);
        queue.close();
      } else if (part.type === "abort" || part.type === "error") {
        current.status = "aborted";
        await current.session.abort("cancelled");
        await publishEvents(current, queue);
        queue.close();
      }
      controller.enqueue(part);
    },
    async flush() {
      if (active?.status === "active") await finishTurn(active, queue);
      queue.close();
    },
  });

  const toUIMessageStream = (
    result: Pick<StreamTextResult<any, any, any>, "stream">,
    streamOptions: UIMessageStreamOptions<OpenGenerativeUIMessage> = {},
  ) => {
    if (uiStreamClaimed) throw new TypeError("An Open Generative AI SDK stream can be consumed only once.");
    uiStreamClaimed = true;
    return createUIMessageStream<OpenGenerativeUIMessage>({
      execute({ writer }) {
        writer.merge(convertToUIMessageStream<any, OpenGenerativeUIMessage>({
          stream: result.stream,
          ...streamOptions,
        }));
        writer.merge(queue.stream());
      },
      onError: streamOptions.onError,
    });
  };

  return Object.freeze({
    prepareStep,
    transform,
    toUIMessageStream,
    toUIMessageStreamResponse(result, responseOptions = {}) {
      return createUIMessageStreamResponse({
        ...responseOptions,
        stream: toUIMessageStream(result),
      });
    },
  });
}

async function finishTurn(
  active: ActiveTurn,
  queue: AsyncQueue<OpenGenerativeSurfaceDataChunk>,
): Promise<void> {
  if (active.status !== "active") return;
  const outcome = await active.session.finish();
  await publishEvents(active, queue);
  if (outcome.status !== "committed") {
    active.status = "aborted";
    throw new OpenGenerativeOutputError(
      outcome.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
      || "Open Generative Language output was rejected.",
    );
  }
  active.status = "finished";
}

async function publishEvents(
  active: ActiveTurn,
  queue: AsyncQueue<OpenGenerativeSurfaceDataChunk>,
): Promise<void> {
  const drained = active.turn.drainEvents();
  if (drained.length === 0) return;
  for (const input of drained) {
    const event = surfaceEventEnvelopeSchema.parse(input);
    if (!await verifySurfaceEventEnvelope(event)) {
      throw new OpenGenerativeOutputError("A Surface event failed its payload hash verification.");
    }
    active.events.push(event);
  }
  const stream = openGenerativeSurfaceStreamSchema.parse({
    surfaceSessionId: active.turn.surfaceSessionId,
    events: active.events,
  });
  queue.push({
    type: OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
    id: `open-generative:${active.turn.surfaceSessionId}`,
    data: stream,
  });
}

function withLanguageInstructions(
  instructions: Instructions | undefined,
  language: string,
): Instructions {
  const clean = withoutLanguageInstructions(instructions);
  const block = `${SYSTEM_MARKER}\n${language}\n${SYSTEM_END_MARKER}`;
  if (clean === undefined) return block;
  if (typeof clean === "string") return `${clean}\n${block}`;
  const messages = Array.isArray(clean) ? [...clean] : [clean];
  return [...messages, { role: "system", content: block }];
}

function withoutLanguageInstructions(instructions: Instructions | undefined): Instructions | undefined {
  if (instructions === undefined) return undefined;
  if (typeof instructions === "string") {
    const start = instructions.indexOf(SYSTEM_MARKER);
    if (start < 0) return instructions;
    const end = instructions.indexOf(SYSTEM_END_MARKER, start);
    return `${instructions.slice(0, start)}${end < 0 ? "" : instructions.slice(end + SYSTEM_END_MARKER.length)}`.trim();
  }
  const messages = Array.isArray(instructions) ? instructions : [instructions];
  const filtered = messages.filter((message) => (
    typeof message.content !== "string" || !message.content.startsWith(SYSTEM_MARKER)
  ));
  if (filtered.length === 0) return undefined;
  return Array.isArray(instructions) ? filtered : filtered[0];
}

function resolveDefaultHost(): Promise<OpenGenerativeHost> {
  defaultHost ??= createOpenGenerativeHost();
  return defaultHost;
}

class AsyncQueue<T> {
  readonly #pending: T[] = [];
  readonly #waiters: Array<(result: ReadableStreamReadResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) throw new TypeError("Cannot publish to a closed Open Generative stream.");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#pending.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()!({ done: true, value: undefined });
  }

  stream(): ReadableStream<T> {
    return new ReadableStream<T>({
      pull: (controller) => {
        const value = this.#pending.shift();
        if (value !== undefined) {
          controller.enqueue(value);
          return;
        }
        if (this.#closed) {
          controller.close();
          return;
        }
        return new Promise<void>((resolve) => {
          this.#waiters.push((result) => {
            if (result.done) controller.close();
            else controller.enqueue(result.value);
            resolve();
          });
        });
      },
    });
  }
}

export class OpenGenerativeOutputError extends TypeError {
  readonly code = "open-generative.output-invalid";

  constructor(message: string) {
    super(message);
    this.name = "OpenGenerativeOutputError";
  }
}
