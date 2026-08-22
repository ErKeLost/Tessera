import { z } from "zod";
import {
  resourceDatasetCellValueSchema,
  resourceDatasetPayloadSchema,
} from "@open-generative/protocol";
import {
  chartIconTokenSchema,
  columnIdValueSchema,
  formatTokenSchema,
  resourceBindingExprSchema,
  semanticColorTokenSchema,
  stateBindingExprSchema,
} from "./schema";

export const chartFamilies = ["area", "bar", "line", "pie", "radar", "radial"] as const;
export const chartFamilySchema = z.enum(chartFamilies);

export const chartCellValueSchema = resourceDatasetCellValueSchema;
export const resolvedChartDataSchema = resourceDatasetPayloadSchema;

export const chartSeriesSchema = z.object({
  column: columnIdValueSchema,
  label: z.string().trim().min(1).max(256).optional(),
  colorToken: semanticColorTokenSchema.optional(),
  valueFormat: formatTokenSchema.optional(),
  stackId: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/).optional(),
  iconToken: chartIconTokenSchema.optional(),
}).strict();

export const chartAxisSchema = z.object({
  visible: z.boolean().default(true),
  scale: z.enum(["category", "number", "time"]),
  label: z.string().trim().min(1).max(256).optional(),
  tickFormat: formatTokenSchema.optional(),
  tickCount: z.number().int().min(2).max(20).optional(),
}).strict();

export const chartAxesSchema = z.object({
  x: chartAxisSchema.optional(),
  y: chartAxisSchema.optional(),
  grid: z.enum(["none", "horizontal", "vertical", "both"]).default("horizontal"),
}).strict();

export const chartStackSchema = z.object({
  mode: z.enum(["none", "normal", "normalized"]),
}).strict();

export const chartLabelSchema = z.object({
  mode: z.enum(["none", "value", "category", "category-value", "list", "formatted"]),
  position: z.enum(["auto", "inside", "outside", "top", "right"]).default("auto"),
  format: formatTokenSchema.optional(),
  leaderLine: z.boolean().default(true),
}).strict().superRefine((label, context) => {
  if (label.mode === "formatted" && label.format === undefined) {
    context.addIssue({ code: "custom", path: ["format"], message: "Formatted labels require a format token." });
  }
  if (label.mode !== "formatted" && label.format !== undefined) {
    context.addIssue({ code: "custom", path: ["format"], message: "Label formats are only valid in formatted mode." });
  }
});

export const chartTooltipSchema = z.object({
  enabled: z.boolean().default(true),
  indicator: z.enum(["dot", "line", "dashed", "none"]).default("dot"),
  label: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("default") }).strict(),
    z.object({ mode: z.literal("none") }).strict(),
    z.object({ mode: z.literal("column"), column: columnIdValueSchema }).strict(),
    z.object({
      mode: z.literal("formatted"),
      column: columnIdValueSchema.optional(),
      format: formatTokenSchema,
    }).strict(),
  ]).default({ mode: "default" }),
  valueFormat: formatTokenSchema.optional(),
  seriesIcons: z.boolean().default(false),
  aggregate: z.enum(["none", "total", "average"]).default("none"),
}).strict();

function createLegendSchema(stateSchema: z.ZodType) {
  return z.object({
    visibility: z.enum(["none", "auto", "always"]).default("auto"),
    position: z.enum(["top", "bottom", "left", "right"]).default("bottom"),
    align: z.enum(["start", "center", "end"]).default("center"),
    iconMode: z.enum(["swatch", "series-icon"]).default("swatch"),
    visibilityState: stateSchema.optional(),
  }).strict();
}

function createInteractionSchema(stateSchema: z.ZodType) {
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("datum-select"), state: stateSchema }).strict(),
    z.object({ kind: z.literal("series-select"), state: stateSchema }).strict(),
    z.object({ kind: z.literal("slice-select"), state: stateSchema }).strict(),
    z.object({
      kind: z.literal("range-select"),
      state: stateSchema,
      minimumPoints: z.number().int().min(1).max(1_000).default(2),
    }).strict(),
  ]);
}

export const chartPresentationSchema = z.object({
  height: z.enum(["sm", "md", "lg"]).default("md"),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  animation: z.enum(["none", "entrance", "interactive"]).default("entrance"),
}).strict();

export const chartAccessibilitySchema = z.object({
  label: z.string().trim().min(1).max(512),
  description: z.string().trim().min(1).max(2_048).optional(),
}).strict();

export const resolvedChartInteractionStateSchema = z.union([
  z.null(),
  z.string().max(1_024),
  z.number().finite(),
  z.array(z.union([z.string().max(1_024), z.number().finite()])).max(1_000),
  z.object({ start: z.number().finite(), end: z.number().finite() }).strict(),
]);

function createCenterTextSchema(stateSchema: z.ZodType) {
  return z.object({
    value: z.union([z.literal("total"), z.literal("selected"), stateSchema]),
    label: z.string().trim().min(1).max(128),
    format: formatTokenSchema.optional(),
  }).strict();
}

