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
  type Instructions,
  type PrepareStepFunction,
  type PrepareStepResult,
  type Tool,
  type ToolExecutionOptions,
  type UIMessageStreamWriter,
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

export type AISdkPresentUiAdapter<TResult = unknown> = Readonly<{
  instructions: string;
  compiled: CompiledPresentUi;
  tools: Readonly<{ present_ui: PresentUiTool<TResult> }>;
}>;

export type AISdkPresentUiStepContext = Parameters<PrepareStepFunction<any, any>>[0];

export type AISdkOpenGenerativeTurn = Readonly<{
  compiled: CompiledPresentUi;
  isCommitted?(): boolean;
  drainEvents?(): readonly SurfaceEventEnvelope[];
  createSession: IncrementalPresentUiSessionFactory<
    CompilerTurnOutcome,
    ToolExecutionOptions<Record<string, unknown>>
  >;
}>;

export type CreateOpenGenerativeAISdkAdapterOptions = Readonly<{
  tools: Readonly<Record<string, Tool<any, any, any>>>;
  resolve(context: AISdkPresentUiStepContext):
    | AISdkOpenGenerativeTurn
    | undefined
    | Promise<AISdkOpenGenerativeTurn | undefined>;
  /** When supplied, committed Surface events enter the existing AI SDK UI stream automatically. */
  writer?: Pick<UIMessageStreamWriter<OpenGenerativeUIMessage>, "write">;
  prepareStep?: PrepareStepFunction<any, any>;
  activeTools?: readonly string[];
  maxAttempts?: number;
}>;

export type OpenGenerativeAISdkAdapter = Readonly<{
  tools: Record<string, Tool<any, any, any>>;
  prepareStep: PrepareStepFunction<any, any>;
  drainEvents(): readonly SurfaceEventEnvelope[];
}>;

type PresentUiToolCallContext = ToolExecutionOptions<Record<string, unknown>>;

export type OpenGenerativeSurfaceDataChunkOptions = Readonly<{
  /** Deliver only through AI SDK's onData callback, not UIMessage.parts. */
  transient?: boolean;
}>;

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

export function createAISdkPresentUi<TResult>(
  options: CreatePresentUiToolOptions<TResult>,
): AISdkPresentUiAdapter<TResult> {
  return createAISdkAdapter(options.compiled, createPresentUiTool(options));
}

export function createAISdkIncrementalPresentUi(
  options: CreateIncrementalPresentUiToolOptions,
): AISdkPresentUiAdapter<CompilerTurnOutcome> {
  return createAISdkAdapter(options.compiled, createIncrementalPresentUiTool(options));
}

/**
 * AI SDK v7 equivalent of the Mastra per-step Processor. Create it once per
 * generateText/streamText call and spread the returned tools/prepareStep into
 * that call. present_ui remains inactive until resolve() returns a frozen turn.
 */
