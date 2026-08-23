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

/**
 * The public Data Chart grammar.  It describes data semantics and visual
 * encodings only; layout, colours, and component implementation are owned by
 * the renderer theme rather than generated into a surface document.
 */
export const dataChartMarks = ["bar", "line", "area", "scatter", "pie", "radar"] as const;
export const dataChartMarkSchema = z.enum(dataChartMarks);

export const dataChartFieldTypes = ["quantitative", "temporal", "nominal", "ordinal"] as const;
export const dataChartFieldTypeSchema = z.enum(dataChartFieldTypes);

export const dataChartAggregateSchema = z.enum([
  "sum",
  "average",
  "minimum",
  "maximum",
  "first",
  "last",
  "count",
  "distinct-count",
]);

export const dataChartTimeUnitSchema = z.enum([
  "auto",
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "hour",
]);

export const dataChartFieldSchema = z.object({
  field: columnIdValueSchema,
  type: dataChartFieldTypeSchema,
  title: z.string().trim().min(1).max(128).optional(),
  format: formatTokenSchema.optional(),
  timeUnit: dataChartTimeUnitSchema.optional(),
}).strict().superRefine((field, context) => {
  if (field.timeUnit !== undefined && field.type !== "temporal") {
    context.addIssue({
      code: "custom",
      path: ["timeUnit"],
      message: "timeUnit is only valid for temporal fields.",
    });
  }
});

export const dataChartMetricSchema = z.object({
  field: columnIdValueSchema,
  aggregate: dataChartAggregateSchema,
  label: z.string().trim().min(1).max(128).optional(),
  format: formatTokenSchema.optional(),
}).strict();

const axisSchema = z.object({
  label: z.string().trim().min(1).max(128).optional(),
  format: formatTokenSchema.optional(),
  tickCount: z.number().int().min(2).max(12).optional(),
}).strict();

const tooltipSchema = z.object({
  mode: z.enum(["auto", "none"]).default("auto"),
  fields: z.array(dataChartFieldSchema).min(1).max(12).optional(),
}).strict().superRefine((tooltip, context) => {
  if (tooltip.mode === "none" && tooltip.fields !== undefined) {
    context.addIssue({ code: "custom", path: ["fields"], message: "A disabled tooltip cannot declare fields." });
  }
});

const cartesianOptionsSchema = z.object({
  orientation: z.enum(["vertical", "horizontal"]).default("vertical"),
  stack: z.enum(["none", "normal", "percent"]).default("none"),
  curve: z.enum(["linear", "monotone", "step"]).default("monotone"),
  grid: z.boolean().default(true),
  legend: z.enum(["auto", "none"]).default("auto"),
}).strict();

