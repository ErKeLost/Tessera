import { describe, expect, test } from "bun:test";
import type {
  CompiledPresentUi,
  CompilerTurnOutcome,
  IncrementalPresentUiSession,
  PresentUiAuthoringInput,
} from "@open-generative/compiler";
import type { ToolExecutionContext, ToolObserve } from "@mastra/core/tools";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  hashCanonical,
  revisionIdSchema,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  MASTRA_PRESENT_UI_TRACING_OPTIONS,
  createMastraIncrementalPresentUi,
  createMastraPresentUi,
  createMastraPresentUiProcessor,
  createOpenGenerativeMastraProcessor,
  type MastraPresentUiIncrementalContext,
} from "./index";

const compiled = {
  catalogSliceHash: "0".repeat(64),
  contractSetHash: "1".repeat(64),
  providerSchemaProfile: "canonical",
  canonicalInputSchema: {
    type: "object",
    properties: { kind: { const: "snapshot" } },
    required: ["kind"],
    additionalProperties: false,
  },
  providerInputSchema: {
    type: "object",
    properties: { kind: { const: "snapshot" } },
    required: ["kind"],
    additionalProperties: false,
  },
  tool: {
    name: "present_ui",
    description: "Present UI.",
    strict: true,
    inputSchema: {},
  },
  systemPrompt: "Use present_ui.",
} as unknown as CompiledPresentUi;

const proposal = { kind: "snapshot" } as PresentUiAuthoringInput;

