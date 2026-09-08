import { describe, expect, mock, test } from "bun:test";
import type { DataAgent } from "@open-tessera/data-agent";
import { createTesseraCopilotRuntime } from "./mastra-agent";
import { createTesseraDataCopilotTools } from "./tools";

describe("Agent database execution gates", () => {
  test.each([undefined, "deny", "ask"] as const)("blocks reads before data access for %s", async (read) => {
    const executeReadSql = mock(() => { throw new Error("Unexpected read"); });
    const executePreparedAnalysis = mock(() => { throw new Error("Unexpected analysis"); });
    const runtime = createTesseraCopilotRuntime();
    const tools = createTesseraDataCopilotTools({
      input: { runId: "read-policy", threadId: "read-policy", message: "Count orders", signal: new AbortController().signal },
      defaultIdentity: { subject: "alice", tenantId: "tenant-a" },
      dataAgent: { executeReadSql, executePreparedAnalysis } as unknown as DataAgent,
      runtime,
      ...(read === undefined ? {} : {
        permissionContext: {
          accessMode: "read-only" as const,
          databaseActionsAvailable: false,
          sqlStatements: { read, write: "deny" as const, destructive: "deny" as const, unknown: "deny" as const },
        },
      }),
    });
    for (const input of [{ sql: "SELECT 1", purpose: "Check data" }, { analysisRef: `analysis_${"a".repeat(32)}` }]) {
      const result = await tools.execute_sql.execute!(input, {} as never);
      expect(result).toMatchObject({
        status: "blocked",
        reason: read === "ask" ? "read_approval_unsupported" : "read_not_authorized",
      });
    }
    expect(executeReadSql).not.toHaveBeenCalled();
    expect(executePreparedAnalysis).not.toHaveBeenCalled();
  });

  test("read-only mode blocks mutations even when the policy says allow", async () => {
    const submit = mock(() => { throw new Error("Unexpected mutation"); });
    const tools = createTesseraDataCopilotTools({
      input: { runId: "readonly", threadId: "readonly", message: "Insert order", signal: new AbortController().signal },
      defaultIdentity: { subject: "alice", tenantId: "tenant-a" },
      dataAgent: {} as DataAgent,
      runtime: createTesseraCopilotRuntime(),
      permissionContext: {
        accessMode: "read-only",
        databaseActionsAvailable: true,
        sqlStatements: { read: "allow", write: "allow", destructive: "allow", unknown: "allow" },
      },
      databaseActions: { submit, approve: submit, reject: submit },
    });
    expect(await tools.execute_sql.execute!({
      mutation: { kind: "data.insert", relation: { schema: "public", table: "orders" }, values: [{ id: 1 }], maxAffectedRows: 1 },
      purpose: "Insert order",
    }, {} as never)).toMatchObject({ status: "blocked", reason: "mutation_not_authorized" });
    expect(submit).not.toHaveBeenCalled();
  });
});
