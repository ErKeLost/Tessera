import type {
  InputProcessor,
  OutputProcessor,
  ProcessInputStepArgs,
  ProcessInputStepResult,
  ProcessOutputStepArgs,
  ProcessOutputStreamArgs,
} from "@mastra/core/processors";
import type { ChunkType } from "@mastra/core/stream";
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
import type { OpenGenerativeLanguageSession } from "@open-generative/compiler";

export type {
  OpenGenerativeAuthority,
  OpenGenerativeDatasetResource,
} from "@open-generative/host";
export type { OpenGenerativeSurfaceStream } from "@open-generative/protocol";

export type OpenGenerativeMastraStepContext = Readonly<{
  stepNumber: number;
  steps: ProcessInputStepArgs["steps"];
  requestContext: ProcessInputStepArgs["requestContext"];
  abortSignal: ProcessInputStepArgs["abortSignal"];
}>;

export type CreateOpenGenerativeProcessorOptions = Readonly<{
  resources?(context: OpenGenerativeMastraStepContext):
    | readonly OpenGenerativeDatasetResource[]
    | Promise<readonly OpenGenerativeDatasetResource[]>;
  authority(context: OpenGenerativeMastraStepContext):
    | OpenGenerativeAuthority
    | Promise<OpenGenerativeAuthority>;
  turn?: Omit<PrepareOpenGenerativeTurnInput, "resources" | "authority">;
  host?: OpenGenerativeHost | Promise<OpenGenerativeHost>;
  maxRetries?: number;
}>;

export type OpenGenerativeMastraProcessor = InputProcessor & OutputProcessor;

type PresentationPhase = "candidate" | "repair" | "invalid" | "committed" | "aborted";

type PresentationRequest = {
  phase: PresentationPhase;
  oglStarted: boolean;
  turn: OpenGenerativeTurn;
  session?: OpenGenerativeLanguageSession;
  events: SurfaceEventEnvelope[];
};

const PROCESSOR_ID = "open-generative-language";
const STATE_KEY = "openGenerativeLanguage";
const SYSTEM_MARKER = "<open-generative-language-instructions>";
const SYSTEM_END_MARKER = "</open-generative-language-instructions>";

let defaultHost: Promise<OpenGenerativeHost> | undefined;

/**
 * Creates one Mastra Processor that owns both sides of the integration:
 * input injects the frozen OGL prompt, output compiles the final text stream.
 * Business tool definitions remain untouched. A repair step temporarily
 * disables them through Mastra's per-step controls.
 */
export function createOpenGenerativeProcessor(
  options: CreateOpenGenerativeProcessorOptions,
): OpenGenerativeMastraProcessor {
  const maxRetries = options.maxRetries ?? 1;
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 8) {
    throw new TypeError("Open Generative maxRetries must be an integer between 0 and 8.");
  }
  const processor = {
    id: PROCESSOR_ID,
    name: "Open Generative Language",
    description: "Compiles final model text into governed streaming UI without adding agent tools.",

    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
      let request = requestState(args.state);
      if (!request) {
        const context = stepContext(args);
        const resources = await options.resources?.(context) ?? [];
        if (options.resources && resources.length === 0) return undefined;
        const [host, authority] = await Promise.all([
          options.host ?? resolveDefaultHost(),
          options.authority(context),
        ]);
        const turn = await host.prepareTurn({
          ...options.turn,
          authority,
          resources,
        });
        if (!turn) return undefined;
        // Keep completed tool evidence outside the response message that an OGL retry may discard.
        args.rotateResponseMessageId?.();
        request = {
          phase: "candidate",
          oglStarted: false,
          turn,
          events: [],
        };
        args.state[STATE_KEY] = request;
      }
      if (!isGenerating(request)) return undefined;
      return {
        ...(request.phase === "repair" ? { activeTools: [], toolChoice: "none" as const } : {}),
        systemMessages: [
          ...args.systemMessages.filter((message) => !isOwnedSystemMessage(message.content)),
          {
            role: "system",
            content: `${SYSTEM_MARKER}\n${request.turn.language.systemPrompt}\n${SYSTEM_END_MARKER}`,
          },
        ],
      };
    },

    async processOutputStream(args: ProcessOutputStreamArgs): Promise<ChunkType | null | undefined> {
      const request = requestState(args.state);
      if (!request || isTerminal(request)) return args.part;
      const part = args.part;

      if (part.type === "error" || part.type === "abort") {
        request.phase = "aborted";
        await abortSession(request, args.writer);
        return part;
      }
      if (request.phase === "invalid") return null;
      if (part.type === "text-start" || part.type === "text-end") return null;
      if (part.type === "text-delta") {
        const session = await openSession(request, args.abortSignal);
        const update = await session.pushTextDelta(part.payload.text);
        if (update.acceptedStatements > 0) request.oglStarted = true;
        await publishEvents(request, args.writer);
        return null;
      }
      if (part.type.startsWith("tool-")) {
        if (!shouldRejectToolCall(request)) return part;
        request.phase = "invalid";
        await abortSession(request, args.writer);
        return null;
      }
      return part;
    },

    async processOutputStep(args: ProcessOutputStepArgs) {
      const request = requestState(args.state);
      if (!request || isTerminal(request)) return args.messageList;

      if (request.phase === "invalid") {
        rejectRequest(
          request,
          args,
          maxRetries,
          "A business tool call was emitted during the final OGL presentation step.",
        );
      }

      if ((args.toolCalls?.length ?? 0) > 0) {
        await abortSession(request, args.writer);
        if (!shouldRejectToolCall(request)) {
          delete args.state[STATE_KEY];
          return args.messageList;
        }
        rejectRequest(
          request,
          args,
          maxRetries,
          "A business tool call was emitted during the final OGL presentation step.",
        );
      }

      let rejection: string | undefined;
      try {
        rejection = await finishRequest(request, args.writer, args.abortSignal);
      } catch (error) {
        rejection = error instanceof Error
          ? error.message
          : "Open Generative Language output could not be finalized.";
      }
      if (!rejection) return args.messageList;

      rejectRequest(request, args, maxRetries, rejection);
    },
  } satisfies OpenGenerativeMastraProcessor;
  return processor;
}

