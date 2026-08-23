import { z } from "zod";
import {
  resourceDatasetCellValueSchema,
  resourceDatasetPayloadSchema,
} from "@open-generative/protocol";
import {
  columnIdValueSchema,
  formatTokenSchema,
  resourceBindingExprSchema,
} from "./schema";

export const chartRecipes = [
  "steps-bars",
  "pipeline-stage-bars",
  "sleep-score",
  "revenue-per-account-scatter",
  "tracked-time-sankey",
  "visitors-radial",
  "visitors-radar",
  "activity-calendar",
  "revenue-smooth-area",
  "active-users-heatmap",
  "sign-up-funnel",
  "earned-so-far-bars",
  "contributions-heatmap",
  "sessions-conversion-combo",
  "devices-bars",
  "visitors-stacked-area",
  "activity-rings",
] as const;

export const chartRecipeSchema = z.enum(chartRecipes);
export const chartCellValueSchema = resourceDatasetCellValueSchema;
export const resolvedChartDataSchema = resourceDatasetPayloadSchema;

export const chartAggregateSchema = z.enum([
  "sum",
  "average",
  "minimum",
  "maximum",
  "first",
  "last",
  "count",
  "distinct-count",
]);

export const chartMetricSchema = z.object({
  column: columnIdValueSchema,
  aggregate: chartAggregateSchema,
  label: z.string().trim().min(1).max(128).optional(),
  format: formatTokenSchema.optional(),
}).strict();

export const chartSeriesColumnSchema = z.object({
  column: columnIdValueSchema,
  label: z.string().trim().min(1).max(128).optional(),
  format: formatTokenSchema.optional(),
}).strict();

export const chartAccessibilitySchema = z.object({
  label: z.string().trim().min(1).max(512),
  description: z.string().trim().min(1).max(2_048).optional(),
}).strict();

const titleSchema = z.string().trim().min(1).max(256);