const chartCommon = {
  data: z.unknown(),
  title: z.string().trim().min(1).max(256),
  subtitle: z.string().trim().min(1).max(512).optional(),
  summary: z.array(dataChartMetricSchema).max(3).optional(),
  tooltip: tooltipSchema.default({ mode: "auto" }),
  accessibility: z.object({
    label: z.string().trim().min(1).max(512),
    description: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
  equivalentView: z.literal("table"),
} as const;

function createDataChartSpecSchema<TDataSchema extends z.ZodType>(dataSchema: TDataSchema) {
  const common = { ...chartCommon, data: dataSchema } as const;
  const cartesian = {
    ...common,
    x: dataChartFieldSchema,
    y: dataChartFieldSchema,
    color: dataChartFieldSchema.optional(),
    xAxis: axisSchema.optional(),
    yAxis: axisSchema.optional(),
    options: cartesianOptionsSchema.default(() => ({
      orientation: "vertical" as const,
      stack: "none" as const,
      curve: "monotone" as const,
      grid: true,
      legend: "auto" as const,
    })),
  } as const;

  return z.discriminatedUnion("mark", [
    z.object({ mark: z.literal("bar"), ...cartesian }).strict(),
    z.object({ mark: z.literal("line"), ...cartesian }).strict(),
    z.object({ mark: z.literal("area"), ...cartesian }).strict(),
    z.object({
      mark: z.literal("scatter"),
      ...common,
      x: dataChartFieldSchema,
      y: dataChartFieldSchema,
      color: dataChartFieldSchema.optional(),
      size: dataChartFieldSchema.optional(),
      xAxis: axisSchema.optional(),
      yAxis: axisSchema.optional(),
      options: z.object({ grid: z.boolean().default(true), legend: z.enum(["auto", "none"]).default("auto") }).strict().default(() => ({ grid: true, legend: "auto" as const })),
    }).strict(),
    z.object({
      mark: z.literal("pie"),
      ...common,
      theta: dataChartFieldSchema,
      color: dataChartFieldSchema,
      options: z.object({ legend: z.enum(["auto", "none"]).default("auto"), donut: z.boolean().default(false) }).strict().default(() => ({ legend: "auto" as const, donut: false })),
    }).strict(),
    z.object({
      mark: z.literal("radar"),
      ...common,
      angle: dataChartFieldSchema,
      radius: dataChartFieldSchema,
      color: dataChartFieldSchema.optional(),
      options: z.object({ legend: z.enum(["auto", "none"]).default("auto") }).strict().default(() => ({ legend: "auto" as const })),
    }).strict(),
  ]).superRefine((spec, context) => {
    const internal = spec as unknown as InternalDataChartSpec;
    for (const field of referencedFields(internal)) {
      if (field.type === "quantitative" && field.timeUnit !== undefined) {
        context.addIssue({ code: "custom", message: "Quantitative fields cannot use time units." });
      }
    }
    if (internal.mark === "line" || internal.mark === "area") {
      if (internal.x.type === "quantitative" || internal.y.type !== "quantitative") {
        context.addIssue({
          code: "custom",
          path: ["x"],
          message: "Line and area charts require a temporal, nominal, or ordinal x field and a quantitative y field.",
        });
      }
    }
    if (internal.mark === "scatter" && (internal.x.type !== "quantitative" || internal.y.type !== "quantitative")) {
      context.addIssue({ code: "custom", message: "Scatter charts require quantitative x and y fields." });
    }
    if (internal.mark === "pie" && (internal.theta.type !== "quantitative" || !isDimension(internal.color))) {
      context.addIssue({ code: "custom", message: "Pie charts require a quantitative theta field and a categorical color field." });
    }
    if (internal.mark === "radar" && (!isDimension(internal.angle) || internal.radius.type !== "quantitative")) {
      context.addIssue({ code: "custom", message: "Radar charts require a categorical angle field and a quantitative radius field." });
    }
  });
}

export const dataChartSpecSchema = createDataChartSpecSchema(resourceBindingExprSchema);
export const resolvedDataChartSpecSchema = createDataChartSpecSchema(resourceDatasetPayloadSchema).superRefine((spec, context) => {
  const internal = spec as unknown as InternalDataChartSpec;
  const columns = new Map(spec.data.columns.map((column) => [column.columnId, column.valueType]));
  for (const field of referencedFields(internal)) {
    const valueType = columns.get(field.field);
    if (valueType === undefined) {
      context.addIssue({ code: "custom", path: ["data", "columns"], message: `Chart references undeclared dataset column ${field.field}.` });
      continue;
    }
    if (!fieldMatchesDataset(field.type, valueType)) {
      context.addIssue({
        code: "custom",
        path: ["data", "columns"],
        message: `Chart field ${field.field} declares ${field.type} but dataset column is ${valueType}.`,
      });
    }
  }
  for (const metric of internal.summary ?? []) {
    if (columns.get(metric.field) !== "number") {
      context.addIssue({ code: "custom", path: ["summary"], message: `Chart metric ${metric.field} must be numeric.` });
    }
  }
});

type ChartField = z.infer<typeof dataChartFieldSchema>;
type CommonSpec = Readonly<{ summary?: readonly z.infer<typeof dataChartMetricSchema>[]; tooltip: Readonly<{ fields?: readonly ChartField[] }> }>;
type CartesianSpec = CommonSpec & Readonly<{ mark: "bar" | "line" | "area"; x: ChartField; y: ChartField; color?: ChartField }>;
type ScatterSpec = CommonSpec & Readonly<{ mark: "scatter"; x: ChartField; y: ChartField; color?: ChartField; size?: ChartField }>;
type PieSpec = CommonSpec & Readonly<{ mark: "pie"; theta: ChartField; color: ChartField }>;
type RadarSpec = CommonSpec & Readonly<{ mark: "radar"; angle: ChartField; radius: ChartField; color?: ChartField }>;
type InternalDataChartSpec = CartesianSpec | ScatterSpec | PieSpec | RadarSpec;

export function referencedFields(spec: InternalDataChartSpec): ChartField[] {
  const common = [
    ...(spec.tooltip.fields ?? []),
  ];
  switch (spec.mark) {
    case "bar":
    case "line":
    case "area": return [spec.x, spec.y, ...(spec.color ? [spec.color] : []), ...common];
    case "scatter": return [spec.x, spec.y, ...(spec.color ? [spec.color] : []), ...(spec.size ? [spec.size] : []), ...common];
    case "pie": return [spec.theta, spec.color, ...common];
    case "radar": return [spec.angle, spec.radius, ...(spec.color ? [spec.color] : []), ...common];
  }
}

function isDimension(field: ChartField): boolean {
  return field.type === "nominal" || field.type === "ordinal" || field.type === "temporal";
}

function fieldMatchesDataset(fieldType: z.infer<typeof dataChartFieldTypeSchema>, datasetType: string): boolean {
  if (fieldType === "quantitative") return datasetType === "number";
  if (fieldType === "temporal") return datasetType === "date" || datasetType === "datetime";
  return datasetType === "string";
}

export type DataChartMark = z.infer<typeof dataChartMarkSchema>;
export type DataChartField = z.infer<typeof dataChartFieldSchema>;
export type DataChartMetric = z.infer<typeof dataChartMetricSchema>;
export type DataChartSpec = z.infer<typeof dataChartSpecSchema>;
export type ResolvedDataChartSpec = z.infer<typeof resolvedDataChartSpecSchema>;
export type DataChartCellValue = z.infer<typeof resourceDatasetCellValueSchema>;
export type ResolvedDataChart = z.infer<typeof resourceDatasetPayloadSchema>;