export function createOpenGenerativeAISdkAdapter(
  options: CreateOpenGenerativeAISdkAdapterOptions,
): OpenGenerativeAISdkAdapter {
  let current: AISdkPresentUiAdapter<any> | undefined;
  let activeTurn: AISdkOpenGenerativeTurn | undefined;
  const adapters = new WeakMap<object, AISdkPresentUiAdapter<CompilerTurnOutcome>>();
  const turns = new Set<AISdkOpenGenerativeTurn>();
  const placeholderSchema = jsonSchema<Record<string, never>>({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  const presentUi = {
    get description() {
      return current?.tools.present_ui.description
        ?? "Present a governed Open Generative interface when it becomes available.";
    },
    get inputSchema() {
      return current?.tools.present_ui.inputSchema ?? placeholderSchema;
    },
    get strict() {
      return current?.tools.present_ui.strict ?? true;
    },
    onInputStart(context: unknown) {
      return requireCurrentTool(current).onInputStart?.(context as never);
    },
    onInputDelta(context: unknown) {
      return requireCurrentTool(current).onInputDelta?.(context as never);
    },
    onInputAvailable(context: unknown) {
      return requireCurrentTool(current).onInputAvailable?.(context as never);
    },
    execute(input: unknown, context: unknown) {
      const execute = requireCurrentTool(current).execute;
      if (!execute) throw new TypeError("The active present_ui tool has no executor.");
      return execute(input as never, context as never);
    },
    toModelOutput(output: unknown) {
      return requireCurrentTool(current).toModelOutput?.(output as never);
    },
  } as unknown as PresentUiTool<unknown>;
  const tools = { ...options.tools, present_ui: presentUi };
  const baseActiveTools = options.activeTools === undefined
    ? Object.keys(options.tools)
    : [...options.activeTools];

  const prepareStep: PrepareStepFunction<any, any> = async (context) => {
    const inherited = await options.prepareStep?.(context);
    if (!activeTurn) {
      activeTurn = await options.resolve(context);
    }
    const turn = activeTurn;
    if (turn) {
      turns.add(turn);
      if (options.writer && turn.drainEvents) {
        for (const event of turn.drainEvents()) {
          options.writer.write(await toOpenGenerativeSurfaceDataChunk(event));
        }
      }
    }
    current = !turn || turn.isCommitted?.() === true
      ? undefined
      : adapterForAISdkTurn(turn, adapters, options.maxAttempts);
    const inheritedActive = inherited?.activeTools as readonly string[] | undefined;
    const active = [...(inheritedActive ?? baseActiveTools)].filter((name) => name !== "present_ui");
    const baseInstructions = inherited?.instructions
      ?? inherited?.system
      ?? context.instructions;
    const result: PrepareStepResult<any, any> = {
      ...inherited,
      activeTools: current ? [...active, "present_ui"] : active,
      instructions: current
        ? withPresentUiInstructions(baseInstructions, current.instructions)
        : withoutPresentUiInstructions(baseInstructions),
    };
    return result;
  };

  return Object.freeze({
    tools,
    prepareStep,
    drainEvents() {
      return Object.freeze([...turns].flatMap((turn) => turn.drainEvents?.() ?? []));
    },
  });
}

function adapterForAISdkTurn(
  turn: AISdkOpenGenerativeTurn,
  adapters: WeakMap<object, AISdkPresentUiAdapter<CompilerTurnOutcome>>,
  maxAttempts: number | undefined,
): AISdkPresentUiAdapter<CompilerTurnOutcome> {
  const existing = adapters.get(turn);
  if (existing) return existing;
  const created = createAISdkIncrementalPresentUi({
    compiled: turn.compiled,
    createSession: turn.createSession,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
  adapters.set(turn, created);
  return created;
}

export async function toOpenGenerativeSurfaceDataChunk(
  input: unknown,
  options: OpenGenerativeSurfaceDataChunkOptions = {},
): Promise<OpenGenerativeSurfaceDataChunk> {
  const event = surfaceEventEnvelopeSchema.parse(input);
  if (!await verifySurfaceEventEnvelope(event)) {
    throw new TypeError("Surface event payload hash verification failed.");
  }
  const chunk: OpenGenerativeSurfaceDataChunk = {
    type: OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
    id: event.eventId,
    data: event,
  };
  return options.transient ? { ...chunk, transient: true } : chunk;
}

export function createOpenGenerativeUIMessageStream(
  events: AsyncIterable<SurfaceEventEnvelope> | Iterable<SurfaceEventEnvelope>,
  options: OpenGenerativeSurfaceDataChunkOptions = {},
): ReadableStream<import("ai").InferUIMessageChunk<OpenGenerativeUIMessage>> {
  return createUIMessageStream<OpenGenerativeUIMessage>({
    async execute({ writer }) {
      for await (const event of events) {
        writer.write(await toOpenGenerativeSurfaceDataChunk(event, options));
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

function createAISdkAdapter<TResult>(
  compiled: CompiledPresentUi,
  presentUi: PresentUiTool<TResult>,
): AISdkPresentUiAdapter<TResult> {
  return Object.freeze({
    instructions: compiled.systemPrompt,
    compiled,
    tools: Object.freeze({ present_ui: presentUi }),
  });
}

const PRESENT_UI_INSTRUCTIONS_START = "<open-generative-present-ui>";
const PRESENT_UI_INSTRUCTIONS_END = "</open-generative-present-ui>";

function withPresentUiInstructions(
  instructions: Instructions | undefined,
  presentUi: string,
): Instructions {
  const clean = withoutPresentUiInstructions(instructions);
  const block = `${PRESENT_UI_INSTRUCTIONS_START}\n${presentUi}\n${PRESENT_UI_INSTRUCTIONS_END}`;
  if (clean === undefined) return block;
  if (typeof clean === "string") return `${clean}\n${block}`;
  const messages = Array.isArray(clean) ? [...clean] : [clean];
  return [...messages, { role: "system", content: block }];
}

function withoutPresentUiInstructions(
  instructions: Instructions | undefined,
): Instructions | undefined {
  if (instructions === undefined) return undefined;
  if (typeof instructions === "string") {
    const start = instructions.indexOf(PRESENT_UI_INSTRUCTIONS_START);
    if (start < 0) return instructions;
    const end = instructions.indexOf(PRESENT_UI_INSTRUCTIONS_END, start);
    return `${instructions.slice(0, start)}${end < 0 ? "" : instructions.slice(end + PRESENT_UI_INSTRUCTIONS_END.length)}`.trim();
  }
  const messages = Array.isArray(instructions) ? instructions : [instructions];
  const filtered = messages.filter((message) => (
    typeof message.content !== "string" || !message.content.startsWith(PRESENT_UI_INSTRUCTIONS_START)
  ));
  if (filtered.length === 0) return undefined;
  return Array.isArray(instructions) ? filtered : filtered[0];
}

function requireCurrentTool(
  adapter: AISdkPresentUiAdapter<any> | undefined,
): PresentUiTool<any> {
  if (!adapter) throw new TypeError("present_ui is not active for this AI SDK step.");
  return adapter.tools.present_ui;
}