function createChartSchemas(dataSchema: z.ZodType, stateSchema: z.ZodType) {
  const common = {
    data: dataSchema,
    title: z.string().trim().min(1).max(512).optional(),
    description: z.string().trim().min(1).max(2_048).optional(),
    series: z.array(chartSeriesSchema).min(1).max(12),
    tooltip: chartTooltipSchema.optional(),
    legend: createLegendSchema(stateSchema).optional(),
    labels: chartLabelSchema.optional(),
    interaction: createInteractionSchema(stateSchema).optional(),
    presentation: chartPresentationSchema.optional(),
    equivalentView: z.enum(["table", "text-summary"]),
    accessibility: chartAccessibilitySchema,
  } as const;

  const area = z.object({
    family: z.literal("area"),
    ...common,
    x: columnIdValueSchema,
    axes: chartAxesSchema.optional(),
    curve: z.enum(["monotone", "linear", "natural", "step"]).default("monotone"),
    stack: chartStackSchema.optional(),
    fill: z.enum(["solid", "gradient"]).default("solid"),
    activeMark: z.boolean().default(false),
  }).strict();

  const bar = z.object({
    family: z.literal("bar"),
    ...common,
    category: columnIdValueSchema,
    orientation: z.enum(["vertical", "horizontal"]).default("vertical"),
    axes: chartAxesSchema.optional(),
    stack: chartStackSchema.optional(),
    activeMark: z.boolean().default(false),
    shape: z.enum(["default", "rounded", "active-rounded"]).default("default"),
    colorMode: z.enum(["series", "per-datum", "by-sign"]).default("series"),
    allowNegative: z.boolean().default(false),
  }).strict();

  const line = z.object({
    family: z.literal("line"),
    ...common,
    x: columnIdValueSchema,
    axes: chartAxesSchema.optional(),
    curve: z.enum(["monotone", "linear", "natural", "step"]).default("monotone"),
    points: z.enum(["hidden", "visible", "series-color", "custom-symbol"]).default("hidden"),
    activeMark: z.boolean().default(false),
  }).strict();

  const pie = z.object({
    family: z.literal("pie"),
    ...common,
    name: columnIdValueSchema,
    innerRadius: z.enum(["none", "sm", "md", "lg"]).default("none"),
    separator: z.enum(["default", "none"]).default("default"),
    rings: z.enum(["single", "stacked"]).default("single"),
    activeMark: z.boolean().default(false),
    shape: z.enum(["default", "active-sector"]).default("default"),
    centerText: createCenterTextSchema(stateSchema).optional(),
  }).strict();

  const radar = z.object({
    family: z.literal("radar"),
    ...common,
    angle: columnIdValueSchema,
    grid: z.enum([
      "polygon",
      "polygon-filled",
      "polygon-no-radial-lines",
      "circle",
      "circle-filled",
      "circle-no-radial-lines",
      "custom-radius-no-radial-lines",
      "none",
    ]).default("polygon"),
    radiusAxis: z.object({ visible: z.boolean(), domain: z.tuple([z.number().finite(), z.number().finite()]).optional() }).strict().optional(),
    points: z.enum(["hidden", "visible"]).default("hidden"),
    fill: z.enum(["area", "none"]).default("area"),
  }).strict();

  const radial = z.object({
    family: z.literal("radial"),
    ...common,
    name: columnIdValueSchema,
    domain: z.object({ min: z.number().finite(), max: z.number().finite() }).strict(),
    sweep: z.enum(["full", "extended-full", "partial", "semicircle"]).default("full"),
    grid: z.enum(["none", "circle", "ring"]).default("none"),
    shape: z.enum(["default", "round", "custom"]).default("default"),
    stack: chartStackSchema.optional(),
    centerText: createCenterTextSchema(stateSchema).optional(),
  }).strict();

  return z.discriminatedUnion("family", [area, bar, line, pie, radar, radial]).superRefine((spec, context) => {
    const columns = spec.series.map((series) => series.column);
    if (new Set(columns).size !== columns.length) {
      context.addIssue({ code: "custom", path: ["series"], message: "Series columns must be unique." });
    }

    if ("stack" in spec && spec.stack?.mode !== undefined && spec.stack.mode !== "none" && spec.series.length < 2) {
      context.addIssue({ code: "custom", path: ["series"], message: "Stacked charts require at least two series." });
    }

    if (spec.family === "pie" && spec.rings === "stacked" && spec.series.length < 2) {
      context.addIssue({ code: "custom", path: ["series"], message: "Stacked pie rings require at least two series." });
    }

    if (spec.family === "radial" && spec.domain.max <= spec.domain.min) {
      context.addIssue({ code: "custom", path: ["domain", "max"], message: "Radial domain max must exceed min." });
    }

    if (spec.family === "radar" && spec.radiusAxis?.domain !== undefined && spec.radiusAxis.domain[1] <= spec.radiusAxis.domain[0]) {
      context.addIssue({ code: "custom", path: ["radiusAxis", "domain"], message: "Radar radius domain must increase." });
    }
  });
}

export const chartCenterTextResolvedValueSchema = z.union([
  z.literal("total"),
  z.literal("selected"),
  resolvedChartInteractionStateSchema,
]);

export const chartSpecSchema = createChartSchemas(resourceBindingExprSchema, stateBindingExprSchema);
export const resolvedChartSpecSchema = createChartSchemas(resolvedChartDataSchema, resolvedChartInteractionStateSchema);

export type ChartFamily = z.infer<typeof chartFamilySchema>;
export type ChartCellValue = z.infer<typeof chartCellValueSchema>;
export type ResolvedChartData = z.infer<typeof resolvedChartDataSchema>;
export type ChartSeries = z.infer<typeof chartSeriesSchema>;
export type ChartAxis = z.infer<typeof chartAxisSchema>;
export type ChartAxes = z.infer<typeof chartAxesSchema>;
export type ChartStack = z.infer<typeof chartStackSchema>;
export type ChartLabel = z.infer<typeof chartLabelSchema>;
export type ChartTooltip = z.infer<typeof chartTooltipSchema>;
export type ChartPresentation = z.infer<typeof chartPresentationSchema>;
export type ChartAccessibility = z.infer<typeof chartAccessibilitySchema>;
export type ChartSpec = z.infer<typeof chartSpecSchema>;
export type ResolvedChartSpec = z.infer<typeof resolvedChartSpecSchema>;
