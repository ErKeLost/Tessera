import { describe, expect, test } from "bun:test";
import type {
  CompiledPresentUi,
  CompilerTurnOutcome,
  IncrementalPresentUiSession,
  PresentUiAuthoringInput,
} from "@open-generative/compiler";
import { revisionIdSchema, sha256HashSchema } from "@open-generative/protocol";
import { asSchema } from "ai";
import { createIncrementalPresentUiTool, createPresentUiTool } from "./server";

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
});

function committedOutcome(): CompilerTurnOutcome {
  return {
    status: "committed",
    revisionId: revisionIdSchema.parse("revision-ai-sdk"),
    contentHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    commands: [],
  };
}
