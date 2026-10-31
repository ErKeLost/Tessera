import { describe, expect, test } from "bun:test";
import type { DataAgent } from "@open-tessera/data-agent";
import type { DatabaseConnector } from "@open-tessera/database";
import { AnswerDataError } from "./contracts";
import {
  answerPreviewCell,
  compileRelationMetricsSql,
  executeRelationMetrics,
  executeRelationPreview,
} from "./read";

const COLUMNS = [
  { name: "status", dataType: "text" },
  { name: "amount", dataType: "numeric" },
];

describe("answerPreviewCell", () => {
  test("bounds every value to a JSON-safe cell", () => {
    expect(answerPreviewCell(null)).toBeNull();
    expect(answerPreviewCell(undefined)).toBeNull();
    expect(answerPreviewCell(Number.NaN)).toBeNull();
    expect(answerPreviewCell(12n)).toBe("12");
    expect(answerPreviewCell(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(answerPreviewCell({ a: 1 })).toBe('{"a":1}');
    const long = answerPreviewCell("x".repeat(5_000));
    expect(typeof long).toBe("string");
    expect((long as string).length).toBeLessThanOrEqual(4_097);
  });
});

function previewDataAgent(overrides: {
  tables?: Array<{ name: string; columns: Array<{ name: string; dataType?: string; ordinal?: number }> }>;
  rows?: Array<Record<string, unknown>>;
  truncated?: boolean;
} = {}): DataAgent {
  const tables = overrides.tables ?? [
    { name: "orders", columns: [{ name: "status", ordinal: 2 }, { name: "id", ordinal: 1 }] },
  ];
  return {
    inspectCatalog: async () => ({ catalog: { schemas: [{ name: "public", tables }] } }),
    previewRelation: async (input: { columns: string[] }) => ({
      columns: input.columns,
      result: { rows: overrides.rows ?? [{ id: "1", status: "open" }], truncated: overrides.truncated ?? false },
    }),
  } as unknown as DataAgent;
}

describe("executeRelationPreview", () => {
  test("derives the ordered columns from the catalog, not the caller", async () => {
    const result = await executeRelationPreview({
      dataAgent: previewDataAgent(),
      request: { schema: "public", table: "orders" },
    });

    // ordinal order, so id precedes status even though the catalog listed status first
    expect(result.columns).toEqual(["id", "status"]);
    expect(result.rows).toEqual([{ id: "1", status: "open" }]);
    expect(result.rowCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  test("reports a missing relation instead of guessing", async () => {
    await expect(executeRelationPreview({
      dataAgent: previewDataAgent({ tables: [] }),
      request: { schema: "public", table: "orders" },
    })).rejects.toBeInstanceOf(AnswerDataError);
  });

  test("reports a relation without previewable columns", async () => {
    await expect(executeRelationPreview({
      dataAgent: previewDataAgent({ tables: [{ name: "orders", columns: [] }] }),
      request: { schema: "public", table: "orders" },
    })).rejects.toMatchObject({ code: "relation_not_previewable" });
  });

  test("reads a numeric column as a number and leaves text alone", async () => {
    const result = await executeRelationPreview({
      dataAgent: previewDataAgent({
        tables: [{
          name: "orders",
          columns: [
            { name: "id", dataType: "bigint", ordinal: 1 },
            { name: "code", dataType: "text", ordinal: 2 },
          ],
        }],
        rows: [{ id: "77", code: "0042" }],
      }),
      request: { schema: "public", table: "orders" },
    });

    expect(result.rows).toEqual([{ id: 77, code: "0042" }]);
  });
});

describe("compileRelationMetricsSql", () => {
  const base = {
    dialect: "postgres" as const,
    relation: { schema: "public", table: "orders" },
    columns: COLUMNS,
  };

  test("builds a parameterized grouped aggregate", () => {
    const compiled = compileRelationMetricsSql({
      ...base,
      request: {
        schema: "public",
        table: "orders",
        groupBy: ["status"],
        metrics: [{ fn: "count", alias: "count" }, { fn: "sum", column: "amount" }],
        filters: [{ column: "status", operator: "equals", value: "paid" }],
        orderBy: { alias: "count", direction: "desc" },
        limit: 250,
      },
    });

    expect(compiled.parameters).toEqual(["paid"]);
    expect(compiled.limit).toBe(250);
    expect(compiled.sql).toContain('SELECT "status", COUNT(*) AS "count", SUM("amount") AS "sum_amount"');
    expect(compiled.sql).toContain('FROM "public"."orders"');
    expect(compiled.sql).toContain('WHERE "status" = $1');
    expect(compiled.sql).toContain('GROUP BY "status"');
    expect(compiled.sql).toContain('ORDER BY "count" DESC');
    expect(compiled.sql).toContain("LIMIT 250");
  });

  test("uses positional placeholders for mysql", () => {
    const compiled = compileRelationMetricsSql({
      ...base,
      dialect: "mysql",
      request: {
        schema: "public",
        table: "orders",
        metrics: [{ fn: "count" }],
        filters: [{ column: "amount", operator: "gte", value: "10" }],
      },
    });

    expect(compiled.sql).toContain("`public`.`orders`");
    expect(compiled.sql).toContain("`amount` >= ?");
    expect(compiled.parameters).toEqual([10]);
    expect(compiled.sql).toContain("LIMIT 1000");
    expect(compiled.sql).not.toContain("GROUP BY");
  });

  test("reads every numeric aggregate as a number", () => {
    const compiled = compileRelationMetricsSql({
      ...base,
      request: {
        schema: "public",
        table: "orders",
        groupBy: ["status"],
        metrics: [
          { fn: "count", alias: "registrations" },
          { fn: "sum", column: "amount" },
          { fn: "avg", column: "amount" },
          { fn: "max", column: "status" },
        ],
      },
    });

    expect(compiled.numericAliases).toEqual(["registrations", "sum_amount", "avg_amount"]);
  });

  test("keeps a numeric grouping column numeric", () => {
    const compiled = compileRelationMetricsSql({
      ...base,
      columns: [
        { name: "bucket", dataType: "integer" },
        { name: "status", dataType: "text" },
      ],
      request: {
        schema: "public",
        table: "orders",
        groupBy: ["bucket", "status"],
        metrics: [{ fn: "count" }],
      },
    });

    expect(compiled.numericAliases).toEqual(["bucket", "count"]);
  });

  test("refuses a column that is not in the catalog", () => {
    expect(() => compileRelationMetricsSql({
      ...base,
      request: { schema: "public", table: "orders", groupBy: ["nope"], metrics: [{ fn: "count" }] },
    })).toThrow(AnswerDataError);
  });

  test("refuses an order alias that is not an output column", () => {
    let error: unknown;
    try {
      compileRelationMetricsSql({
        ...base,
        request: {
          schema: "public",
          table: "orders",
          metrics: [{ fn: "count", alias: "count" }],
          orderBy: { alias: "other", direction: "asc" },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnswerDataError);
    expect((error as AnswerDataError).code).toBe("invalid_metrics");
  });

  test("refuses metrics on a connector that cannot group", () => {
    let error: unknown;
    try {
      compileRelationMetricsSql({
        ...base,
        dialect: "mongodb",
        request: { schema: "public", table: "orders", metrics: [{ fn: "count" }] },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnswerDataError);
    expect((error as AnswerDataError).code).toBe("metrics_unsupported");
  });
});

describe("executeRelationMetrics", () => {
  test("runs the compiled statement and projects a safe result", async () => {    const queries: Array<{ sql: string; parameters: unknown[]; maxRows: number }> = [];
    const dataAgent = {
      inspectCatalog: async () => ({
        catalog: { dialect: "postgres", schemas: [{ name: "public", tables: [{ name: "orders", columns: COLUMNS }] }] },
      }),
    } as unknown as DataAgent;
    const connector = {
      query: async (request: { sql: string; parameters: unknown[]; maxRows: number }) => {
        queries.push(request);
        return {
          columns: [{ name: "status" }, { name: "count" }],
          rows: [{ status: "open", count: 3 }],
          truncated: false,
        };
      },
    } as unknown as Pick<DatabaseConnector, "query">;

    const result = await executeRelationMetrics({
      dataAgent,
      connector,
      request: {
        schema: "public",
        table: "orders",
        groupBy: ["status"],
        metrics: [{ fn: "count", alias: "count" }],
      },
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('GROUP BY "status"');
    expect(result.columns).toEqual(["status", "count"]);
    expect(result.rows).toEqual([{ status: "open", count: 3 }]);
  });

  test("reads a driver's string aggregate as a number", async () => {
    const dataAgent = {
      inspectCatalog: async () => ({
        catalog: { dialect: "postgres", schemas: [{ name: "public", tables: [{ name: "orders", columns: COLUMNS }] }] },
      }),
    } as unknown as DataAgent;
    const connector = {
      query: async () => ({
        columns: [{ name: "status" }, { name: "count" }, { name: "newest" }],
        // Postgres returns COUNT(*) as text and MIN(created_at) as a timestamp.
        rows: [{ status: "open", count: "77", newest: "2026-09-30T16:00:00.000Z" }],
        truncated: false,
      }),
    } as unknown as Pick<DatabaseConnector, "query">;

    const result = await executeRelationMetrics({
      dataAgent,
      connector,
      request: {
        schema: "public",
        table: "orders",
        groupBy: ["status"],
        metrics: [
          { fn: "count", alias: "count" },
          { fn: "max", column: "status", alias: "newest" },
        ],
      },
    });

    expect(result.rows).toEqual([{ status: "open", count: 77, newest: "2026-09-30T16:00:00.000Z" }]);
  });
});
