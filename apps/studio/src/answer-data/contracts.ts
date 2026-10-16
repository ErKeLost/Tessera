import { modelMutationActionSchema } from "@open-tessera/agent";
import { z } from "zod";
import {
  ANSWER_DATABASE_ACTION_TOOL,
  ANSWER_RELATION_METRICS_TOOL,
  ANSWER_RELATION_PREVIEW_TOOL,
} from "../generative/openui-actions";

/**
 * The Answer Data Plane wire contracts.
 *
 * This is the single source of truth for what an OpenUI answer may send: the
 * prompt tool specs, the server validators, and the route handlers all derive
 * from these schemas, so a taught tool can never diverge from an enforced one.
 * Nothing here executes or renders; it only describes shapes.
 */

// ── Failure ──

/** A stable, browser-safe failure for the answer data routes. */
export class AnswerDataError extends Error {
  constructor(
    readonly code:
      | "relation_not_found"
      | "relation_not_previewable"
      | "invalid_metrics"
      | "metrics_unsupported"
      | "query_unavailable"
      | "unknown_tool",
    message: string,
  ) {
    super(message);
    this.name = "AnswerDataError";
  }
}

// ── Shared result ──

export type AnswerPreviewCell = string | number | boolean | null;

/** Every answer data tool returns the same shape, so the prompt teaches one contract. */
export type AnswerQueryResult = Readonly<{
  columns: string[];
  rows: Array<Record<string, AnswerPreviewCell>>;
  rowCount: number;
  truncated: boolean;
}>;

// ── Read: relation_preview ──

/** Catalog coordinates only; the server derives the columns and the row bound. */
export const relationPreviewArgsSchema = z
  .object({
    schema: z.string().trim().min(1).max(256),
    table: z.string().trim().min(1).max(256),
  })
  .strict();

export type RelationPreviewArgs = z.infer<typeof relationPreviewArgsSchema>;

// ── Read: relation_metrics ──

export const METRIC_FUNCTIONS = ["count", "sum", "avg", "min", "max"] as const;
export type MetricFunction = (typeof METRIC_FUNCTIONS)[number];

export const METRIC_FILTER_OPERATORS = [
  "contains",
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "is_not_null",
] as const;

export const metricArgsSchema = z
  .object({
    fn: z.enum(METRIC_FUNCTIONS),
    column: z.string().trim().min(1).max(256).optional(),
    alias: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const metricFilterSchema = z
  .object({
    column: z.string().trim().min(1).max(256),
    operator: z.enum(METRIC_FILTER_OPERATORS),
    value: z.union([z.string().max(2_000), z.number(), z.boolean()]).optional(),
  })
  .strict();

/**
 * Grouped aggregates for charts and KPIs. Bounded on purpose: at most two
 * grouping columns, four metrics, sixteen filters, and 1000 rows.
 */
export const relationMetricsArgsSchema = z
  .object({
    schema: z.string().trim().min(1).max(256),
    table: z.string().trim().min(1).max(256),
    groupBy: z.array(z.string().trim().min(1).max(256)).max(2).optional(),
    metrics: z.array(metricArgsSchema).min(1).max(4),
    filters: z.array(metricFilterSchema).max(16).optional(),
    orderBy: z
      .object({
        alias: z.string().trim().min(1).max(64),
        direction: z.enum(["asc", "desc"]),
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

export type RelationMetricsArgs = z.infer<typeof relationMetricsArgsSchema>;
export type MetricArgs = z.infer<typeof metricArgsSchema>;
export type MetricFilter = z.infer<typeof metricFilterSchema>;

// ── Read: wire request ──

export const answerQueryRequestSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(ANSWER_RELATION_PREVIEW_TOOL), args: relationPreviewArgsSchema }).strict(),
  z.object({ tool: z.literal(ANSWER_RELATION_METRICS_TOOL), args: relationMetricsArgsSchema }).strict(),
]);

export type AnswerQueryRequest = z.infer<typeof answerQueryRequestSchema>;

// ── Write ──

/**
 * The mutation is the same model-facing shape the Agent tool accepts, so the
 * answer and the server-side Agent cannot drift into two dialects. The catalog
 * envelope (connection ref, database ref, fingerprint) is server-composed.
 */
export const databaseActionArgsSchema = z
  .object({
    mutation: modelMutationActionSchema,
    purpose: z.string().trim().min(1).max(1_000),
  })
  .strict();

export type DatabaseActionArgs = z.infer<typeof databaseActionArgsSchema>;

/** The route body is exactly the tool args; named for the transport. */
export const answerActionRequestSchema = databaseActionArgsSchema;
export type AnswerActionRequest = DatabaseActionArgs;

export { ANSWER_DATABASE_ACTION_TOOL, ANSWER_RELATION_METRICS_TOOL, ANSWER_RELATION_PREVIEW_TOOL };
