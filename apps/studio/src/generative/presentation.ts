import { createHash } from "node:crypto";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import type {
  DataChartSpecInput,
  OpenGenerativeAuthority,
  PresentDataChartInput,
} from "@open-generative/host";
import {
  actorAuditRefSchema,
  columnIdSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type ResourceDatasetPayload,
} from "@open-generative/protocol";

const MAX_CHART_ROWS = 10_000;
const MAX_CHART_LABEL_LENGTH = 512;
const AUTHORITY_POLICY_REVISION = "tessera-studio.v1";

type AnalysisColumn = Readonly<{ outputId: string; label: string; type: string }>;
type ChartDimension = Readonly<{ column: AnalysisColumn; fieldType: "nominal" | "temporal" }>;
type ChartMetric = Readonly<{ column: AnalysisColumn }>;

export type TesseraPresentationIdentity = Readonly<{
  subject: string;
  tenantId: string;
}>;

export type TesseraDataChartPresentation = Pick<PresentDataChartInput, "authority" | "dataset" | "spec" | "title">;

/**
 * Projects a completed governed analysis into the public Data Chart grammar.
 * The projection intentionally uses only facts present in the result schema:
 * it does not ask a model to emit code, generated styles, or domain recipes.
 */
export function createTesseraDataChartPresentation(input: Readonly<{
  analysis: Readonly<{ result: DataAgentRunResult; title: string }>;
  identity: TesseraPresentationIdentity;
}>): TesseraDataChartPresentation | undefined {
  const title = boundedTitle(input.analysis.title);
  const rows = input.analysis.result.execution.result.rows;
  if (!title || rows.length < 1 || rows.length > MAX_CHART_ROWS) return undefined;

  const inference = inferChartFields(input.analysis.result.columns);
  if (!inference) return undefined;

  const dataset = createChartDataset(rows, inference);
  if (dataset === undefined || dataset.rows.length === 0) return undefined;

  const spec = createChartSpec(title, inference);
  return Object.freeze({
    authority: createTesseraPresentationAuthority(input.identity),
    dataset,
    title,
    spec,
  });
}

/** Produces stable opaque bindings without ever placing a Studio identity in a surface event. */
export function createTesseraPresentationAuthority(
  identity: TesseraPresentationIdentity,
): OpenGenerativeAuthority {
  const actor = opaqueIdentityHash("actor", identity.subject);
  const tenant = opaqueIdentityHash("tenant", identity.tenantId);
  return Object.freeze({
    actorAuditRef: actorAuditRefSchema.parse(`tessera:actor:${actor.slice("sha256:".length)}`),
    actorBindingHash: sha256HashSchema.parse(actor),
    tenantBindingHash: sha256HashSchema.parse(tenant),
    authorityPolicyRevision: AUTHORITY_POLICY_REVISION,
  });
}

type InferredChart =
  | Readonly<{ kind: "cartesian"; mark: "bar" | "line"; dimension: ChartDimension; metric: ChartMetric; color?: ChartDimension }>
  | Readonly<{ kind: "scatter"; x: ChartMetric; y: ChartMetric; color?: ChartDimension }>;

function inferChartFields(columns: readonly AnalysisColumn[]): InferredChart | undefined {
  const metrics = columns.filter(isMetric).map((column) => ({ column }));
  if (metrics.length === 0) return undefined;

  const temporal = columns.find(isTemporalDimension);
  const categorical = columns.filter(isCategoricalDimension);
  if (temporal) {
    const color = categorical.find((column) => column.outputId !== temporal.outputId);
    return {
      kind: "cartesian",
      mark: "line",
      dimension: { column: temporal, fieldType: "temporal" },
      metric: metrics[0]!,
      ...(color ? { color: { column: color, fieldType: "nominal" as const } } : {}),
    };
  }
  if (categorical.length > 0) {
    const [dimension, color] = categorical;
    return {
      kind: "cartesian",
      mark: "bar",
      dimension: { column: dimension!, fieldType: "nominal" },
      metric: metrics[0]!,
      ...(color ? { color: { column: color, fieldType: "nominal" as const } } : {}),
    };
  }
  if (metrics.length >= 2) {
    return { kind: "scatter", x: metrics[0]!, y: metrics[1]! };
  }
  return undefined;
}

