import { z } from "zod";
import { chartSpecSchema, resolvedChartSpecSchema, chartCellValueSchema } from "./chart-spec";
import {
  columnIdValueSchema,
  formatTokenSchema,
  resourceBindingExprSchema,
  scalarValueExprSchema,
  semanticColorTokenSchema,
  stateBindingExprSchema,
} from "./schema";

export const layoutStackPropsSchema = z.object({
  gap: z.enum(["none", "xs", "sm", "md", "lg"]).default("md"),
  align: z.enum(["stretch", "start", "center", "end"]).default("stretch"),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
}).strict();

export const layoutGridPropsSchema = z.object({
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal("auto")]).default("auto"),
  gap: z.enum(["none", "xs", "sm", "md", "lg"]).default("md"),
  align: z.enum(["stretch", "start", "center", "end"]).default("stretch"),
}).strict();

export const layoutSectionPropsSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  description: z.string().trim().min(1).max(2_048).optional(),
  level: z.number().int().min(1).max(6),
  divider: z.boolean().default(false),
}).strict();

export const contentTextPropsSchema = z.object({
  text: z.string().trim().min(1).max(16_384),
  role: z.enum(["heading", "body", "caption", "code"]).default("body"),
  tone: z.enum(["default", "muted", "positive", "negative", "warning"]).default("default"),
  level: z.number().int().min(1).max(6).optional(),
}).strict().superRefine((props, context) => {
  if ((props.role === "heading") !== (props.level !== undefined)) {
    context.addIssue({ code: "custom", path: ["level"], message: "Heading text requires a level and other roles forbid it." });
  }
});

export const contentCalloutPropsSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  body: z.string().trim().min(1).max(8_192),
  tone: z.enum(["info", "positive", "warning", "critical"]).default("info"),
  dismissible: z.boolean().default(false),
}).strict();

export const contentEmptyPropsSchema = z.object({
  reason: z.enum(["no-data", "filtered", "unavailable", "not-configured"]),
  title: z.string().trim().min(1).max(512),
  description: z.string().trim().min(1).max(2_048).optional(),
  retryable: z.boolean().default(false),
}).strict();

const metricComparisonAuthoringSchema = z.object({
  value: scalarValueExprSchema,
  label: z.string().trim().min(1).max(128).optional(),
  direction: z.enum(["higher-is-better", "lower-is-better", "neutral"]).default("neutral"),
  format: formatTokenSchema.optional(),
}).strict();

const metricComparisonResolvedSchema = metricComparisonAuthoringSchema.extend({
  value: z.union([z.null(), z.string().max(16_384), z.number().finite()]),
});

export const dataMetricAuthoringPropsSchema = z.object({
  label: z.string().trim().min(1).max(256),
  value: scalarValueExprSchema,
  format: formatTokenSchema.optional(),
  comparison: metricComparisonAuthoringSchema.optional(),
  tone: semanticColorTokenSchema.optional(),
}).strict();

export const dataMetricPropsSchema = dataMetricAuthoringPropsSchema.extend({
  value: z.union([z.null(), z.string().max(16_384), z.number().finite()]),
  comparison: metricComparisonResolvedSchema.optional(),
});

export const dataTableColumnSchema = z.object({
  column: columnIdValueSchema,
  label: z.string().trim().min(1).max(256),
  format: formatTokenSchema.optional(),
  align: z.enum(["start", "center", "end"]).default("start"),
  width: z.enum(["xs", "sm", "md", "lg", "fill"]).default("md"),
  sortable: z.boolean().default(false),
}).strict();

export const resolvedTableDataSchema = z.object({
  rows: z.array(z.record(columnIdValueSchema, chartCellValueSchema)).max(10_000),
  totalRows: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().default(false),
}).strict();

