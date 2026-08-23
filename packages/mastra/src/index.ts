import {
  createTool,
  noopObserve,
  type Tool,
  type ToolExecutionContext,
  type ToolObserve,
  type ToolPayloadTransform,
} from "@mastra/core/tools";
import type {
  InputProcessor,
  ProcessInputStepArgs,
  ProcessInputStepResult,
} from "@mastra/core/processors";
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
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { z } from "zod";

const SAFE_INPUT = Object.freeze({ type: "open-generative-proposal", redacted: true });
const SAFE_OUTPUT = Object.freeze({ type: "open-generative-surface", available: true });
const SAFE_ERROR = Object.freeze({ message: "Open Generative proposal processing failed." });
const SAFE_APPROVAL = Object.freeze({ type: "open-generative-approval", redacted: true });
const SAFE_SUSPEND = Object.freeze({ type: "open-generative-suspension", redacted: true });
const SAFE_RESUME = Object.freeze({ type: "open-generative-resume", redacted: true });
const SAFE_OBSERVABILITY = Object.freeze({
  type: "open-generative-observability",
  redacted: true,
});
const SAFE_MODEL_OUTPUT = Object.freeze({
  type: "text" as const,
  value: "The Open Generative host processed the interface proposal.",
});

/**
 * Mastra records tool arguments and results on tool-call spans before per-tool
 * display/transcript transforms run. Hosts must pass these options to the
 * Agent invocation that owns a present_ui tool.
 */
export const MASTRA_PRESENT_UI_TRACING_OPTIONS = Object.freeze({
  hideInput: true,
  hideOutput: true,
});

export type MastraPresentUiExecutor<TResult> = (
  input: PresentUiAuthoringInput,
  context: ToolExecutionContext,
) => TResult | PromiseLike<TResult>;

export type MastraPresentUiTool<TResult> = Tool<PresentUiAuthoringInput, TResult>;

export type CreateMastraPresentUiToolOptions<TResult> = Readonly<{
  compiled: CompiledPresentUi;
  execute: MastraPresentUiExecutor<TResult>;
}>;

export type MastraPresentUiIncrementalContext = Readonly<{
  toolCallId: string;
  abortSignal?: AbortSignal;
}>;

export type CreateMastraIncrementalPresentUiToolOptions = Readonly<{
  compiled: CompiledPresentUi;
  createSession: IncrementalPresentUiSessionFactory<
    CompilerTurnOutcome,
    MastraPresentUiIncrementalContext
  >;
  /** Maximum repair attempts per Mastra request scope. */
  maxAttempts?: number;
}>;

export function createMastraPresentUiTool<TResult>(
  options: CreateMastraPresentUiToolOptions<TResult>,
): MastraPresentUiTool<TResult> {
  return createMastraTool({
    compiled: options.compiled,
    async execute(input, context) {
      return options.execute(validateInput(options.compiled, input), redactObservability(context));
    },
  });
}