function createChartSpecSchema<TDataSchema extends z.ZodType>(dataSchema: TDataSchema) {
  const common = {
    data: dataSchema,
    title: titleSchema,
    subtitle: z.string().trim().min(1).max(512).optional(),
    equivalentView: z.literal("table"),
    accessibility: chartAccessibilitySchema,
  } as const;

  return z.discriminatedUnion("recipe", [
    z.object({
      recipe: z.literal("steps-bars"),
      ...common,
      dateColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      goalColumn: columnIdValueSchema,
      selectedDate: z.iso.date(),
      unitLabel: z.string().trim().min(1).max(48),
      locale: z.string().trim().min(2).max(35),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("pipeline-stage-bars"),
      ...common,
      stageColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("sleep-score"),
      ...common,
      subtitle: titleSchema,
      labelColumn: columnIdValueSchema,
      detailColumn: columnIdValueSchema,
      scoreColumn: columnIdValueSchema,
      targetColumn: columnIdValueSchema,
      score: chartMetricSchema,
      periodStart: z.iso.date(),
      periodEnd: z.iso.date(),
      locale: z.string().trim().min(2).max(35),
      scoreFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("revenue-per-account-scatter"),
      ...common,
      accountColumn: columnIdValueSchema,
      revenueColumn: columnIdValueSchema,
      comparisonColumn: columnIdValueSchema,
      sizeColumn: columnIdValueSchema,
      groupColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      revenueFormat: formatTokenSchema.optional(),
      comparisonFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("tracked-time-sankey"),
      ...common,
      sourceColumn: columnIdValueSchema,
      targetColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      unitLabel: z.string().trim().min(1).max(24),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("visitors-radial"),
      ...common,
      categoryColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("visitors-radar"),
      ...common,
      dimensionColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      comparisonColumn: columnIdValueSchema.optional(),
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("activity-calendar"),
      ...common,
      dateColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      series: z.array(chartSeriesColumnSchema).length(3),
      selectedDate: z.iso.date(),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("revenue-smooth-area"),
      ...common,
      timeColumn: columnIdValueSchema,
      revenueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      revenueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("active-users-heatmap"),
      ...common,
      dayColumn: columnIdValueSchema,
      timeBucketColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("sign-up-funnel"),
      ...common,
      stageColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      conversion: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("earned-so-far-bars"),
      ...common,
      periodColumn: columnIdValueSchema,
      earnedColumn: columnIdValueSchema,
      targetColumn: columnIdValueSchema.optional(),
      summary: chartMetricSchema,
      change: chartMetricSchema,
      earnedFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("contributions-heatmap"),
      ...common,
      dateColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema,
      change: chartMetricSchema,
      highlights: z.array(chartMetricSchema).length(4),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("sessions-conversion-combo"),
      ...common,
      timeColumn: columnIdValueSchema,
      sessionsColumn: columnIdValueSchema,
      conversionColumn: columnIdValueSchema,
      sessionsSummary: chartMetricSchema,
      conversionSummary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
      sessionsFormat: formatTokenSchema.optional(),
      conversionFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("devices-bars"),
      ...common,
      deviceColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      summary: chartMetricSchema.optional(),
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
    z.object({
      recipe: z.literal("visitors-stacked-area"),
      ...common,
      timeColumn: columnIdValueSchema,
      series: z.array(chartSeriesColumnSchema).min(2).max(5),
      summary: chartMetricSchema,
      change: chartMetricSchema,
      periodLabel: z.string().trim().min(1).max(128),
    }).strict(),
    z.object({
      recipe: z.literal("activity-rings"),
      ...common,
      activityColumn: columnIdValueSchema,
      valueColumn: columnIdValueSchema,
      targetColumn: columnIdValueSchema,
      detailColumn: columnIdValueSchema,
      valueFormat: formatTokenSchema.optional(),
    }).strict(),
  ]).superRefine((spec, context) => {
    const internal = spec as InternalSpec;
    const selectors = referencedColumns(internal);
    const uniqueSelectors = new Set(selectors);
    if (internal.recipe === "visitors-stacked-area") {
      const seriesColumns = internal.series.map((series) => series.column);
      if (new Set(seriesColumns).size !== seriesColumns.length) {
        context.addIssue({
          code: "custom",
          path: ["series"],
          message: "Stacked area series columns must be unique.",
        });
      }
    }
    if (uniqueSelectors.size === 0) {
      context.addIssue({ code: "custom", message: "A chart must reference at least one dataset column." });
    }
  });
}

export const chartSpecSchema = createChartSpecSchema(resourceBindingExprSchema);
export const resolvedChartSpecSchema = createChartSpecSchema(resolvedChartDataSchema).superRefine((spec, context) => {
  const columns = new Map(spec.data.columns.map((column) => [column.columnId, column.valueType]));
  const internal = spec as InternalSpec;
  for (const column of referencedColumns(internal)) {
    if (!columns.has(column)) {
      context.addIssue({
        code: "custom",
        path: ["data", "columns"],
        message: `Chart references undeclared dataset column ${column}.`,
      });
    }
  }
  for (const column of numericColumns(internal)) {
    const valueType = columns.get(column);
    if (valueType !== undefined && valueType !== "number") {
      context.addIssue({
        code: "custom",
        path: ["data", "columns"],
        message: `Chart numeric column ${column} must declare valueType number.`,
      });
    }
  }
  for (const column of temporalColumns(internal)) {
    const valueType = columns.get(column);
    if (valueType !== undefined && valueType !== "date" && valueType !== "datetime") {
      context.addIssue({
        code: "custom",
        path: ["data", "columns"],
        message: `Chart temporal column ${column} must declare valueType date or datetime.`,
      });
    }
  }
  if (spec.recipe === "steps-bars") {
    if (spec.data.rows.length !== 7) {
      context.addIssue({
        code: "custom",
        path: ["data", "rows"],
        message: "Steps bars requires exactly seven daily rows.",
      });
    }
    if (!spec.data.rows.some((row) => row[spec.dateColumn] === spec.selectedDate)) {
      context.addIssue({
        code: "custom",
        path: ["selectedDate"],
        message: "Steps bars selectedDate must identify a row in the resolved dataset.",
      });
    }
  }
  if (spec.recipe === "pipeline-stage-bars" && spec.data.rows.length !== 6) {
    context.addIssue({
      code: "custom",
      path: ["data", "rows"],
      message: "Pipeline stage bars requires exactly six ordered stages.",
    });
  }
  if (spec.recipe === "sleep-score") {
    if (spec.data.rows.length !== 3) {
      context.addIssue({
        code: "custom",
        path: ["data", "rows"],
        message: "Sleep score requires exactly three score contributors.",
      });
    }
    if (spec.periodStart > spec.periodEnd) {
      context.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "Sleep score periodEnd must not precede periodStart.",
      });
    }
  }
  if (spec.recipe === "revenue-per-account-scatter") {
    const groups = new Set(spec.data.rows.map((row) => row[spec.groupColumn]));
    if (spec.data.rows.length !== 16 || groups.size !== 3) {
      context.addIssue({
        code: "custom",
        path: ["data", "rows"],
        message: "Revenue per account requires sixteen accounts across exactly three groups.",
      });
    }
  }
  if (spec.recipe === "tracked-time-sankey") {
    const sources = new Set(spec.data.rows.map((row) => row[spec.sourceColumn]));
    const targets = new Set(spec.data.rows.map((row) => row[spec.targetColumn]));
    if (sources.size !== 5 || targets.size !== 7) {
      context.addIssue({
        code: "custom",
        path: ["data", "rows"],
        message: "Tracked time Sankey requires exactly five sources and seven destinations.",
      });
    }
  }
});

