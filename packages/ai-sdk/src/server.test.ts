import { describe, expect, test } from "bun:test";
import type {
  CompiledPresentUi,
  CompilerTurnOutcome,
  IncrementalPresentUiSession,
  PresentUiAuthoringInput,
} from "@open-generative/compiler";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  hashCanonical,
  revisionIdSchema,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
} from "@open-generative/protocol";
import { asSchema, jsonSchema } from "ai";
import {
  createIncrementalPresentUiTool,
  createOpenGenerativeAISdkAdapter,
  createPresentUiTool,
  toOpenGenerativeSurfaceDataChunk,
} from "./server";

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

describe("AI SDK v7 present_ui adapter", () => {
  test("uses the compiler schema and delegates execution", async () => {
    const inputs: PresentUiAuthoringInput[] = [];
    const presentUi = createPresentUiTool({
      compiled,
      execute(input) {
        inputs.push(input);
        return { accepted: true };
      },
    });

    expect(presentUi.strict).toBe(true);
    expect(presentUi.description).toBe("Present UI.");
    const schema = asSchema(presentUi.inputSchema);
    const valid = await schema.validate?.({ kind: "snapshot" });
    const invalid = await schema.validate?.({ kind: "operations" });
    expect(valid?.success).toBe(true);
    expect(invalid?.success).toBe(false);

    const output = await presentUi.execute?.(
      { kind: "snapshot" } as PresentUiAuthoringInput,
      {} as never,
    );
    expect(output).toEqual({ accepted: true });
    expect(inputs).toHaveLength(1);
    expect(await presentUi.toModelOutput?.({
      toolCallId: "tool-call-present-ui",
      input: { kind: "snapshot" },
      output: { rows: [{ secret: "must-not-reach-the-model" }] },
    } as never)).toEqual({
      type: "text",
      value: "The Open Generative host processed the interface proposal.",
    });
  });

  test("routes tool input deltas into one bounded incremental compiler session", async () => {
    const calls: string[] = [];
    const outcome = committedOutcome();
    const session: IncrementalPresentUiSession<CompilerTurnOutcome> = {
      start: async () => { calls.push("start"); return undefined; },
      pushTextDelta: async (delta) => { calls.push(`delta:${delta}`); return undefined; },
      complete: async () => { calls.push("complete"); return outcome; },
      abort: async () => outcome,
    };
    const presentUi = createIncrementalPresentUiTool({
      compiled,
      maxAttempts: 1,
      createSession: async () => session,
    });
    const context = {
      toolCallId: "tool-call-streamed",
      messages: [],
      context: {},
    };

    await presentUi.onInputStart?.(context as never);
    await presentUi.onInputDelta?.({ ...context, inputTextDelta: '{"kind":"operations"' } as never);
    expect(calls).toEqual(["start", 'delta:{"kind":"operations"']);
    await presentUi.onInputAvailable?.({ ...context, input: { kind: "snapshot" } } as never);
    expect(await presentUi.execute?.({ kind: "snapshot" } as never, context as never)).toEqual(outcome);
    expect(calls).toEqual(["start", 'delta:{"kind":"operations"', "complete", "complete"]);

    await expect(presentUi.onInputStart?.({ ...context, toolCallId: "tool-call-repair-over-budget" } as never))
      .rejects.toMatchObject({ code: "present-ui.repair-budget-exhausted", maxAttempts: 1 });
  });

  test("activates present_ui through AI SDK v7 prepareStep only after resources are ready", async () => {
    let ready = false;
    let committed = false;
    let resolveCalls = 0;
    const pendingEvents: ReturnType<typeof surfaceEvent> extends Promise<infer T> ? T[] : never = [];
    const written: unknown[] = [];
    const outcome = committedOutcome();
    const session: IncrementalPresentUiSession<CompilerTurnOutcome> = {
      start: async () => undefined,
      pushTextDelta: async () => undefined,
      complete: async () => outcome,
      abort: async () => outcome,
    };
    const turn = {
      compiled,
      createSession: async () => session,
      isCommitted: () => committed,
      drainEvents: () => pendingEvents.splice(0),
    };
    const integration = createOpenGenerativeAISdkAdapter({
      tools: {
        run_analysis: {
          inputSchema: jsonSchema({ type: "object", properties: {}, additionalProperties: false }),
          execute: async () => ({ status: "completed" }),
        },
      },
      resolve: () => {
        resolveCalls += 1;
        return ready ? turn : undefined;
      },
      writer: { write: (chunk) => { written.push(chunk); } },
    });
    const context = {
      steps: [],
      stepNumber: 0,
      model: {},
      instructions: "Base instructions.",
      initialInstructions: "Base instructions.",
      messages: [],
      initialMessages: [],
      responseMessages: [],
      toolsContext: {},
      runtimeContext: {},
    } as any;

    const before = await integration.prepareStep(context) as any;
    expect(before.activeTools).toEqual(["run_analysis"]);
    expect(before.instructions).toBe("Base instructions.");

    ready = true;
    const after = await integration.prepareStep({ ...context, stepNumber: 1 }) as any;
    expect(after.activeTools).toEqual(["run_analysis", "present_ui"]);
    expect(after.instructions).toContain("<open-generative-present-ui>");
    expect(after.instructions).toContain("Use present_ui.");
    const output = await integration.tools.present_ui?.execute?.(
      { kind: "snapshot" } as never,
      { toolCallId: "tool-call-high-level" } as never,
    );
    expect(output).toEqual(outcome);

    committed = true;
    pendingEvents.push(await surfaceEvent());
    const committedStep = await integration.prepareStep({ ...context, stepNumber: 2 }) as any;
    expect(committedStep.activeTools).toEqual(["run_analysis"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: "data-openGenerativeSurface" });
    expect(resolveCalls).toBe(2);
  });

  test("delivers surfaces as renderable message parts by default", async () => {
    const event = await surfaceEvent();

    expect(await toOpenGenerativeSurfaceDataChunk(event)).toEqual({
      type: "data-openGenerativeSurface",
      id: "event-ai-sdk-1",
      data: event,
    });
    expect(await toOpenGenerativeSurfaceDataChunk(event, { transient: true })).toMatchObject({
      type: "data-openGenerativeSurface",
      transient: true,
    });
  });
});

async function surfaceEvent() {
  const payload = {
    type: "rejected" as const,
    transactionId: "transaction-ai-sdk",
    diagnostics: [{
      phase: "validate" as const,
      code: "validate.fixture",
      severity: "error" as const,
      recoverable: true,
      modelCorrectable: true,
      message: "Fixture rejection.",
    }],
  };
  return surfaceEventEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: "surface-ai-sdk",
    streamId: "stream-ai-sdk",
    epoch: 1,
    sequence: 1,
    eventId: "event-ai-sdk-1",
    cursor: "cursor-ai-sdk-0001",
    committedRevisionId: "revision-ai-sdk",
    audienceBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    contractSetHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
    correlationId: "correlation-ai-sdk",
    payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload),
    payload,
  });
}

function committedOutcome(): CompilerTurnOutcome {
  return {
    status: "committed",
    revisionId: revisionIdSchema.parse("revision-ai-sdk"),
    contentHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    commands: [],
  };
}