export function createMastraIncrementalPresentUiTool(
  options: CreateMastraIncrementalPresentUiToolOptions,
): MastraPresentUiTool<CompilerTurnOutcome> {
  type Coordinator = IncrementalPresentUiSessionCoordinator<
    CompilerTurnOutcome,
    MastraPresentUiIncrementalContext
  >;
  const createCoordinator = (): Coordinator => new IncrementalPresentUiSessionCoordinator({
    createSession: options.createSession,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  const fallbackCoordinator = createCoordinator();
  const requestCoordinators = new WeakMap<object, Coordinator>();
  const toolCallCoordinators = new Map<string, Coordinator>();

  const coordinatorForHook = (
    context: Parameters<NonNullable<MastraPresentUiTool<unknown>["onInputStart"]>>[0],
  ): Coordinator => {
    const requestKey = mastraRequestKey(context);
    let coordinator = requestKey ? requestCoordinators.get(requestKey) : undefined;
    if (!requestKey && !coordinator) {
      coordinator = toolCallCoordinators.get(context.toolCallId);
    }
    if (!coordinator) {
      coordinator = requestKey ? createCoordinator() : fallbackCoordinator;
      if (requestKey) requestCoordinators.set(requestKey, coordinator);
    }
    if (toolCallCoordinators.get(context.toolCallId) !== coordinator) {
      toolCallCoordinators.set(context.toolCallId, coordinator);
      context.abortSignal?.addEventListener(
        "abort",
        () => {
          if (toolCallCoordinators.get(context.toolCallId) === coordinator) {
            toolCallCoordinators.delete(context.toolCallId);
          }
        },
        { once: true },
      );
    }
    return coordinator;
  };

  return createMastraTool({
    compiled: options.compiled,
    toModelOutput: compilerOutcomeModelOutput,
    onInputStart: async (context) => {
      await coordinatorForHook(context).start(hookContextToIncrementalContext(context));
    },
    onInputDelta: async (context) => {
      await coordinatorForHook(context).pushTextDelta(
        hookContextToIncrementalContext(context),
        context.inputTextDelta,
      );
    },
    onInputAvailable: async (context) => {
      await coordinatorForHook(context).complete(
        hookContextToIncrementalContext(context),
        validateInput(options.compiled, context.input),
      );
    },
    async execute(input, context) {
      redactObservability(context);
      const incrementalContext = executionContextToToolCallOptions(context);
      const requestKey = context.abortSignal;
      const coordinator = (requestKey ? requestCoordinators.get(requestKey) : undefined)
        ?? toolCallCoordinators.get(incrementalContext.toolCallId)
        ?? fallbackCoordinator;
      try {
        return await coordinator.execute(
          incrementalContext,
          validateInput(options.compiled, input),
        );
      } finally {
        if (toolCallCoordinators.get(incrementalContext.toolCallId) === coordinator) {
          toolCallCoordinators.delete(incrementalContext.toolCallId);
        }
      }
    },
  });
}

export type CreateMastraPresentUiOptions<TResult> = CreateMastraPresentUiToolOptions<TResult>;

export type MastraPresentUiAdapter<TResult = unknown> = Readonly<{
  system: string;
  compiled: CompiledPresentUi;
  tools: Readonly<{ present_ui: MastraPresentUiTool<TResult> }>;
  tracingOptions: typeof MASTRA_PRESENT_UI_TRACING_OPTIONS;
}>;

export type MastraPresentUiStepContext = Readonly<{
  stepNumber: number;
  requestContext: ProcessInputStepArgs["requestContext"];
  abortSignal: ProcessInputStepArgs["abortSignal"];
}>;

export type CreateMastraPresentUiProcessorOptions = Readonly<{
  /** Resolve the frozen turn adapter. Return undefined until resources are available. */
  resolve(context: MastraPresentUiStepContext):
    | MastraPresentUiAdapter<any>
    | undefined
    | Promise<MastraPresentUiAdapter<any> | undefined>;
}>;

export type MastraOpenGenerativeTurn = Readonly<{
  compiled: CompiledPresentUi;
  isCommitted?(): boolean;
  drainEvents?(): readonly SurfaceEventEnvelope[];
  createSession: IncrementalPresentUiSessionFactory<
    CompilerTurnOutcome,
    MastraPresentUiIncrementalContext
  >;
}>;

export type CreateOpenGenerativeMastraProcessorOptions = Readonly<{
  /** Return undefined until the application has published renderable resources. */
  resolve(context: MastraPresentUiStepContext):
    | MastraOpenGenerativeTurn
    | undefined
    | Promise<MastraOpenGenerativeTurn | undefined>;
  maxAttempts?: number;
}>;

const PRESENT_UI_SYSTEM_MARKER = "<open-generative-present-ui>";

/**
 * Adds one turn-scoped present_ui tool at the exact agent step where the Host
 * has resources to offer. Contracts compile both its schema and prompt; an
 * application never maintains per-component tools or handwritten UI prompts.
 */
export function createMastraPresentUiProcessor(
  options: CreateMastraPresentUiProcessorOptions,
): InputProcessor {
  return {
    id: "open-generative-present-ui" as const,
    name: "Open Generative present_ui",
    description: "Injects a frozen present_ui Contract Slice into eligible Mastra agent steps.",
    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
      const adapter = await options.resolve({
        stepNumber: args.stepNumber,
        requestContext: args.requestContext,
        abortSignal: args.abortSignal,
      });
      if (!adapter) return undefined;
      return injectMastraPresentUi(args, adapter);
    },
  };
}

/**
 * Consumer entry point for Mastra. Applications resolve a Host turn; this
 * adapter owns the present_ui tool, generated prompt, streaming hooks, and
 * repair budget for that turn.
 */
export function createOpenGenerativeMastraProcessor(
  options: CreateOpenGenerativeMastraProcessorOptions,
): InputProcessor {
  const adapters = new WeakMap<object, MastraPresentUiAdapter<CompilerTurnOutcome>>();
  const requestTurns = new WeakMap<object, MastraOpenGenerativeTurn>();
  return {
    id: "open-generative-present-ui" as const,
    name: "Open Generative",
    description: "Publishes committed Surfaces and injects present_ui only when governed resources are ready.",
    async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
      let turn = requestTurns.get(args.state);
      if (!turn) {
        turn = await options.resolve({
          stepNumber: args.stepNumber,
          requestContext: args.requestContext,
          abortSignal: args.abortSignal,
        });
        if (turn) requestTurns.set(args.state, turn);
      }
      if (!turn) return undefined;
      await publishCommittedMastraEvents(args, turn);
      if (turn.isCommitted?.() === true) return undefined;
      const existing = adapters.get(turn);
      if (existing) return injectMastraPresentUi(args, existing);
      const created = createMastraIncrementalPresentUi({
          compiled: turn.compiled,
          createSession: turn.createSession,
          ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
        });
      adapters.set(turn, created);
      return injectMastraPresentUi(args, created);
    },
  };
}