const tableSelectionAuthoringSchema = z.object({
  mode: z.enum(["none", "single", "multiple"]),
  rowIdColumn: columnIdValueSchema.optional(),
  state: stateBindingExprSchema.optional(),
}).strict().superRefine((selection, context) => {
  const enabled = selection.mode !== "none";
  if (enabled !== (selection.rowIdColumn !== undefined) || enabled !== (selection.state !== undefined)) {
    context.addIssue({ code: "custom", message: "Enabled table selection requires both a row ID column and state binding." });
  }
});

const tableSelectionResolvedSchema = z.object({
  mode: z.enum(["none", "single", "multiple"]),
  rowIdColumn: columnIdValueSchema.optional(),
  selectedRowIds: z.array(z.union([z.string().max(1_024), z.number().finite()])).max(10_000).optional(),
}).strict();

const tableSortAuthoringSchema = z.object({
  state: stateBindingExprSchema,
  maxKeys: z.number().int().min(1).max(16).default(1),
}).strict();

const tableSortResolvedSchema = z.object({
  keys: z.array(z.object({
    column: columnIdValueSchema,
    direction: z.enum(["ascending", "descending"]),
  }).strict()).max(16),
}).strict();

export const dataTableAuthoringPropsSchema = z.object({
  data: resourceBindingExprSchema,
  columns: z.array(dataTableColumnSchema).min(1).max(256),
  selection: tableSelectionAuthoringSchema.optional(),
  sort: tableSortAuthoringSchema.optional(),
  pagination: z.object({ pageSize: z.number().int().min(1).max(1_000) }).strict().optional(),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
}).strict().superRefine((props, context) => {
  const ids = props.columns.map((column) => column.column);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["columns"], message: "Table columns must be unique." });
  }
});

export const dataTablePropsSchema = z.object({
  data: resolvedTableDataSchema,
  columns: z.array(dataTableColumnSchema).min(1).max(256),
  selection: tableSelectionResolvedSchema.optional(),
  sort: tableSortResolvedSchema.optional(),
  pagination: z.object({
    pageSize: z.number().int().min(1).max(1_000),
    page: z.number().int().nonnegative(),
  }).strict().optional(),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
}).strict();

export const dataChartAuthoringPropsSchema = z.object({ spec: chartSpecSchema }).strict();
export const dataChartPropsSchema = z.object({ spec: resolvedChartSpecSchema }).strict();