type InternalMetric = Readonly<{ column: string }>;
type InternalSeries = Readonly<{ column: string }>;
type InternalSpec = Readonly<{
  recipe: ChartRecipe;
  summary?: InternalMetric;
  change?: InternalMetric;
  score?: InternalMetric;
  conversion?: InternalMetric;
  sessionsSummary?: InternalMetric;
  conversionSummary?: InternalMetric;
  highlights?: readonly InternalMetric[];
  series: readonly InternalSeries[];
}> & Readonly<Record<string, any>>;

function metricColumns(spec: InternalSpec): string[] {
  switch (spec.recipe) {
    case "steps-bars": return [];
    case "pipeline-stage-bars": return [spec.summary!.column, spec.change!.column];
    case "sleep-score": return [spec.score!.column];
    case "revenue-per-account-scatter": return [spec.summary!.column, spec.change!.column];
    case "tracked-time-sankey": return [spec.summary!.column];
    case "visitors-radial": return [spec.summary!.column, spec.change!.column];
    case "visitors-radar": return [spec.summary!.column, spec.change!.column];
    case "activity-calendar": return spec.summary === undefined ? [] : [spec.summary.column];
    case "revenue-smooth-area": return [spec.summary!.column, spec.change!.column];
    case "active-users-heatmap": return [spec.summary!.column, spec.change!.column];
    case "sign-up-funnel": return [
      spec.summary!.column,
      spec.conversion!.column,
      spec.change!.column,
    ];
    case "earned-so-far-bars": return [spec.summary!.column, spec.change!.column];
    case "contributions-heatmap": return [spec.summary!.column, spec.change!.column, ...spec.highlights!.map((metric) => metric.column)];
    case "sessions-conversion-combo": return [spec.sessionsSummary!.column, spec.conversionSummary!.column, spec.change!.column];
    case "devices-bars": return spec.summary === undefined ? [] : [spec.summary.column];
    case "visitors-stacked-area": return [spec.summary!.column, spec.change!.column];
    case "activity-rings": return [];
  }
}

