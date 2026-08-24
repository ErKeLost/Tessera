import { describe, expect, test } from "bun:test";
import type {
  AuthoringProposalOperation,
  Diagnostic,
  ProposalOperationEnvelope,
} from "@open-generative/protocol";
import {
  OpenGenerativeLanguageDecoder,
  OpenGenerativeLanguageSyntaxError,
  parseOpenGenerativeLanguageStatement,
  type CompiledOpenGenerativeLanguage,
} from "./language";
import {
  createOpenGenerativeLanguageSession,
  type OpenGenerativeCompilerTurnPort,
} from "./language-session";
import type { CompilerCatalogLike, CompilerTurnOutcome } from "./types";

const HASH = `sha256:${"1".repeat(64)}`;

const compiled = {
  id: "open-generative-language/1",
  catalogSliceHash: HASH,
  contractSetHash: HASH,
  maxOperations: 64,
  systemPrompt: "test",
  resources: [{
    alias: "data1",
    sliceResourceId: "resource-000001",
    bindingId: "resource-analysis",
    label: "Registrations",
    columns: [
      { id: "channel", label: "Channel", type: "string" },
      { id: "registrations", label: "Registrations", type: "number" },
    ],
  }],
  components: [
    component("analysis.report", "component-000001"),
    component("layout.stack", "component-000002"),
    component("layout.grid", "component-000003"),
    component("data.metric", "component-000004"),
    component("data.chart", "component-000005"),
    component("analysis.insight", "component-000006"),
  ],
} as unknown as CompiledOpenGenerativeLanguage;

const catalog = { slice: { limits: { maxOperations: 64 } } } as unknown as CompilerCatalogLike;

