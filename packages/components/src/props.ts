import { z } from "zod";
import { dataChartSpecSchema, resolvedDataChartSpecSchema } from "./data-chart-spec";

export const dataChartAuthoringPropsSchema = z.object({
  spec: dataChartSpecSchema,
}).strict();

export const dataChartPropsSchema = z.object({
  spec: resolvedDataChartSpecSchema,
}).strict();

export type DataChartAuthoringProps = z.infer<typeof dataChartAuthoringPropsSchema>;
export type DataChartProps = z.infer<typeof dataChartPropsSchema>;