function createChartDataset(rows: readonly Record<string, unknown>[], inference: InferredChart): ResourceDatasetPayload | undefined {
  const columns = inference.kind === "cartesian"
    ? [inference.dimension.column, inference.metric.column, ...(inference.color ? [inference.color.column] : [])]
    : [inference.x.column, inference.y.column, ...(inference.color ? [inference.color.column] : [])];
  const columnIds = columns.map((column) => columnIdSchema.parse(column.outputId));
  if (new Set(columnIds).size !== columnIds.length) return undefined;

  const chartRows: Record<string, string | number | null>[] = [];
  for (const row of rows) {
    const values = inference.kind === "cartesian"
      ? cartesianRow(row, inference)
      : scatterRow(row, inference);
    if (values !== undefined) chartRows.push(values);
  }
  if (chartRows.length === 0) return undefined;

  return resourceDatasetPayloadSchema.parse({
    columns: columns.map((column) => ({
      columnId: columnIdSchema.parse(column.outputId),
      label: column.label,
      valueType: column.type === "date" ? "date" : column.type === "timestamp" ? "datetime" : column.type === "string" ? "string" : "number",
    })),
    rows: chartRows,
    totalRows: chartRows.length,
    hasMore: false,
  });
}

function cartesianRow(row: Record<string, unknown>, inference: Extract<InferredChart, { kind: "cartesian" }>): Record<string, string | number | null> | undefined {
  const dimension = safeDimensionValue(row[inference.dimension.column.outputId], inference.dimension.fieldType);
  const metric = safeNumericValue(row[inference.metric.column.outputId]);
  if (dimension === undefined || metric === undefined) return undefined;
  const result: Record<string, string | number | null> = {
    [inference.dimension.column.outputId]: dimension,
    [inference.metric.column.outputId]: metric,
  };
  if (inference.color) {
    const color = safeDimensionValue(row[inference.color.column.outputId], "nominal");
    if (color === undefined) return undefined;
    result[inference.color.column.outputId] = color;
  }
  return result;
}

function scatterRow(row: Record<string, unknown>, inference: Extract<InferredChart, { kind: "scatter" }>): Record<string, string | number | null> | undefined {
  const x = safeNumericValue(row[inference.x.column.outputId]);
  const y = safeNumericValue(row[inference.y.column.outputId]);
  if (x === undefined || y === undefined) return undefined;
  return { [inference.x.column.outputId]: x, [inference.y.column.outputId]: y };
}

function createChartSpec(title: string, inference: InferredChart): DataChartSpecInput {
  const accessibility = {
    label: `${title} chart`,
    description: "The same governed values are available in the equivalent data table.",
  };
  if (inference.kind === "scatter") {
    return {
      mark: "scatter",
      title,
      x: quantitativeField(inference.x.column),
      y: quantitativeField(inference.y.column),
      tooltip: { mode: "auto" },
      options: { grid: true, legend: "auto" },
      equivalentView: "table",
      accessibility,
    };
  }
  const x = inference.dimension.fieldType === "temporal"
    ? temporalField(inference.dimension.column)
    : nominalField(inference.dimension.column);
  const base = {
    title,
    x,
    y: quantitativeField(inference.metric.column),
    ...(inference.color ? { color: nominalField(inference.color.column) } : {}),
    tooltip: { mode: "auto" as const },
    options: {
      orientation: "vertical" as const,
      stack: "none" as const,
      curve: "monotone" as const,
      grid: true,
      legend: "auto" as const,
    },
    equivalentView: "table" as const,
    accessibility,
  };
  return inference.mark === "line" ? { mark: "line", ...base } : { mark: "bar", ...base };
}

function nominalField(column: AnalysisColumn) {
  return { field: columnIdSchema.parse(column.outputId), type: "nominal" as const, title: column.label };
}

function temporalField(column: AnalysisColumn) {
  return { field: columnIdSchema.parse(column.outputId), type: "temporal" as const, title: column.label, timeUnit: "auto" as const };
}

function quantitativeField(column: AnalysisColumn) {
  return { field: columnIdSchema.parse(column.outputId), type: "quantitative" as const, title: column.label };
}

function isMetric(column: AnalysisColumn): boolean {
  return column.type === "number" || column.type === "decimal";
}

function isTemporalDimension(column: AnalysisColumn): boolean {
  return column.type === "date" || column.type === "timestamp";
}

function isCategoricalDimension(column: AnalysisColumn): boolean {
  return column.type === "string";
}

function safeDimensionValue(value: unknown, type: "nominal" | "temporal"): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CHART_LABEL_LENGTH) return undefined;
  if (type === "temporal" && Number.isNaN(Date.parse(normalized))) return undefined;
  return normalized;
}

function safeNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedTitle(value: string): string | undefined {
  const title = value.trim();
  return title.length > 0 && title.length <= 200 ? title : undefined;
}

function opaqueIdentityHash(domain: "actor" | "tenant", value: string): string {
  const hash = createHash("sha256");
  hash.update(`open-generative.tessera.${domain}\0`, "utf8");
  hash.update(value, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