function injectMastraPresentUi(
  args: ProcessInputStepArgs,
  adapter: MastraPresentUiAdapter<any>,
): ProcessInputStepResult {
  const existing = args.tools?.present_ui;
  if (existing !== undefined && existing !== adapter.tools.present_ui) {
    throw new TypeError("Mastra already exposes a different present_ui tool for this step.");
  }
  const systemMessages = args.systemMessages.filter((message) => !isPresentUiSystemMessage(message));
  systemMessages.push({
    role: "system",
    content: `${PRESENT_UI_SYSTEM_MARKER}\n${adapter.system}\n</open-generative-present-ui>`,
  });
  return {
    tools: { ...args.tools, present_ui: adapter.tools.present_ui },
    activeTools: args.activeTools === undefined
      ? undefined
      : [...new Set([...args.activeTools, "present_ui"])],
    systemMessages,
  };
}

async function publishCommittedMastraEvents(
  args: ProcessInputStepArgs,
  turn: MastraOpenGenerativeTurn,
): Promise<void> {
  if (!args.writer || !turn.drainEvents) return;
  for (const input of turn.drainEvents()) {
    const event = surfaceEventEnvelopeSchema.parse(input);
    if (!await verifySurfaceEventEnvelope(event)) {
      throw new TypeError("Open Generative Surface event hash verification failed.");
    }
    await args.writer.custom({
      type: "data-openGenerativeSurface",
      id: event.eventId,
      data: event,
    });
  }
}

function isPresentUiSystemMessage(message: ProcessInputStepArgs["systemMessages"][number]): boolean {
  return typeof message.content === "string" && message.content.startsWith(PRESENT_UI_SYSTEM_MARKER);
}

export function createMastraPresentUi<TResult>(
  options: CreateMastraPresentUiOptions<TResult>,
): MastraPresentUiAdapter<TResult> {
  return createMastraAdapter(options.compiled, createMastraPresentUiTool(options));
}

export type CreateMastraIncrementalPresentUiOptions =
  CreateMastraIncrementalPresentUiToolOptions;

export function createMastraIncrementalPresentUi(
  options: CreateMastraIncrementalPresentUiOptions,
) {
  return createMastraAdapter(options.compiled, createMastraIncrementalPresentUiTool(options));
}

export class MastraPresentUiInputError extends TypeError {
  readonly code = "mastra.present-ui-input-invalid";

  constructor(summary: string) {
    super(`present_ui input is invalid: ${summary}`);
    this.name = "MastraPresentUiInputError";
  }
}

export class MastraPresentUiExecutionContextError extends TypeError {
  readonly code = "mastra.present-ui-tool-call-id-missing";

  constructor() {
    super("Incremental present_ui execution requires an agent toolCallId or workflow runId.");
    this.name = "MastraPresentUiExecutionContextError";
  }
}

type MastraToolHooks<TResult> = Readonly<{
  compiled: CompiledPresentUi;
  execute: MastraPresentUiExecutor<TResult>;
  toModelOutput?: (output: TResult) => unknown;
  onInputStart?: NonNullable<MastraPresentUiTool<TResult>["onInputStart"]>;
  onInputDelta?: NonNullable<MastraPresentUiTool<TResult>["onInputDelta"]>;
  onInputAvailable?: NonNullable<MastraPresentUiTool<TResult>["onInputAvailable"]>;
}>;

