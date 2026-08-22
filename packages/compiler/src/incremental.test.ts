import { describe, expect, test } from "bun:test";
import {
  operationIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  type Diagnostic,
  type ProposalOperationEnvelope,
} from "@open-generative/protocol";
import {
  IncrementalPresentUiCompilerSession,
} from "./incremental";
import type { ProposalCompilerTurn } from "./turn";
import type {
  CompiledPresentUi,
  CompilerTurnOutcome,
  PresentUiAuthoringInput,
} from "./types";

type OperationsInput = Extract<PresentUiAuthoringInput, { kind: "operations" }>;

describe("incremental present_ui compiler session", () => {
  test("applies each complete operation before the full tool input is available", async () => {
    const turn = fakeTurn();
    const session = createSession(turn);
    const input = operationsInput("First", "Second");
    const wire = JSON.stringify({ operations: input.operations, kind: "operations" });
    const second = wire.indexOf(JSON.stringify(input.operations[1]));

    expect(await session.pushTextDelta(wire.slice(0, second + 7))).toBeUndefined();
    expect(turn.operations).toHaveLength(1);
    expect(turn.finished).toBe(false);

    expect(await session.pushTextDelta(wire.slice(second + 7))).toBeUndefined();
    expect(turn.operations).toHaveLength(2);
    expect(await session.complete(input)).toMatchObject({ status: "committed" });
    expect(turn.finished).toBe(true);
  });

  test("never applies an incomplete operation tail and aborts on stream/final mismatch", async () => {
    const turn = fakeTurn();
    const session = createSession(turn);
    const input = operationsInput("Stable", "Must not preview");
    const wire = JSON.stringify(input);
    const second = wire.indexOf(JSON.stringify(input.operations[1]));

    await session.pushTextDelta(wire.slice(0, second + 12));
    expect(turn.operations.map((operation) => operation.sequence)).toEqual([1]);

    const outcome = await session.complete(input);
    expect(outcome.status).toBe("aborted");
    expect(turn.operations.map((operation) => operation.sequence)).toEqual([1]);
    expect(turn.cancelled[0]?.code).toBe("present-ui.partial-tail");
  });

  test("rejects duplicate keys before a streamed operation reaches the turn", async () => {
    const turn = fakeTurn();
    const session = createSession(turn);
    const operation = JSON.stringify(operationInput(1, "Duplicate")).replace(
      '"operationId":"operation-1"',
      '"operationId":"operation-shadow","operationId":"operation-1"',
    );
    const outcome = await session.pushTextDelta(`{"kind":"operations","operations":[${operation}]}`);

    expect(outcome?.status).toBe("aborted");
    expect(turn.operations).toEqual([]);
    expect(turn.cancelled[0]?.code).toBe("decode.duplicate-key");
  });
});

function createSession(turn: ReturnType<typeof fakeTurn>) {
  return new IncrementalPresentUiCompilerSession({
    compiled,
    turn: turn as unknown as ProposalCompilerTurn,
  });
}

function operationsInput(first: string, second: string): OperationsInput {
  return {
    kind: "operations",
    operations: [operationInput(1, first), operationInput(2, second)],
  };
}

function operationInput(
  sequence: number,
  title: string,
): OperationsInput["operations"][number] {
  return {
    operationId: operationIdSchema.parse(`operation-${sequence}`),
    sequence,
    dependsOn: sequence === 1 ? [] : [operationIdSchema.parse(`operation-${sequence - 1}`)],
    operation: {
      op: "set-meta",
      value: { title, tags: [] },
    },
  };
}

const compiled = {
  maxOperations: 8,
  canonicalInputSchema: {
    type: "object",
    properties: {
      kind: { const: "operations" },
      operations: { type: "array", minItems: 1, maxItems: 8, items: { type: "object" } },
    },
    required: ["kind", "operations"],
    additionalProperties: false,
  },
} as Pick<CompiledPresentUi, "canonicalInputSchema" | "maxOperations">;

function fakeTurn() {
  const operations: ProposalOperationEnvelope[] = [];
  const cancelled: Diagnostic[] = [];
  const committed = {
    status: "committed",
    revisionId: revisionIdSchema.parse("revision-incremental"),
    contentHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    commands: [],
  } satisfies CompilerTurnOutcome;
  const aborted = (): CompilerTurnOutcome => ({
    status: "aborted",
    commands: [],
    diagnostics: [...cancelled],
  });
  return {
    operations,
    cancelled,
    finished: false,
    start: async () => undefined,
    pushDecodedOperation: async (operation: ProposalOperationEnvelope) => {
      operations.push(operation);
      return undefined;
    },
    finishDecodedOperations: async function () {
      this.finished = true;
      return committed;
    },
    runDecoded: async () => committed,
    cancel: async (_reason: string, ...diagnostics: Diagnostic[]) => {
      cancelled.push(...diagnostics);
      return aborted();
    },
  };
}
