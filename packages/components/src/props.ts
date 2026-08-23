import { z } from "zod";
import { chartSpecSchema, resolvedChartSpecSchema } from "./chart-spec";

export const dataChartAuthoringPropsSchema = z.object({
  spec: chartSpecSchema,
}).strict();

export const dataChartPropsSchema = z.object({
  spec: resolvedChartSpecSchema,
}).strict();

export type DataChartAuthoringProps = z.infer<typeof dataChartAuthoringPropsSchema>;
export type DataChartProps = z.infer<typeof dataChartPropsSchema>;