function referencedColumns(spec: InternalSpec): string[] {
  const metrics = metricColumns(spec);
  switch (spec.recipe) {
    case "steps-bars": return [spec.dateColumn, spec.valueColumn, spec.goalColumn, ...metrics];
    case "pipeline-stage-bars": return [spec.stageColumn, spec.valueColumn, ...metrics];
    case "sleep-score": return [spec.labelColumn, spec.detailColumn, spec.scoreColumn, spec.targetColumn, ...metrics];
    case "revenue-per-account-scatter": return [spec.accountColumn, spec.revenueColumn, spec.comparisonColumn, spec.sizeColumn, spec.groupColumn, ...metrics];
    case "tracked-time-sankey": return [spec.sourceColumn, spec.targetColumn, spec.valueColumn, ...metrics];
    case "visitors-radial": return [spec.categoryColumn, spec.valueColumn, ...metrics];
    case "visitors-radar": return [spec.dimensionColumn, spec.valueColumn, ...(spec.comparisonColumn === undefined ? [] : [spec.comparisonColumn]), ...metrics];
    case "activity-calendar": return [spec.dateColumn, spec.valueColumn, ...spec.series.map((series) => series.column), ...metrics];
    case "revenue-smooth-area": return [spec.timeColumn, spec.revenueColumn, ...metrics];
    case "active-users-heatmap": return [spec.dayColumn, spec.timeBucketColumn, spec.valueColumn, ...metrics];
    case "sign-up-funnel": return [spec.stageColumn, spec.valueColumn, ...metrics];
    case "earned-so-far-bars": return [spec.periodColumn, spec.earnedColumn, ...(spec.targetColumn === undefined ? [] : [spec.targetColumn]), ...metrics];
    case "contributions-heatmap": return [spec.dateColumn, spec.valueColumn, ...metrics];
    case "sessions-conversion-combo": return [spec.timeColumn, spec.sessionsColumn, spec.conversionColumn, ...metrics];
    case "devices-bars": return [spec.deviceColumn, spec.valueColumn, ...metrics];
    case "visitors-stacked-area": return [spec.timeColumn, ...spec.series.map((series) => series.column), ...metrics];
    case "activity-rings": return [spec.activityColumn, spec.valueColumn, spec.targetColumn, spec.detailColumn, ...metrics];
  }
}

function numericColumns(spec: InternalSpec): string[] {
  const metrics = metricColumns(spec);
  switch (spec.recipe) {
    case "steps-bars": return [spec.valueColumn, spec.goalColumn, ...metrics];
    case "pipeline-stage-bars": return [spec.valueColumn, ...metrics];
    case "sleep-score": return [spec.scoreColumn, spec.targetColumn, ...metrics];
    case "revenue-per-account-scatter": return [spec.revenueColumn, spec.comparisonColumn, spec.sizeColumn, ...metrics];
    case "tracked-time-sankey": return [spec.valueColumn, ...metrics];
    case "visitors-radial": return [spec.valueColumn, ...metrics];
    case "visitors-radar": return [spec.valueColumn, ...(spec.comparisonColumn === undefined ? [] : [spec.comparisonColumn]), ...metrics];
    case "activity-calendar": return [spec.valueColumn, ...spec.series.map((series) => series.column), ...metrics];
    case "revenue-smooth-area": return [spec.revenueColumn, ...metrics];
    case "active-users-heatmap": return [spec.valueColumn, ...metrics];
    case "sign-up-funnel": return [spec.valueColumn, ...metrics];
    case "earned-so-far-bars": return [spec.earnedColumn, ...(spec.targetColumn === undefined ? [] : [spec.targetColumn]), ...metrics];
    case "contributions-heatmap": return [spec.valueColumn, ...metrics];
    case "sessions-conversion-combo": return [spec.sessionsColumn, spec.conversionColumn, ...metrics];
    case "devices-bars": return [spec.valueColumn, ...metrics];
    case "visitors-stacked-area": return [...spec.series.map((series) => series.column), ...metrics];
    case "activity-rings": return [spec.valueColumn, spec.targetColumn, ...metrics];
  }
}

function temporalColumns(spec: InternalSpec): string[] {
  switch (spec.recipe) {
    case "steps-bars":
    case "activity-calendar":
    case "contributions-heatmap": return [spec.dateColumn];
    case "revenue-smooth-area":
    case "sessions-conversion-combo":
    case "visitors-stacked-area": return [spec.timeColumn];
    default: return [];
  }
}

export type ChartRecipe = z.infer<typeof chartRecipeSchema>;
export type ChartCellValue = z.infer<typeof chartCellValueSchema>;
export type ResolvedChartData = z.infer<typeof resolvedChartDataSchema>;
export type ChartAggregate = z.infer<typeof chartAggregateSchema>;
export type ChartMetric = z.infer<typeof chartMetricSchema>;
export type ChartSeriesColumn = z.infer<typeof chartSeriesColumnSchema>;
export type ChartAccessibility = z.infer<typeof chartAccessibilitySchema>;
export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ResolvedChartSpec = z.infer<typeof resolvedChartSpecSchema>;
