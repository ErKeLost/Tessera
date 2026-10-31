import type { ToolSpec } from "@openuidev/lang-core";
import { z } from "zod";
import {
  ANSWER_DATABASE_ACTION_TOOL,
  ANSWER_RELATION_METRICS_TOOL,
  ANSWER_RELATION_PREVIEW_TOOL,
  databaseActionArgsSchema,
  relationMetricsArgsSchema,
  relationPreviewArgsSchema,
} from "../answer-data/contracts";

/**
 * Prompt projection for the answer data plane.
 *
 * Every tool spec is derived from the schema the server actually validates with
 * (`answer-data/contracts`), so a taught tool can never diverge from an enforced
 * one. This module is server/build-only: it imports the mutation model contract
 * and must never enter the browser bundle.
 */

const RESULT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" } },
    rows: { type: "array", items: { type: "object" } },
    rowCount: { type: "number" },
    truncated: { type: "boolean" },
  },
  required: ["columns", "rows"],
} as const;

function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

// ── Tool specs ──

export function answerRelationPreviewToolSpec(): ToolSpec {
  return {
    name: ANSWER_RELATION_PREVIEW_TOOL,
    description: [
      "Read a bounded, read-only preview of one catalog relation (up to 100 rows).",
      "Returns { columns: string[], rows: object[], rowCount, truncated }.",
      "Use it so the answer renders live data instead of hardcoded rows; pass the exact schema and table names from list_database.",
    ].join(" "),
    inputSchema: inputSchemaOf(relationPreviewArgsSchema),
    outputSchema: RESULT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
  };
}

export function answerRelationMetricsToolSpec(): ToolSpec {
  return {
    name: ANSWER_RELATION_METRICS_TOOL,
    description: [
      "Run a bounded grouped aggregate over one catalog relation: at most two grouping columns and four metrics (count, sum, avg, min, max).",
      "Returns { columns: string[], rows: object[], rowCount, truncated }.",
      "Use it for charts and KPIs so the database aggregates instead of the answer; order by a result alias.",
    ].join(" "),
    inputSchema: inputSchemaOf(relationMetricsArgsSchema),
    outputSchema: RESULT_OUTPUT_SCHEMA,
    annotations: { readOnlyHint: true },
  };
}

/**
 * `destructiveHint` is not a policy decision — the server still classifies and
 * gates every call — it only tells the model that this tool can change data.
 */
export function answerDatabaseActionToolSpec(): ToolSpec {
  return {
    name: ANSWER_DATABASE_ACTION_TOOL,
    description: [
      "Run one typed, catalog-bound database mutation (insert, update, delete or DDL).",
      "Use it only for a change the reader should trigger themselves: place it in a Mutation() and fire it from a button with @Run(...), then @Run the query it should refresh.",
      "It takes structured data, never SQL, and the server may return an approval checkpoint before anything is executed.",
    ].join(" "),
    inputSchema: inputSchemaOf(databaseActionArgsSchema),
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        requestId: { type: "string" },
        operation: { type: "string" },
        target: { type: "string" },
        message: { type: "string" },
      },
    },
    annotations: { destructiveHint: true },
  };
}

// ── Prompt rules ──

/** Rules that apply to reads in every Studio, read-only or read-write. */
export function answerReadPromptRules(): string[] {
  return [
    "relation_preview is bounded to 100 rows and read-only; a truncated result is a sample, so never infer the missing rows.",
    'Map query rows into a Table with @Each(data.rows, "row", [row.colA, row.colB]); list the Col(...) entries in the same order.',
    "Use relation_metrics (groupBy + metrics) for aggregates instead of summing rows in the answer; order by a result alias and keep the result under 1000 rows.",
    "Derive KPIs and chart values from the query result with @Count/@Sum/@Avg/@Filter/@Sort on rows the database already shaped.",
  ];
}

/** The restriction that keeps a read-only Studio from ever teaching a write. */
export function answerReadOnlyPromptRules(): string[] {
  return [
    "This Studio is read-only: never emit Mutation(), @Run on a mutation, or any write tool. Only read data.",
  ];
}

/** Rules that scope the write tool when the Studio can make changes. */
export function answerDatabaseActionPromptRules(): string[] {
  return [
    "Put database_action in a Mutation() and fire it from a Button with Action([@Run(ref)]); never execute a change while generating the answer.",
    "Reuse the exact relation and column names from the catalog; keep maxAffectedRows bounded and always include a where predicate for update and delete.",
    "After a mutation, @Run the query it should refresh in the same Action([...]) so the answer updates.",
  ];
}

// ── Prompt examples ──

export function answerReadToolExamples(): string[] {
  return [
    `Example — Live catalog table:
root = Card([header, tbl, total])
header = CardHeader("Orders", "Read live from the catalog")
data = Query("relation_preview", { schema: "public", table: "orders" }, { columns: [], rows: [] })
tbl = Table([Col("id", "string"), Col("status", "string")], @Each(data.rows, "row", [row.id, row.status]))
total = TextContent("Rows: " + @Count(data.rows))`,

    `Example — Grouped metrics for an analysis table:
root = Card([header, table])
header = CardHeader("Orders by status", "Aggregated in the database")
agg = Query("relation_metrics", { schema: "public", table: "orders", groupBy: ["status"], metrics: [{ fn: "count", alias: "count" }] }, { columns: [], rows: [] })
table = Table([Col("Status", "string"), Col("Orders", "number")], @Each(agg.rows, "row", [row.status, row.count]))`,
  ];
}

export function answerDatabaseActionToolExamples(): string[] {
  return [
    `Example — Delete with an approval checkpoint:
root = Card([header, rows, actions])
header = CardHeader("Delete the test orders", "This change needs your approval before it runs")
data = Query("relation_preview", { schema: "public", table: "orders" }, { columns: [], rows: [] })
rows = Table([Col("status", "string")], @Each(data.rows, "row", [row.status]))
actions = Buttons([del])
del = Button("Delete test orders", Action([@Run(deleteRows), @Run(data)]))
deleteRows = Mutation("database_action", { mutation: { kind: "data.delete", relation: { schema: "public", table: "orders" }, where: { kind: "comparison", column: "status", op: "eq", value: "test" }, maxAffectedRows: 100 }, purpose: "Delete the test orders the reader confirmed" })`,
  ];
}