describe("Open Generative Language", () => {
  test("parses resource aliases, objects, calls, and forward references", () => {
    const chart = parseOpenGenerativeLanguageStatement(
      'chart = Chart(@data1, {"recipe":"devices-bars","valueColumn":"registrations"})',
    );
    expect(chart).toMatchObject({
      name: "chart",
      expression: {
        kind: "call",
        callee: "Chart",
      },
    });
    expect(chart.expression.kind === "call" ? chart.expression.arguments[0] : undefined).toEqual({
      kind: "resource",
      alias: "data1",
    });
    expect(parseOpenGenerativeLanguageStatement(
      'root = Report("Registrations", "Verified", content)',
    )).toMatchObject({
      expression: {
        kind: "call",
        arguments: [{ kind: "literal", value: "Registrations" }, { kind: "literal", value: "Verified" }, { kind: "reference", name: "content" }],
      },
    });
  });

  test("holds an incomplete final statement until its boundary arrives", () => {
    const decoder = new OpenGenerativeLanguageDecoder();
    expect(decoder.push('root = Report("Registr')).toEqual([]);
    expect(decoder.push('ations", "Verified", content)')).toEqual([]);
    expect(decoder.push("\n")).toHaveLength(1);
    expect(() => new OpenGenerativeLanguageDecoder().finish()).not.toThrow();
    expect(() => parseOpenGenerativeLanguageStatement("root = Report(")).toThrow(OpenGenerativeLanguageSyntaxError);
  });

  test("publishes a root with an empty layout, then incrementally updates that layout", async () => {
    const turn = new RecordingTurn();
    const session = createOpenGenerativeLanguageSession({
      compiled,
      catalog,
      turn,
      expectedRootId: "node-base" as never,
    });

    expect((await session.pushTextDelta(
      'root = Report("Registrations", "Verified result", content)\n',
    )).renderable).toBe(false);
    expect(turn.operations).toHaveLength(0);

    expect((await session.pushTextDelta('content = Stack("md", [metric])\n')).renderable).toBe(true);
    expect(turn.operations.map(operationName)).toEqual([
      "put-node:content",
      "put-node:root",
      "set-root:root",
    ]);

    await session.pushTextDelta('metric = Metric("Total registrations", @data1, "registrations", "compact")\n');
    expect(turn.operations.map(operationName).slice(-2)).toEqual([
      "put-node:metric",
      "put-node:content",
    ]);
    expect((await session.finish()).status).toBe("committed");
  });

  test("adds governed chart defaults without copying dataset rows into OGL", async () => {
    const turn = new RecordingTurn();
    const session = createOpenGenerativeLanguageSession({
      compiled,
      catalog,
      turn,
      expectedRootId: "node-base" as never,
    });
    await session.pushTextDelta([
      'root = Report("Registrations", "Verified result", content)',
      'content = Stack("md", [chart])',
      'chart = Chart(@data1, {"recipe":"devices-bars","title":"Registrations by channel","deviceColumn":"channel","valueColumn":"registrations"})',
      "",
    ].join("\n"));
    const chart = [...turn.operations].reverse().find((operation) => (
      operation.op === "put-node" && operation.target.kind === "node" && "localId" in operation.target && operation.target.localId === "chart"
    ));
    expect(chart?.op).toBe("put-node");
    if (chart?.op !== "put-node") throw new Error("Missing chart operation.");
    expect(chart.value.props.spec).toMatchObject({
      object: {
        recipe: "devices-bars",
        data: { ref: "resource", target: { kind: "resource", canonicalId: "resource-analysis" } },
        equivalentView: "table",
        accessibility: { object: { label: "Registrations by channel" } },
      },
    });
    expect(JSON.stringify(chart.value.props.spec)).not.toContain("rows");
  });

  test("rejects an unknown governed resource alias", async () => {
    const turn = new RecordingTurn();
    const session = createOpenGenerativeLanguageSession({
      compiled,
      catalog,
      turn,
      expectedRootId: "node-base" as never,
    });
    await session.pushTextDelta([
      'root = Report("Registrations", "Verified result", content)',
      'content = Stack("md", [chart])',
      'chart = Chart(@missing, {"recipe":"devices-bars","title":"Invalid"})',
      "",
    ].join("\n"));
    const outcome = await session.finish();
    expect(outcome.status).toBe("rejected");
    expect(turn.diagnostics[0]?.message).toContain("@missing");
  });

  test("reassigning a semantic name targets the same proposal-local node", async () => {
    const turn = new RecordingTurn();
    const session = createOpenGenerativeLanguageSession({
      compiled,
      catalog,
      turn,
      expectedRootId: "node-base" as never,
    });
    await session.pushTextDelta([
      'root = Report("Registrations", "Verified result", content)',
      'content = Stack("md", [metric])',
      'metric = Metric("First label", @data1, "registrations", "number")',
      "",
    ].join("\n"));
    await session.pushTextDelta('metric = Metric("Updated label", @data1, "registrations", "number")\n');
    const metrics = turn.operations.filter((operation) => (
      operation.op === "put-node" && "localId" in operation.target && operation.target.localId === "metric"
    ));
    expect(metrics).toHaveLength(2);
    expect(metrics.every((operation) => operation.op === "put-node" && "localId" in operation.target && operation.target.localId === "metric")).toBe(true);
  });
});

function component(type: string, sliceComponentId: string) {
  return {
    type,
    sliceComponentId,
    requiredProps: [],
    recipeRequiredProps: {},
    slots: {},
  };
}

function operationName(operation: AuthoringProposalOperation): string {
  if (operation.op === "set-root") {
    return `set-root:${"localId" in operation.node ? operation.node.localId : operation.node.canonicalId}`;
  }
  if ("target" in operation) {
    return `${operation.op}:${"localId" in operation.target ? operation.target.localId : operation.target.canonicalId}`;
  }
  return operation.op;
}

class RecordingTurn implements OpenGenerativeCompilerTurnPort {
  readonly operations: AuthoringProposalOperation[] = [];
  readonly diagnostics: Diagnostic[] = [];

  async start(): Promise<undefined> {
    return undefined;
  }

  async pushDecodedOperation(envelope: ProposalOperationEnvelope): Promise<undefined> {
    this.operations.push(envelope.operation);
    return undefined;
  }

  async finishDecodedOperations(): Promise<CompilerTurnOutcome> {
    return {
      status: "committed",
      revisionId: "revision-language" as never,
      contentHash: HASH as never,
      commands: [],
    };
  }

  async cancel(
    _reason: "rejected" | "timeout" | "cancelled" = "cancelled",
    ...diagnostics: Diagnostic[]
  ): Promise<CompilerTurnOutcome> {
    this.diagnostics.push(...diagnostics);
    return { status: "rejected", commands: [], diagnostics };
  }
}