export const resolvedQueryDetailsSchema = z.object({
  queryId: z.string().min(1).max(256),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  sql: z.string().max(256_000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  freshness: z.object({
    observedAt: z.iso.datetime({ offset: true }),
    status: z.enum(["fresh", "stale", "unknown"]),
  }).strict().optional(),
  lineage: z.array(z.object({
    kind: z.enum(["source", "transformation", "output"]),
    label: z.string().trim().min(1).max(512),
  }).strict()).max(1_000),
  evidence: z.array(z.object({
    label: z.string().trim().min(1).max(512),
    summary: z.string().trim().min(1).max(2_048),
  }).strict()).max(1_000),
}).strict();

const queryDetailsViewShape = {
  sections: z.array(z.enum(["summary", "sql", "lineage", "freshness", "evidence"])).min(1).max(5),
  defaultSection: z.enum(["summary", "sql", "lineage", "freshness", "evidence"]).default("summary"),
} as const;

function validateQueryDetailsView(
  props: { sections: string[]; defaultSection: string },
  context: z.RefinementCtx,
) {
  if (new Set(props.sections).size !== props.sections.length) {
    context.addIssue({ code: "custom", path: ["sections"], message: "Query detail sections must be unique." });
  }
  if (!props.sections.includes(props.defaultSection)) {
    context.addIssue({ code: "custom", path: ["defaultSection"], message: "The default section must be enabled." });
  }
}

export const dataQueryDetailsAuthoringPropsSchema = z.object({
  details: resourceBindingExprSchema,
  ...queryDetailsViewShape,
}).strict().superRefine(validateQueryDetailsView);

export const dataQueryDetailsPropsSchema = z.object({
  details: resolvedQueryDetailsSchema,
  ...queryDetailsViewShape,
}).strict().superRefine(validateQueryDetailsView);

export const controlFilterOptionSchema = z.object({
  value: z.union([z.string().max(1_024), z.number().finite(), z.boolean()]),
  label: z.string().trim().min(1).max(256),
  disabled: z.boolean().default(false),
}).strict();

const filterOptionsAuthoringSchema = z.union([
  z.array(controlFilterOptionSchema).max(256),
  resourceBindingExprSchema,
]);

export const controlFilterAuthoringPropsSchema = z.object({
  filterId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  label: z.string().trim().min(1).max(256),
  kind: z.enum(["text", "number", "select", "multi-select", "date", "date-range"]),
  operator: z.enum(["equals", "not-equals", "contains", "in", "greater-than", "less-than", "between"]),
  value: stateBindingExprSchema,
  options: filterOptionsAuthoringSchema.optional(),
  required: z.boolean().default(false),
}).strict().superRefine((props, context) => {
  const requiresOptions = props.kind === "select" || props.kind === "multi-select";
  if (requiresOptions !== (props.options !== undefined)) {
    context.addIssue({ code: "custom", path: ["options"], message: "Select filters require options; other filters forbid them." });
  }
  if (props.kind === "date-range" && props.operator !== "between") {
    context.addIssue({ code: "custom", path: ["operator"], message: "Date ranges use the between operator." });
  }
});

export const controlFilterPropsSchema = z.object({
  filterId: z.string().regex(/^[a-z][a-z0-9.-]{0,127}$/),
  label: z.string().trim().min(1).max(256),
  kind: z.enum(["text", "number", "select", "multi-select", "date", "date-range"]),
  operator: z.enum(["equals", "not-equals", "contains", "in", "greater-than", "less-than", "between"]),
  value: z.union([
    z.null(),
    z.string().max(4_096),
    z.number().finite(),
    z.boolean(),
    z.array(z.union([z.string().max(1_024), z.number().finite(), z.boolean()])).max(256),
    z.object({ start: z.string().max(128), end: z.string().max(128) }).strict(),
  ]),
  options: z.array(controlFilterOptionSchema).max(256).optional(),
  required: z.boolean().default(false),
}).strict();

export const controlGroupPropsSchema = z.object({
  label: z.string().trim().min(1).max(256).optional(),
  orientation: z.enum(["horizontal", "vertical"]).default("horizontal"),
  submitMode: z.enum(["immediate", "explicit"]).default("immediate"),
}).strict();

export type LayoutStackProps = z.infer<typeof layoutStackPropsSchema>;
export type LayoutGridProps = z.infer<typeof layoutGridPropsSchema>;
export type LayoutSectionProps = z.infer<typeof layoutSectionPropsSchema>;
export type ContentTextProps = z.infer<typeof contentTextPropsSchema>;
export type ContentCalloutProps = z.infer<typeof contentCalloutPropsSchema>;
export type ContentEmptyProps = z.infer<typeof contentEmptyPropsSchema>;
export type DataMetricAuthoringProps = z.infer<typeof dataMetricAuthoringPropsSchema>;
export type DataMetricProps = z.infer<typeof dataMetricPropsSchema>;
export type DataTableAuthoringProps = z.infer<typeof dataTableAuthoringPropsSchema>;
export type DataTableProps = z.infer<typeof dataTablePropsSchema>;
export type DataChartAuthoringProps = z.infer<typeof dataChartAuthoringPropsSchema>;
export type DataChartProps = z.infer<typeof dataChartPropsSchema>;
export type DataQueryDetailsAuthoringProps = z.infer<typeof dataQueryDetailsAuthoringPropsSchema>;
export type DataQueryDetailsProps = z.infer<typeof dataQueryDetailsPropsSchema>;
export type ControlFilterAuthoringProps = z.infer<typeof controlFilterAuthoringPropsSchema>;
export type ControlFilterProps = z.infer<typeof controlFilterPropsSchema>;
export type ControlGroupProps = z.infer<typeof controlGroupPropsSchema>;
