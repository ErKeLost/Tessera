import { z } from "zod";
import { resolvedChartDataSchema } from "./chart-spec";
import { resourceBindingExprSchema } from "./schema";

const text = (max: number) => z.string().trim().min(1).max(max);

export const layoutStackAuthoringPropsSchema = z.object({
  gap: z.enum(["none", "sm", "md", "lg"]).default("md"),
}).strict();
export const layoutStackPropsSchema = layoutStackAuthoringPropsSchema;

export const layoutGridAuthoringPropsSchema = z.object({
  columns: z.number().int().min(1).max(4).default(2),
  gap: z.enum(["none", "sm", "md", "lg"]).default("md"),
}).strict();
export const layoutGridPropsSchema = layoutGridAuthoringPropsSchema;

export const analysisReportAuthoringPropsSchema = z.object({
  title: text(256),
  description: text(1_024).optional(),
}).strict();
export const analysisReportPropsSchema = analysisReportAuthoringPropsSchema;

export const dataMetricAuthoringPropsSchema = z.object({
  label: text(256),
  data: resourceBindingExprSchema,
  valueColumn: z.string().min(1).max(256).optional(),
  format: z.enum(["number", "compact", "percent"]).default("number"),
}).strict();
export const dataMetricPropsSchema = z.object({
  label: text(256),
  data: resolvedChartDataSchema,
  valueColumn: z.string().min(1).max(256).optional(),
  format: z.enum(["number", "compact", "percent"]),
}).strict();

export const analysisInsightPropsSchema = z.object({
  title: text(256),
  body: text(2_048),
  tone: z.enum(["neutral", "positive", "warning"]).default("neutral"),
}).strict();

export type LayoutStackProps = z.infer<typeof layoutStackPropsSchema>;
export type LayoutGridProps = z.infer<typeof layoutGridPropsSchema>;
export type AnalysisReportProps = z.infer<typeof analysisReportPropsSchema>;
export type DataMetricAuthoringProps = z.infer<typeof dataMetricAuthoringPropsSchema>;
export type DataMetricProps = z.infer<typeof dataMetricPropsSchema>;
export type AnalysisInsightProps = z.infer<typeof analysisInsightPropsSchema>;