function rejectRequest(
  request: PresentationRequest,
  args: ProcessOutputStepArgs,
  maxRetries: number,
  rejection: string,
): never {
  const retry = args.retryCount < maxRetries;
  request.phase = retry ? "repair" : "aborted";
  request.oglStarted = false;
  request.session = undefined;
  const feedback = [
    `Open Generative Language output was rejected: ${rejection}`,
    "Return a non-empty final answer containing only valid OGL assignment statements.",
    "Do not call tools or describe renderer availability. Open Generative rendering is produced directly from OGL text.",
  ].join(" ");
  return args.abort(feedback, { retry });
}

async function finishRequest(
  request: PresentationRequest,
  writer: ProcessOutputStepArgs["writer"],
  abortSignal: AbortSignal | undefined,
): Promise<string | undefined> {
  const session = await openSession(request, abortSignal);
  const outcome = await session.finish();
  request.session = undefined;
  await publishEvents(request, writer);
  if (outcome.status !== "committed") {
    return outcome.diagnostics.map((diagnostic) => diagnostic.message).join("; ")
      || "Open Generative Language output was rejected.";
  }
  request.phase = "committed";
  return undefined;
}

async function publishEvents(
  request: PresentationRequest,
  writer: ProcessOutputStreamArgs["writer"],
): Promise<void> {
  const drained = request.turn.drainEvents();
  if (drained.length === 0) return;
  for (const input of drained) {
    const event = surfaceEventEnvelopeSchema.parse(input);
    if (!await verifySurfaceEventEnvelope(event)) {
      throw new TypeError("An Open Generative Surface event failed payload hash verification.");
    }
    request.events.push(event);
  }
  if (!writer) return;
  const stream = openGenerativeSurfaceStreamSchema.parse({
    surfaceSessionId: request.turn.surfaceSessionId,
    events: request.events,
  });
  await writer.custom({
    type: "data-openGenerativeSurface",
    id: `open-generative:${request.turn.surfaceSessionId}`,
    data: stream,
  });
}

async function openSession(
  request: PresentationRequest,
  abortSignal: AbortSignal | undefined,
): Promise<OpenGenerativeLanguageSession> {
  request.session ??= await request.turn.createSession({
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
  return request.session;
}

async function abortSession(
  request: PresentationRequest,
  writer: ProcessOutputStepArgs["writer"],
): Promise<void> {
  if (!request.session) return;
  await request.session.abort("cancelled");
  request.session = undefined;
  await publishEvents(request, writer);
}

function isGenerating(request: PresentationRequest): boolean {
  return request.phase === "candidate" || request.phase === "repair";
}

function isTerminal(request: PresentationRequest): boolean {
  return request.phase === "committed" || request.phase === "aborted";
}

function shouldRejectToolCall(request: PresentationRequest): boolean {
  return request.phase === "repair" || request.oglStarted;
}

function requestState(state: Record<string, unknown>): PresentationRequest | undefined {
  const value = state[STATE_KEY];
  return isPresentationRequest(value) ? value : undefined;
}

function isPresentationRequest(value: unknown): value is PresentationRequest {
  return typeof value === "object"
    && value !== null
    && "phase" in value
    && "turn" in value
    && "events" in value;
}

function stepContext(args: ProcessInputStepArgs): OpenGenerativeMastraStepContext {
  return {
    stepNumber: args.stepNumber,
    steps: args.steps,
    requestContext: args.requestContext,
    abortSignal: args.abortSignal,
  };
}

function isOwnedSystemMessage(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(SYSTEM_MARKER);
}

function resolveDefaultHost(): Promise<OpenGenerativeHost> {
  defaultHost ??= createOpenGenerativeHost();
  return defaultHost;
}