describe("Mastra 1.61 present_ui adapter", () => {
  test("creates a real Mastra tool from the compiler schema", async () => {
    const inputs: PresentUiAuthoringInput[] = [];
    const adapter = createMastraPresentUi({
      compiled,
      execute(input) {
        inputs.push(input);
        return { accepted: true };
      },
    });
    const presentUi = adapter.tools.present_ui;

    expect(presentUi.id).toBe("present_ui");
    expect(presentUi.strict).toBe(true);
    expect(adapter.system).toBe("Use present_ui.");
    expect(adapter.tracingOptions).toBe(MASTRA_PRESENT_UI_TRACING_OPTIONS);
    expect(adapter.tracingOptions).toEqual({ hideInput: true, hideOutput: true });
    expect(z.safeParse(presentUi.inputSchema as z.ZodType, proposal).success).toBe(true);
    expect(z.safeParse(presentUi.inputSchema as z.ZodType, { kind: "operations" }).success).toBe(false);

    const output = await presentUi.execute?.(proposal, {} as never);
    expect(output).toEqual({ accepted: true });
    expect(inputs).toEqual([proposal]);
  });

  test("redacts model, display, transcript, memory, and observability boundaries", async () => {
    const secret = "proposal-payload-must-never-leave";
    const observations: unknown[] = [];
    const spanUpdates: unknown[] = [];
    let executorObservabilityChannels: unknown;
    const observe: ToolObserve = {
      async span(name, fn, attributes) {
        observations.push({ kind: "span", name, attributes });
        return fn();
      },
      log(level, message, data) {
        observations.push({ kind: "log", level, message, data });
      },
    };
    const adapter = createMastraPresentUi({
      compiled,
      async execute(_input, context) {
        executorObservabilityChannels = {
          tracing: context.tracing,
          tracingContext: context.tracingContext,
          loggerVNext: context.loggerVNext,
          metrics: context.metrics,
        };
        context.observe.log("info", secret, { secret });
        await context.observe.span(secret, async () => undefined, { secret });
        return { accepted: true, secret };
      },
    });
    const presentUi = adapter.tools.present_ui;
    const context = {
      observe,
      tracing: {
        currentSpan: {
          update(value: unknown) {
            spanUpdates.push(value);
          },
        },
      },
    } as unknown as ToolExecutionContext;
    const executionOutput = await presentUi.execute?.(proposal, context as never);

    const transformContexts = {
      input: { input: { kind: "snapshot", secret } },
      inputDelta: { inputTextDelta: JSON.stringify({ secret }) },
      output: { output: executionOutput },
      error: { error: new Error(secret) },
      approval: { input: { kind: "snapshot", secret } },
      suspend: { suspendPayload: { secret } },
      resume: { resumeData: { secret } },
    } as const;
    const transformed: unknown[] = [];
    for (const target of [presentUi.transform?.display, presentUi.transform?.transcript]) {
      transformed.push(
        await target?.input?.(transformContexts.input as never),
        await target?.inputDelta?.(transformContexts.inputDelta as never),
        await target?.output?.(transformContexts.output as never),
        await target?.error?.(transformContexts.error as never),
        await target?.approval?.(transformContexts.approval as never),
        await target?.suspend?.(transformContexts.suspend as never),
        await target?.resume?.(transformContexts.resume as never),
      );
    }
    const modelOutput = presentUi.toModelOutput?.({ secret } as never);
    const incrementalAdapter = createMastraIncrementalPresentUi({
      compiled,
      createSession: () => idempotentSession([], committedOutcome()),
    });
    const rejectedModelOutput = incrementalAdapter.tools.present_ui.toModelOutput?.({
      status: "rejected",
      commands: [],
      diagnostics: [{
        phase: "decode",
        code: "present-ui.partial-tail",
        severity: "error",
        message: secret,
        recoverable: false,
        modelCorrectable: true,
      }],
    } satisfies CompilerTurnOutcome);

    expect(JSON.stringify({
      transformed,
      modelOutput,
      rejectedModelOutput,
      observations,
      spanUpdates,
    })).not.toContain(secret);
    expect(presentUi.transform?.transcript?.input?.({ input: { secret } } as never)).toEqual({
      type: "open-generative-proposal",
      redacted: true,
    });
    expect(modelOutput).toEqual({
      type: "text",
      value: "The Open Generative host processed the interface proposal.",
    });
    expect(rejectedModelOutput).toEqual({
      type: "text",
      value: "The interface proposal was rejected. Correct these diagnostics: present-ui.partial-tail.",
    });
    expect(observations).toEqual([
      {
        kind: "log",
        level: "info",
        message: "Open Generative present_ui lifecycle event.",
        data: { type: "open-generative-observability", redacted: true },
      },
      {
        kind: "span",
        name: "open-generative.present-ui",
        attributes: { type: "open-generative-observability", redacted: true },
      },
    ]);
    expect(spanUpdates).toEqual([{
      input: { type: "open-generative-proposal", redacted: true },
    }]);
    expect(executorObservabilityChannels).toEqual({
      tracing: undefined,
      tracingContext: undefined,
      loggerVNext: undefined,
      metrics: undefined,
    });
  });

  test("injects the turn-scoped tool and generated prompt only after resources are ready", async () => {
    const adapter = createMastraPresentUi({ compiled, execute: async () => ({ accepted: true }) });
    let ready = false;
    const processor = createMastraPresentUiProcessor({
      resolve: () => ready ? adapter : undefined,
    });
    const args: any = {
      stepNumber: 0,
      messages: [],
      messageList: {},
      systemMessages: [{ role: "system", content: "Base instructions." }],
      state: {},
      steps: [],
      model: "openai/test",
      tools: { run_analysis: { id: "run_analysis" } },
      activeTools: ["run_analysis"],
      retryCount: 0,
      abort: () => { throw new Error("aborted"); },
    };

    expect(await processor.processInputStep?.(args)).toBeUndefined();
    ready = true;
    const injected = await processor.processInputStep?.(args) as any;
    expect(injected.tools.run_analysis.id).toBe("run_analysis");
    expect(injected.tools.present_ui).toBe(adapter.tools.present_ui);
    expect(injected.activeTools).toEqual(["run_analysis", "present_ui"]);
    expect(injected.systemMessages).toHaveLength(2);
    expect(injected.systemMessages[1].content).toContain("Use present_ui.");

    const reinjected = await processor.processInputStep?.({
      ...args,
      systemMessages: injected.systemMessages,
      tools: injected.tools,
      activeTools: injected.activeTools,
    } as never) as any;
    expect(reinjected.systemMessages).toHaveLength(2);
  });

  test("exposes the low-intrusion Processor from a Host turn", async () => {
    let ready = false;
    let committed = false;
    let resolveCalls = 0;
    const surfacePayload = {
      type: "rejected",
      diagnostics: [{
        phase: "validate",
        code: "validate.test",
        severity: "error",
        recoverable: true,
        modelCorrectable: true,
        message: "Test event.",
      }],
    } as const;
    const event = surfaceEventEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-test",
      streamId: "stream-test",
      epoch: 1,
      sequence: 1,
      eventId: "event-test",
      cursor: "cursor-opaque-test",
      committedRevisionId: "revision-test",
      audienceBindingHash: sha256HashSchema.parse(`sha256:${"2".repeat(64)}`),
      contractSetHash: sha256HashSchema.parse(`sha256:${"3".repeat(64)}`),
      correlationId: "correlation-test",
      payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, surfacePayload),
      payload: surfacePayload,
    });
    const chunks: unknown[] = [];
    const turn = {
      compiled,
      createSession: () => idempotentSession([], committedOutcome()),
      isCommitted: () => committed,
      drainEvents: () => committed ? [event] : [],
    };
    const processor = createOpenGenerativeMastraProcessor({
      resolve: () => {
        resolveCalls += 1;
        return ready ? turn : undefined;
      },
    });
    const args: any = {
      stepNumber: 0,
      messages: [],
      messageList: {},
      systemMessages: [{ role: "system", content: "Base instructions." }],
      state: {},
      steps: [],
      model: "openai/test",
      tools: { run_analysis: { id: "run_analysis" } },
      activeTools: ["run_analysis"],
      retryCount: 0,
      abort: () => { throw new Error("aborted"); },
      writer: { custom: async (chunk: unknown) => { chunks.push(chunk); } },
    };

    expect(await processor.processInputStep?.(args)).toBeUndefined();
    ready = true;
    const injected = await processor.processInputStep?.(args) as any;
    expect(injected.tools.present_ui.id).toBe("present_ui");
    expect(injected.systemMessages[1].content).toContain("Use present_ui.");

    committed = true;
    expect(await processor.processInputStep?.({ ...args, stepNumber: 2 })).toBeUndefined();
    expect(chunks).toEqual([{ type: "data-openGenerativeSurface", id: "event-test", data: event }]);
    expect(resolveCalls).toBe(2);
  });

  test("routes Mastra input hooks and execute through one incremental compiler session", async () => {
    const calls: string[] = [];
    const contexts: MastraPresentUiIncrementalContext[] = [];
    const result = committedOutcome();
    const adapter = createMastraIncrementalPresentUi({
      compiled,
      maxAttempts: 2,
      createSession(context) {
        contexts.push(context);
        return idempotentSession(calls, result);
      },
    });
    const presentUi = adapter.tools.present_ui;
    const abortController = new AbortController();
    const hookContext = {
      toolCallId: "tool-call-streamed",
      messages: [],
      abortSignal: abortController.signal,
    };

    await presentUi.onInputStart?.(hookContext);
    await presentUi.onInputDelta?.({ ...hookContext, inputTextDelta: "{\"kind\":" });
    await presentUi.onInputAvailable?.({ ...hookContext, input: proposal });
    const output = await presentUi.execute?.(proposal, {
      abortSignal: abortController.signal,
      agent: { toolCallId: hookContext.toolCallId, messages: [] },
    } as never);

    expect(output).toBe(result);
    expect(calls).toEqual(["start", "delta:{\"kind\":", "complete"]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.toolCallId).toBe("tool-call-streamed");
    expect(contexts[0]?.abortSignal).toBe(abortController.signal);

    await presentUi.onInputStart?.({ ...hookContext, toolCallId: "tool-call-repair" });
    await expect(presentUi.onInputStart?.({ ...hookContext, toolCallId: "tool-call-over-budget" }))
      .rejects.toMatchObject({ code: "present-ui.repair-budget-exhausted", maxAttempts: 2 });
  });

  test("binds abort signals and isolates the repair budget by Mastra request", async () => {
    const abortController = new AbortController();
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
    const adapter = createMastraIncrementalPresentUi({
      compiled,
      maxAttempts: 1,
      createSession: () => ({
        start: async () => undefined,
        pushTextDelta: async () => undefined,
        complete: async () => committedOutcome(),
        abort: async () => {
          resolveAbort();
          return committedOutcome();
        },
      }),
    });
    const hookContext = {
      toolCallId: "tool-call-aborted",
      messages: [],
      abortSignal: abortController.signal,
    };

    await adapter.tools.present_ui.onInputStart?.(hookContext);
    abortController.abort();
    await aborted;
    await expect(adapter.tools.present_ui.onInputStart?.({
      toolCallId: "tool-call-over-budget",
      messages: [],
      abortSignal: abortController.signal,
    })).rejects.toMatchObject({ code: "present-ui.repair-budget-exhausted" });

    const nextRequestAbort = new AbortController();
    await expect(adapter.tools.present_ui.onInputStart?.({
      toolCallId: "tool-call-new-request",
      messages: [],
      abortSignal: nextRequestAbort.signal,
    })).resolves.toBeUndefined();
  });
});

function idempotentSession<TResult>(
  calls: string[],
  result: TResult,
): IncrementalPresentUiSession<TResult> {
  let completion: Promise<TResult> | undefined;
  return {
    start: async () => {
      calls.push("start");
      return undefined;
    },
    pushTextDelta: async (delta) => {
      calls.push(`delta:${delta}`);
      return undefined;
    },
    complete: async () => {
      completion ??= Promise.resolve().then(() => {
        calls.push("complete");
        return result;
      });
      return completion;
    },
    abort: async () => result,
  };
}

function committedOutcome(): CompilerTurnOutcome {
  return {
    status: "committed",
    revisionId: revisionIdSchema.parse("revision-mastra"),
    contentHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    commands: [],
  };
}
