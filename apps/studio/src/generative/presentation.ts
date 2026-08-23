import { createHash } from "node:crypto";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import {
  dataChartPropsSchema,
} from "@open-generative/components";
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
type ChartValue = string | number | null;
type UnboundChartSpec = Readonly<Record<string, unknown>>;
type ChartPlan = Readonly<{
  columns: readonly AnalysisColumn[];
  spec: UnboundChartSpec;
}>;

export type TesseraPresentationIdentity = Readonly<{
  subject: string;
  tenantId: string;
}>;

export type TesseraDataChartPresentation = Pick<PresentDataChartInput, "authority" | "dataset" | "spec" | "title">;

/**
 * Projects a completed governed analysis into one exact Data Chart recipe.
 *
 * The planner works only from the query result's declared fields and values.
 * It never asks the model for rendering code and never manufactures fixture
 * rows to make a visually attractive component fit an unrelated result.
 */
export function createTesseraDataChartPresentation(input: Readonly<{
  analysis: Readonly<{ result: DataAgentRunResult; title: string }>;
  identity: TesseraPresentationIdentity;
}>): TesseraDataChartPresentation | undefined {
  const title = boundedTitle(input.analysis.title);
  const rows = input.analysis.result.execution.result.rows;
  if (!title || rows.length < 1 || rows.length > MAX_CHART_ROWS) return undefined;

  const plan = planTesseraChart(title, input.analysis.result.columns, rows);
  if (plan === undefined) return undefined;

  const dataset = createChartDataset(rows, plan.columns);
  if (dataset === undefined || dataset.rows.length === 0) return undefined;

  // Validate the fully resolved projection here, before Host publication. This
  // also rejects recipe-specific cardinality constraints such as 7-day steps.
  const resolved = dataChartPropsSchema.safeParse({
    spec: { ...plan.spec, data: dataset },
  });
  if (!resolved.success) return undefined;
  const { data: _dataset, ...spec } = resolved.data.spec;

  return Object.freeze({
    authority: createTesseraPresentationAuthority(input.identity),
    dataset,
    title,
    spec: spec as DataChartSpecInput,
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

/**
 * These rules are intentionally semantic rather than visual fallbacks. A
 * renderer only receives a recipe when the result has the columns its design
 * promises to explain. The order is most-specific first.
 */
function planTesseraChart(
  title: string,
  columns: readonly AnalysisColumn[],
  rows: readonly Record<string, unknown>[],
): ChartPlan | undefined {
  const steps = planStepsBars(title, columns, rows);
  if (steps) return steps;
  const sleep = planSleepScore(title, columns, rows);
  if (sleep) return sleep;
  const scatter = planRevenueScatter(title, columns, rows);
  if (scatter) return scatter;
  const sankey = planTrackedTime(title, columns, rows);
  if (sankey) return sankey;
  const calendar = planActivityCalendar(title, columns, rows);
  if (calendar) return calendar;
  const heatmap = planActiveUsersHeatmap(title, columns, rows);
  if (heatmap) return heatmap;
  const contributions = planContributionsHeatmap(title, columns, rows);
  if (contributions) return contributions;
  const combo = planSessionsConversion(title, columns, rows);
  if (combo) return combo;
  const stacked = planVisitorsStackedArea(title, columns, rows);
  if (stacked) return stacked;
  const rings = planActivityRings(title, columns, rows);
  if (rings) return rings;
  const funnel = planSignUpFunnel(title, columns, rows);
  if (funnel) return funnel;
  const pipeline = planPipeline(title, columns, rows);
  if (pipeline) return pipeline;
  const smooth = planRevenueSmoothArea(title, columns, rows);
  if (smooth) return smooth;
  const earned = planEarnedSoFar(title, columns, rows);
  if (earned) return earned;
  const radial = planVisitorsRadial(title, columns, rows);
  if (radial) return radial;
  const radar = planVisitorsRadar(title, columns, rows);
  if (radar) return radar;
  return planDevicesBars(title, columns, rows);
}

function planStepsBars(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const date = findTemporal(columns, ["date", "day"]);
  const value = findNumeric(columns, ["steps", "step"]);
  const goal = findNumeric(columns, ["goal", "target"], [value]);
  if (!date || !value || !goal || rows.length !== 7) return undefined;
  const selectedDate = latestDate(rows, date);
  if (!selectedDate) return undefined;
  return plan([date, value, goal], {
    recipe: "steps-bars",
    ...common(title),
    dateColumn: date.outputId,
    valueColumn: value.outputId,
    goalColumn: goal.outputId,
    selectedDate,
    unitLabel: value.label,
    locale: "en-US",
    valueFormat: numberFormat(),
  });
}

function planPipeline(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const stage = findText(columns, ["stage", "step"]);
  const value = findNumeric(columns, ["count", "users", "visitors", "value", "total"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [value]);
  if (!stage || !value || !change || rows.length !== 6) return undefined;
  return plan([stage, value, change], {
    recipe: "pipeline-stage-bars",
    ...common(title),
    stageColumn: stage.outputId,
    valueColumn: value.outputId,
    summary: metric(value, "maximum"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    valueFormat: numberFormat(),
  });
}

function planSleepScore(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const label = findText(columns, ["category", "contributor", "metric"]);
  const detail = findText(columns, ["detail", "description", "note"], [label]);
  const score = findNumeric(columns, ["score"]);
  const target = findNumeric(columns, ["target", "goal", "maximum"], [score]);
  const dates = findTemporal(columns, ["date", "day", "week"]);
  if (!label || !detail || !score || !target || !dates || rows.length !== 3) return undefined;
  const periodEnd = latestDate(rows, dates);
  const periodStart = earliestDate(rows, dates);
  if (!periodStart || !periodEnd) return undefined;
  return plan([label, detail, score, target, dates], {
    recipe: "sleep-score",
    ...common(title, "Score details"),
    labelColumn: label.outputId,
    detailColumn: detail.outputId,
    scoreColumn: score.outputId,
    targetColumn: target.outputId,
    score: metric(score, "sum", score.label),
    periodStart,
    periodEnd,
    locale: "en-US",
    scoreFormat: numberFormat(),
  });
}

function planRevenueScatter(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const account = findText(columns, ["account", "customer", "company"]);
  const revenue = findNumeric(columns, ["revenue", "sales", "amount"]);
  const comparison = findNumeric(columns, ["sessions", "spend", "visits", "usage"], [revenue]);
  const size = findNumeric(columns, ["opportunities", "opportunity", "size", "count"], [revenue, comparison]);
  const group = findText(columns, ["plan", "tier", "segment", "group"], [account]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [revenue, comparison, size]);
  if (!account || !revenue || !comparison || !size || !group || !change || rows.length !== 16) return undefined;
  if (distinctCount(rows, group) !== 3) return undefined;
  return plan([account, revenue, comparison, size, group, change], {
    recipe: "revenue-per-account-scatter",
    ...common(title),
    accountColumn: account.outputId,
    revenueColumn: revenue.outputId,
    comparisonColumn: comparison.outputId,
    sizeColumn: size.outputId,
    groupColumn: group.outputId,
    summary: metric(revenue, "average"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    revenueFormat: numberFormat("compact"),
    comparisonFormat: numberFormat(),
  });
}

function planTrackedTime(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const source = findText(columns, ["source", "from"]);
  const target = findText(columns, ["target", "destination", "to"], [source]);
  const value = findNumeric(columns, ["hours", "duration", "time", "value"]);
  if (!source || !target || !value || distinctCount(rows, source) !== 5 || distinctCount(rows, target) !== 7) return undefined;
  return plan([source, target, value], {
    recipe: "tracked-time-sankey",
    ...common(title),
    sourceColumn: source.outputId,
    targetColumn: target.outputId,
    valueColumn: value.outputId,
    summary: metric(value, "sum"),
    periodLabel: resultPeriodLabel(),
    unitLabel: value.label.toLowerCase().includes("hour") ? "h" : value.label,
    valueFormat: numberFormat(),
  });
}

function planVisitorsRadial(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const category = findText(columns, ["source", "channel", "browser"]);
  const visitors = findNumeric(columns, ["visitors", "users", "sessions"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [visitors]);
  if (!category || !visitors || !change) return undefined;
  return plan([category, visitors, change], {
    recipe: "visitors-radial",
    ...common(title),
    categoryColumn: category.outputId,
    valueColumn: visitors.outputId,
    summary: metric(visitors, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    valueFormat: numberFormat("compact"),
  });
}

function planVisitorsRadar(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const dimension = findText(columns, ["month", "category", "dimension", "metric"]);
  const visitors = findNumeric(columns, ["visitors", "users"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [visitors]);
  if (!dimension || !visitors || !change) return undefined;
  return plan([dimension, visitors, change], {
    recipe: "visitors-radar",
    ...common(title),
    dimensionColumn: dimension.outputId,
    valueColumn: visitors.outputId,
    summary: metric(visitors, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    valueFormat: numberFormat("compact"),
  });
}

function planActivityCalendar(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const date = findTemporal(columns, ["date", "day"]);
  const value = findNumeric(columns, ["steps", "activity", "value"]);
  const series = otherNumeric(columns, [value], 3);
  const selectedDate = date ? latestDate(rows, date) : undefined;
  if (!date || !value || series.length !== 3 || !selectedDate) return undefined;
  return plan([date, value, ...series], {
    recipe: "activity-calendar",
    ...common(title),
    dateColumn: date.outputId,
    valueColumn: value.outputId,
    summary: metric(value, "sum"),
    series: series.map(column => seriesColumn(column)),
    selectedDate,
    valueFormat: numberFormat(),
  });
}

function planRevenueSmoothArea(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const time = findTemporal(columns, ["date", "month", "week", "day", "time"]);
  const revenue = findNumeric(columns, ["revenue", "sales", "income", "amount"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [revenue]);
  if (!time || !revenue || !change || !hasAtLeast(rows, 2)) return undefined;
  return plan([time, revenue, change], {
    recipe: "revenue-smooth-area",
    ...common(title),
    timeColumn: time.outputId,
    revenueColumn: revenue.outputId,
    summary: metric(revenue, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    revenueFormat: numberFormat("compact"),
  });
}

function planActiveUsersHeatmap(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const day = findText(columns, ["day", "weekday"]);
  const bucket = findText(columns, ["hour", "time bucket", "time_bucket"], [day]);
  const users = findNumeric(columns, ["active users", "users", "visitors"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [users]);
  if (!day || !bucket || !users || !change) return undefined;
  return plan([day, bucket, users, change], {
    recipe: "active-users-heatmap",
    ...common(title),
    dayColumn: day.outputId,
    timeBucketColumn: bucket.outputId,
    valueColumn: users.outputId,
    summary: metric(users, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    valueFormat: numberFormat(),
  });
}

function planSignUpFunnel(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const stage = findText(columns, ["stage", "step"]);
  const users = findNumeric(columns, ["users", "signups", "count", "visitors"]);
  const conversion = findNumeric(columns, ["conversion", "rate"], [users]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [users, conversion]);
  if (!stage || !users || !conversion || !change) return undefined;
  return plan([stage, users, conversion, change], {
    recipe: "sign-up-funnel",
    ...common(title),
    stageColumn: stage.outputId,
    valueColumn: users.outputId,
    summary: metric(users, "first"),
    conversion: metric(conversion, "last", "Converted", percentFormat()),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    valueFormat: numberFormat("compact"),
  });
}

function planEarnedSoFar(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const period = findTemporal(columns, ["date", "month", "week", "quarter", "year"])
    ?? findText(columns, ["month", "week", "quarter", "year", "period"]);
  const earned = findNumeric(columns, ["earned", "revenue", "sales", "income"]);
  const target = findNumeric(columns, ["target", "goal", "budget"], [earned]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [earned, target]);
  if (!period || !earned || !change) return undefined;
  return plan([period, earned, ...(target ? [target] : []), change], {
    recipe: "earned-so-far-bars",
    ...common(title),
    periodColumn: period.outputId,
    earnedColumn: earned.outputId,
    ...(target ? { targetColumn: target.outputId } : {}),
    summary: metric(earned, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    earnedFormat: numberFormat("compact"),
  });
}

function planContributionsHeatmap(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const date = findTemporal(columns, ["date", "day"]);
  const value = findNumeric(columns, ["contribution", "commit", "activity"]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [value]);
  const highlights = otherNumeric(columns, [value, change], 4);
  if (!date || !value || !change || highlights.length !== 4) return undefined;
  return plan([date, value, change, ...highlights], {
    recipe: "contributions-heatmap",
    ...common(title),
    dateColumn: date.outputId,
    valueColumn: value.outputId,
    summary: metric(value, "sum"),
    change: metric(change, "last", "Change", percentFormat()),
    highlights: highlights.map(column => metric(column, "first")),
    valueFormat: numberFormat(),
  });
}

function planSessionsConversion(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const time = findTemporal(columns, ["date", "month", "week", "day", "time"]);
  const sessions = findNumeric(columns, ["sessions", "visits"]);
  const conversion = findNumeric(columns, ["conversion", "rate"], [sessions]);
  const change = findNumeric(columns, ["change", "growth", "delta"], [sessions, conversion]);
  if (!time || !sessions || !conversion || !change || !hasAtLeast(rows, 2)) return undefined;
  return plan([time, sessions, conversion, change], {
    recipe: "sessions-conversion-combo",
    ...common(title),
    timeColumn: time.outputId,
    sessionsColumn: sessions.outputId,
    conversionColumn: conversion.outputId,
    sessionsSummary: metric(sessions, "sum"),
    conversionSummary: metric(conversion, "average", conversion.label, percentFormat()),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
    sessionsFormat: numberFormat("compact"),
    conversionFormat: percentFormat(),
  });
}

function planDevicesBars(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const device = findText(columns, ["device", "browser", "operating system", "os"]);
  const share = findNumeric(columns, ["share", "percent", "percentage", "rate"]);
  if (!device || !share || !valuesAreFractions(rows, share)) return undefined;
  return plan([device, share], {
    recipe: "devices-bars",
    ...common(title),
    deviceColumn: device.outputId,
    valueColumn: share.outputId,
    summary: metric(share, "sum", share.label, percentFormat()),
    valueFormat: percentFormat(),
  });
}

function planVisitorsStackedArea(title: string, columns: readonly AnalysisColumn[], rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const time = findTemporal(columns, ["date", "month", "week", "day", "time"]);
  const change = findNumeric(columns, ["change", "growth", "delta"]);
  const total = findNumeric(columns, ["total visitors", "total users", "total"], [change]);
  const series = otherNumeric(columns, [change, total], 5).filter(column => !matches(column, ["conversion", "rate"]));
  if (!time || !change || !total || series.length < 2 || !hasAtLeast(rows, 2)) return undefined;
  return plan([time, ...series, total, change], {
    recipe: "visitors-stacked-area",
    ...common(title),
    timeColumn: time.outputId,
    series: series.map(column => seriesColumn(column)),
    summary: metric(total, "last"),
    change: metric(change, "last", "Change", percentFormat()),
    periodLabel: resultPeriodLabel(),
  });
}

function planActivityRings(title: string, columns: readonly AnalysisColumn[], _rows: readonly Record<string, unknown>[]): ChartPlan | undefined {
  const activity = findText(columns, ["activity", "metric", "category"]);
  const detail = findText(columns, ["detail", "description", "label"], [activity]);
  const value = findNumeric(columns, ["value", "actual", "completed"]);
  const target = findNumeric(columns, ["target", "goal", "maximum"], [value]);
  if (!activity || !detail || !value || !target) return undefined;
  return plan([activity, value, target, detail], {
    recipe: "activity-rings",
    ...common(title),
    activityColumn: activity.outputId,
    valueColumn: value.outputId,
    targetColumn: target.outputId,
    detailColumn: detail.outputId,
    valueFormat: numberFormat(),
  });
}

function plan(columns: readonly AnalysisColumn[], spec: UnboundChartSpec): ChartPlan {
  return Object.freeze({ columns: uniqueColumns(columns), spec: Object.freeze(spec) });
}

function common(title: string, subtitle?: string): UnboundChartSpec {
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    equivalentView: "table",
    accessibility: {
      label: `${title} chart`,
      description: "The same governed values are available in the equivalent data table.",
    },
  };
}

function metric(
  column: AnalysisColumn,
  aggregate: "sum" | "average" | "minimum" | "maximum" | "first" | "last",
  label = column.label,
  format?: Readonly<Record<string, unknown>>,
): UnboundChartSpec {
  return {
    column: column.outputId,
    aggregate,
    label,
    ...(format ? { format } : {}),
  };
}

function seriesColumn(column: AnalysisColumn): UnboundChartSpec {
  return { column: column.outputId, label: column.label, format: numberFormat("compact") };
}

function numberFormat(notation: "standard" | "compact" = "standard"): UnboundChartSpec {
  return { kind: "number", notation, maximumFractionDigits: notation === "compact" ? 1 : 0 };
}

function percentFormat(): UnboundChartSpec {
  return { kind: "percent", maximumFractionDigits: 1 };
}

function createChartDataset(
  sourceRows: readonly Record<string, unknown>[],
  selectedColumns: readonly AnalysisColumn[],
): ResourceDatasetPayload | undefined {
  const columns = uniqueColumns(selectedColumns);
  if (columns.length === 0 || columns.length > 32) return undefined;
  const outputColumns = columns.map(column => ({
    columnId: columnIdSchema.parse(column.outputId),
    label: boundedLabel(column.label),
    valueType: datasetValueType(column),
  }));
  const rows: Record<string, ChartValue>[] = [];
  for (const sourceRow of sourceRows) {
    const row: Record<string, ChartValue> = {};
    let valid = true;
    for (const column of columns) {
      const value = toChartValue(sourceRow[column.outputId], column);
      if (value === undefined) {
        valid = false;
        break;
      }
      row[column.outputId] = value;
    }
    if (valid) rows.push(row);
  }
  if (rows.length === 0) return undefined;
  return resourceDatasetPayloadSchema.parse({
    columns: outputColumns,
    rows,
    totalRows: rows.length,
    hasMore: false,
  });
}

function toChartValue(value: unknown, column: AnalysisColumn): ChartValue | undefined {
  if (value === null) return null;
  if (isNumeric(column)) return safeNumericValue(value);
  if (isTemporal(column)) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CHART_LABEL_LENGTH || Number.isNaN(Date.parse(value))) return undefined;
    return value;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_CHART_LABEL_LENGTH ? normalized : undefined;
}

function datasetValueType(column: AnalysisColumn): "date" | "datetime" | "number" | "string" {
  if (column.type === "date") return "date";
  if (column.type === "timestamp") return "datetime";
  return isNumeric(column) ? "number" : "string";
}

function findNumeric(columns: readonly AnalysisColumn[], terms: readonly string[], excluded: readonly (AnalysisColumn | undefined)[] = []): AnalysisColumn | undefined {
  return columns.find(column => isNumeric(column) && !excluded.includes(column) && matches(column, terms));
}

function findText(columns: readonly AnalysisColumn[], terms: readonly string[], excluded: readonly (AnalysisColumn | undefined)[] = []): AnalysisColumn | undefined {
  return columns.find(column => isText(column) && !excluded.includes(column) && matches(column, terms));
}

function findTemporal(columns: readonly AnalysisColumn[], terms: readonly string[]): AnalysisColumn | undefined {
  return columns.find(column => isTemporal(column) && matches(column, terms));
}

function otherNumeric(columns: readonly AnalysisColumn[], excluded: readonly (AnalysisColumn | undefined)[], maximum: number): AnalysisColumn[] {
  return columns.filter(column => isNumeric(column) && !excluded.includes(column)).slice(0, maximum);
}

function uniqueColumns(columns: readonly AnalysisColumn[]): AnalysisColumn[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    if (seen.has(column.outputId)) return false;
    seen.add(column.outputId);
    return true;
  });
}

function matches(column: AnalysisColumn, terms: readonly string[]): boolean {
  const subject = `${column.outputId} ${column.label}`.toLowerCase().replace(/[_-]+/g, " ");
  return terms.some(term => subject.includes(term));
}

function isNumeric(column: AnalysisColumn): boolean {
  return column.type === "number" || column.type === "decimal";
}

function isText(column: AnalysisColumn): boolean {
  return column.type === "string";
}

function isTemporal(column: AnalysisColumn): boolean {
  return column.type === "date" || column.type === "timestamp";
}

function safeNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function latestDate(rows: readonly Record<string, unknown>[], column: AnalysisColumn): string | undefined {
  return datedValues(rows, column).at(-1)?.value;
}

function earliestDate(rows: readonly Record<string, unknown>[], column: AnalysisColumn): string | undefined {
  return datedValues(rows, column)[0]?.value;
}

function datedValues(rows: readonly Record<string, unknown>[], column: AnalysisColumn): readonly Readonly<{ value: string; time: number }>[] {
  return rows
    .flatMap((row) => {
      const value = row[column.outputId];
      if (typeof value !== "string" || value.length === 0 || Number.isNaN(Date.parse(value))) return [];
      return [{ value, time: Date.parse(value) }];
    })
    .sort((left, right) => left.time - right.time);
}

function distinctCount(rows: readonly Record<string, unknown>[], column: AnalysisColumn): number {
  return new Set(rows.map(row => row[column.outputId]).filter(value => typeof value === "string" && value.trim().length > 0)).size;
}

function valuesAreFractions(rows: readonly Record<string, unknown>[], column: AnalysisColumn): boolean {
  const values = rows.map(row => safeNumericValue(row[column.outputId])).filter((value): value is number => value !== undefined);
  return values.length > 0 && values.length === rows.length && values.every(value => value >= 0 && value <= 1);
}

function hasAtLeast(rows: readonly Record<string, unknown>[], minimum: number): boolean {
  return rows.length >= minimum;
}

function resultPeriodLabel(): string {
  return "Current result";
}

function boundedTitle(value: string): string | undefined {
  const title = value.trim();
  return title.length > 0 && title.length <= 200 ? title : undefined;
}

function boundedLabel(value: string): string {
  const label = value.trim();
  return label.length > 0 && label.length <= MAX_CHART_LABEL_LENGTH ? label : "Value";
}

function opaqueIdentityHash(domain: "actor" | "tenant", value: string): string {
  const hash = createHash("sha256");
  hash.update(`open-generative.tessera.${domain}\0`, "utf8");
  hash.update(value, "utf8");
  return `sha256:${hash.digest("hex")}`;
}
