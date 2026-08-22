import {
  IncrementalPresentUiSessionCoordinator,
  schemaIssueSummary,
  validatePresentUiInput,
  type CompiledPresentUi,
  type CompilerTurnOutcome,
  type IncrementalPresentUiSessionFactory,
  type PresentUiAuthoringInput,
} from "@open-generative/compiler";
import {
  canonicalStringify,
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  createUIMessageStream,
  jsonSchema,
  type Tool,
  type ToolExecutionOptions,
} from "ai";
import {
  OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
  type OpenGenerativeSurfaceDataChunk,
  type OpenGenerativeUIMessage,
} from "./wire";

export type PresentUiExecutor<TResult> = (
  input: PresentUiAuthoringInput,
  options: ToolExecutionOptions<Record<string, unknown>>,
) => TResult | PromiseLike<TResult> | AsyncIterable<TResult>;

export type PresentUiTool<TResult> = Tool<
  PresentUiAuthoringInput,
  TResult,
  Record<string, unknown>
>;

export type CreatePresentUiToolOptions<TResult> = Readonly<{
  compiled: CompiledPresentUi;
  execute: PresentUiExecutor<TResult>;
}>;

export type CreateIncrementalPresentUiToolOptions = Readonly<{
  compiled: CompiledPresentUi;
  createSession: IncrementalPresentUiSessionFactory<
    CompilerTurnOutcome,
    ToolExecutionOptions<Record<string, unknown>>
  >;
  maxAttempts?: number;
}>;

type PresentUiToolCallContext = ToolExecutionOptions<Record<string, unknown>>;

const SAFE_PRESENT_UI_MODEL_OUTPUT = Object.freeze({
  type: "text" as const,
  value: "The Open Generative host processed the interface proposal.",
});

export function createPresentUiTool<TResult>(
  options: CreatePresentUiToolOptions<TResult>,
): PresentUiTool<TResult> {
  const inputSchema = createPresentUiInputSchema(options.compiled);
  return {
    description: options.compiled.tool.description,
    inputSchema,
    strict: options.compiled.tool.strict,
    execute: options.execute,
    toModelOutput: () => SAFE_PRESENT_UI_MODEL_OUTPUT,
  } as unknown as PresentUiTool<TResult>;
}

export function createIncrementalPresentUiTool(
  options: CreateIncrementalPresentUiToolOptions,
): PresentUiTool<CompilerTurnOutcome> {
  const coordinator = new IncrementalPresentUiSessionCoordinator({
    createSession: options.createSession,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return {
    description: options.compiled.tool.description,
    inputSchema: createPresentUiInputSchema(options.compiled),
    strict: options.compiled.tool.strict,
    onInputStart: async (context: PresentUiToolCallContext) => {
      await coordinator.start(context);
    },
    onInputDelta: async (context: PresentUiToolCallContext & { inputTextDelta: string }) => {
      await coordinator.pushTextDelta(context, context.inputTextDelta);
    },
    onInputAvailable: async (context: PresentUiToolCallContext & { input: PresentUiAuthoringInput }) => {
      await coordinator.complete(context, context.input);
    },
    execute: async (input: PresentUiAuthoringInput, context: PresentUiToolCallContext) => (
      coordinator.execute(context, input)
    ),
    toModelOutput: ({ output }: { output: CompilerTurnOutcome }) => compilerOutcomeModelOutput(output),
  } as unknown as PresentUiTool<CompilerTurnOutcome>;
}

export async function toOpenGenerativeSurfaceDataChunk(
  input: unknown,
): Promise<OpenGenerativeSurfaceDataChunk> {
  const event = surfaceEventEnvelopeSchema.parse(input);
  if (!await verifySurfaceEventEnvelope(event)) {
    throw new TypeError("Surface event payload hash verification failed.");
  }
  return {
    type: OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
    id: event.eventId,
    data: event,
    transient: true,
  };
}

export function createOpenGenerativeUIMessageStream(
  events: AsyncIterable<SurfaceEventEnvelope> | Iterable<SurfaceEventEnvelope>,
): ReadableStream<import("ai").InferUIMessageChunk<OpenGenerativeUIMessage>> {
  return createUIMessageStream<OpenGenerativeUIMessage>({
    async execute({ writer }) {
      for await (const event of events) {
        writer.write(await toOpenGenerativeSurfaceDataChunk(event));
      }
    },
  });
}

function createPresentUiInputSchema(compiled: CompiledPresentUi) {
  return jsonSchema<PresentUiAuthoringInput>(
    compiled.providerInputSchema as Parameters<typeof jsonSchema>[0],
    {
      validate(input) {
        const result = validatePresentUiInput(compiled, input);
        if (result.success && canonicalInputUnchanged(input, result.data)) {
          return { success: true, value: input as PresentUiAuthoringInput };
        }
        return {
          success: false,
          error: new TypeError(result.success
            ? "present_ui input validation attempted to transform canonical input."
            : `present_ui input is invalid: ${schemaIssueSummary(result)}`),
        };
      },
    },
  );
}

function canonicalInputUnchanged(input: unknown, parsed: unknown): boolean {
  try {
    return canonicalStringify(input) === canonicalStringify(parsed);
  } catch {
    return false;
  }
}

function compilerOutcomeModelOutput(outcome: CompilerTurnOutcome) {
  if (outcome.status === "committed") return SAFE_PRESENT_UI_MODEL_OUTPUT;
  const diagnostics = outcome.diagnostics.slice(0, 4).map((entry) => `${entry.code}: ${entry.message.slice(0, 240)}`);
  return {
    type: "text" as const,
    value: diagnostics.length === 0
      ? "The interface proposal was rejected. Submit one corrected present_ui proposal."
      : `The interface proposal was rejected. Correct these diagnostics: ${diagnostics.join("; ")}`,
  };
}
