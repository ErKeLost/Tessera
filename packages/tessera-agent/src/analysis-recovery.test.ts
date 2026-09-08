import { describe, expect, test } from "bun:test";
import { DataAgentError, type DataAgent, type SemanticCatalog } from "@open-tessera/data-agent";
import { createTesseraCopilotRuntime } from "./mastra-agent";
import { createTesseraDataCopilotTools } from "./tools";
import { defaultAgentErrorMessage, normalizeResultValue } from "./safety";

function fixture() {
  const runtime = createTesseraCopilotRuntime();
  runtime.planningScopes.push({
    capability: { token: `cap_${"a".repeat(32)}.${"b".repeat(32)}` },
    discovery: "inspect",
    catalog: {
      entities: [
        { id: "ent_0123456789abcdef", fields: [], metrics: [] },
        { id: "ent_abcdef0123456789", fields: [], metrics: [] },
      ],
      relationships: [],
    } as unknown as SemanticCatalog,
  });
  let prepared = 0;
  let executed = 0;
  let failPreparation = false;
  const dataAgent = {
    async prepareAnalysis() {
      prepared++;
      if (failPreparation) throw new DataAgentError("compile_failed", "SELECT total FROM orders: invalid token: field_missing");
      return { analysisRef: `analysis_${prepared.toString(16).padStart(32, "0")}`, columns: [{ outputId: "out_measure_1", label: "Count", type: "number" }] };
    },
    async executePreparedAnalysis() {
      executed++;
      return {
        columns: [{ outputId: "out_measure_1", label: "Count", type: "number" }],
        execution: { result: { queryId: "query", rowCount: 1, rows: [{ count: 1 }], columns: [{ name: "count" }], truncated: false, durationMs: 1 } },
      };
    },
    async executeReadSql() { throw new Error("SELECT token FROM orders: authorization: missing column"); },
  } as unknown as DataAgent;
  const tools = createTesseraDataCopilotTools({
    runtime, dataAgent,
    input: { runId: "recovery", threadId: "recovery", message: "Count orders", signal: new AbortController().signal },
    defaultIdentity: { tenantId: "tenant", subject: "user" },
    permissionContext: { accessMode: "read-only", databaseActionsAvailable: false, sqlStatements: { read: "allow", write: "deny", destructive: "deny", unknown: "deny" } },
  });
  const plan = { mode: "aggregate" as const, primaryEntityId: "ent_0123456789abcdef", relationshipIds: [] as string[], limit: 100, measures: [{ kind: "aggregate" as const, aggregate: "count" as const }], output: "scalar" as const };
  return { tools, plan, runtime, calls: () => ({ prepared, executed }), failPreparation: (value: boolean) => { failPreparation = value; } };
}

describe("analysis recovery without heuristic gates", () => {
  test("allows repeated preparation and execution with unrelated catalog entities", async () => {
    const f = fixture();
    for (let round = 0; round < 2; round++) {
      const first = await f.tools.prepare_analysis.execute!(f.plan, {} as never);
      const second = await f.tools.prepare_analysis.execute!(f.plan, {} as never);
      for (const prepared of [first, second]) {
        expect(prepared).toMatchObject({ status: "prepared" });
        if (!prepared || !("analysisRef" in prepared)) throw new Error("Expected preparation");
        expect(await f.tools.execute_sql.execute!({ analysisRef: prepared.analysisRef }, {} as never))
          .toMatchObject({ status: "completed", mode: "analysis" });
      }
    }
    expect(f.calls()).toEqual({ prepared: 4, executed: 4 });
  });

  test("permits correction after multiple invalid drafts and compiler failures", async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await f.tools.prepare_analysis.execute!({ ...f.plan, measures: undefined }, {} as never))
        .toMatchObject({ status: "rejected", reason: "invalid_plan", nextAction: "revise_plan" });
    }
    f.failPreparation(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await f.tools.prepare_analysis.execute!(f.plan, {} as never))
        .toMatchObject({ reason: "invalid_plan", message: "SELECT total FROM orders: invalid token: field_missing", nextAction: "revise_plan" });
    }
    f.failPreparation(false);
    expect(await f.tools.prepare_analysis.execute!(f.plan, {} as never)).toMatchObject({ status: "prepared" });
  });

  test("retains identifier validation and single-use execution references", async () => {
    const f = fixture();
    expect(await f.tools.prepare_analysis.execute!({ ...f.plan, primaryEntityId: "ent_1111111111111111" }, {} as never))
      .toMatchObject({ status: "rejected", reason: "catalog_incomplete" });
    expect(await f.tools.execute_sql.execute!({ analysisRef: `analysis_${"f".repeat(32)}` }, {} as never))
      .toMatchObject({ status: "blocked", reason: "analysis_unavailable" });
    expect(f.calls()).toEqual({ prepared: 0, executed: 0 });
  });

  test("returns SQL diagnostics verbatim without keyword replacement", async () => {
    const f = fixture();
    expect(await f.tools.execute_sql.execute!({ sql: "SELECT token FROM orders", purpose: "Inspect orders" }, {} as never))
      .toMatchObject({ message: "SELECT token FROM orders: authorization: missing column" });
    expect(defaultAgentErrorMessage(new Error("token: example"))).toBe("token: example");
  });

  test("preserves result strings and field names", () => {
    const value = { apiKey: "example", password: "example", nested: { token: "example" } };
    expect(JSON.parse(normalizeResultValue(value, 2_000) as string)).toEqual(value);
    expect(normalizeResultValue({ text: "Authorization: Bearer YOUR_TOKEN" }, 2_000))
      .toBe("Authorization: Bearer YOUR_TOKEN");
  });
});