function createMastraTool<TResult>(
  options: MastraToolHooks<TResult>,
): MastraPresentUiTool<TResult> {
  const inputSchema = z.fromJSONSchema(
    options.compiled.providerInputSchema as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodType<PresentUiAuthoringInput>;
  const presentUi = createTool({
    id: options.compiled.tool.name,
    description: options.compiled.tool.description,
    inputSchema,
    strict: options.compiled.tool.strict,
    mcp: {
      annotations: {
        title: "Open Generative interface",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    execute: async (input, context) => options.execute(input, context),
    ...(options.onInputStart ? { onInputStart: options.onInputStart } : {}),
    ...(options.onInputDelta ? { onInputDelta: options.onInputDelta } : {}),
    ...(options.onInputAvailable ? { onInputAvailable: options.onInputAvailable } : {}),
    toModelOutput: (output: unknown) => (
      options.toModelOutput ? options.toModelOutput(output as TResult) : SAFE_MODEL_OUTPUT
    ),
    transform: createPayloadTransform(),
  });
  return presentUi as MastraPresentUiTool<TResult>;
}

function createMastraAdapter<TResult>(
  compiled: CompiledPresentUi,
  presentUi: MastraPresentUiTool<TResult>,
) {
  return Object.freeze({
    system: compiled.systemPrompt,
    compiled,
    tools: Object.freeze({ present_ui: presentUi }),
    tracingOptions: MASTRA_PRESENT_UI_TRACING_OPTIONS,
  });
}

function validateInput(
  compiled: CompiledPresentUi,
  input: unknown,
): PresentUiAuthoringInput {
  const validated = validatePresentUiInput(compiled, input);
  if (!validated.success) {
    throw new MastraPresentUiInputError(schemaIssueSummary(validated));
  }
  return validated.data as PresentUiAuthoringInput;
}

function createPayloadTransform(): ToolPayloadTransform<PresentUiAuthoringInput, unknown> {
  return {
    display: {
      input: () => SAFE_INPUT,
      inputDelta: () => SAFE_INPUT,
      output: () => SAFE_OUTPUT,
      error: () => SAFE_ERROR,
      approval: () => SAFE_APPROVAL,
      suspend: () => SAFE_SUSPEND,
      resume: () => SAFE_RESUME,
    },
    transcript: {
      input: () => SAFE_INPUT,
      inputDelta: () => SAFE_INPUT,
      output: () => SAFE_OUTPUT,
      error: () => SAFE_ERROR,
      approval: () => SAFE_APPROVAL,
      suspend: () => SAFE_SUSPEND,
      resume: () => SAFE_RESUME,
    },
  };
}

function redactObservability(context: ToolExecutionContext): ToolExecutionContext {
  const {
    observe = noopObserve,
    tracing,
    tracingContext: _tracingContext,
    loggerVNext: _loggerVNext,
    metrics: _metrics,
    ...executionContext
  } = context;
  tracing?.currentSpan?.update({ input: SAFE_INPUT });
  return {
    ...executionContext,
    observe: createRedactedObserve(observe),
  };
}

function createRedactedObserve(observe: ToolObserve): ToolObserve {
  return {
    span(_name, fn) {
      return observe.span("open-generative.present-ui", fn, SAFE_OBSERVABILITY);
    },
    log(level) {
      observe.log(
        level,
        "Open Generative present_ui lifecycle event.",
        SAFE_OBSERVABILITY,
      );
    },
  };
}

function compilerOutcomeModelOutput(outcome: CompilerTurnOutcome) {
  if (outcome.status === "committed") return SAFE_MODEL_OUTPUT;
  const diagnosticCodes = [...new Set(outcome.diagnostics
    .map((diagnostic) => diagnostic.code)
    .filter(isSafeDiagnosticCode))]
    .slice(0, 4);
  return {
    type: "text" as const,
    value: diagnosticCodes.length === 0
      ? "The interface proposal was rejected. Submit one corrected present_ui proposal."
      : `The interface proposal was rejected. Correct these diagnostics: ${diagnosticCodes.join(", ")}.`,
  };
}

function isSafeDiagnosticCode(code: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{0,95}$/i.test(code);
}

function executionContextToToolCallOptions(
  context: ToolExecutionContext,
): MastraPresentUiIncrementalContext {
  const agent = context.agent;
  if (agent?.toolCallId) {
    return {
      toolCallId: agent.toolCallId,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    };
  }
  const workflow = context.workflow;
  if (workflow?.runId) {
    return {
      toolCallId: `${workflow.workflowId}:${workflow.runId}:present_ui`,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    };
  }
  throw new MastraPresentUiExecutionContextError();
}

function hookContextToIncrementalContext(
  context: Parameters<NonNullable<MastraPresentUiTool<unknown>["onInputStart"]>>[0],
): MastraPresentUiIncrementalContext {
  return {
    toolCallId: context.toolCallId,
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
}

function mastraRequestKey(
  context: Parameters<NonNullable<MastraPresentUiTool<unknown>["onInputStart"]>>[0],
): object | undefined {
  if (context.abortSignal) return context.abortSignal;
  if (
    (typeof context.experimental_context === "object" && context.experimental_context !== null)
    || typeof context.experimental_context === "function"
  ) {
    return context.experimental_context;
  }
  return undefined;
}
