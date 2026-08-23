import { resourceDatasetPayloadSchema } from "@open-generative/protocol";
import { z } from "zod";
import {
  dataChartSpecSchema,
  resolvedDataChartSpecSchema,
  type DataChartSpec,
  type ResolvedDataChartSpec,
} from "./data-chart-spec";
import { deepFreeze, resourceBindingExprSchema } from "./schema";

const dataBinding = resourceBindingExprSchema.parse({
  kind: "resource-ref",
  bindingId: "data",
});

export const dataChartFixtureSchema = z.object({
  fixtureId: z.string().regex(/^data-chart\.[a-z0-9-]+$/),
  mark: z.enum(["bar", "line", "area", "scatter", "pie", "radar"]),
  authoringSpec: dataChartSpecSchema,
  resolvedSpec: resolvedDataChartSpecSchema,
}).strict().superRefine((fixture, context) => {
  if (fixture.authoringSpec.mark !== fixture.mark || fixture.resolvedSpec.mark !== fixture.mark) {
    context.addIssue({ code: "custom", message: "Fixture mark must match both chart specifications." });
  }
});

export type DataChartFixture = z.infer<typeof dataChartFixtureSchema>;

function fixture(
  fixtureId: string,
  spec: unknown,
  dataset: unknown,
): DataChartFixture {
  const data = resourceDatasetPayloadSchema.parse(dataset);
  const resolvedSpec = resolvedDataChartSpecSchema.parse({ ...(spec as object), data });
  const authoringSpec = dataChartSpecSchema.parse({ ...(spec as object), data: dataBinding });
  return dataChartFixtureSchema.parse({
    fixtureId,
    mark: resolvedSpec.mark,
    authoringSpec,
    resolvedSpec,
  });
}

/**
 * Test and documentation samples only. Runtime selection never reads these
 * fixtures: every production surface is driven by a caller-supplied grammar.
 */
export const dataChartGrammarFixtures = deepFreeze([
  fixture("data-chart.categorical-bar", {
    mark: "bar",
    title: "Revenue by segment",
    x: { field: "segment", type: "nominal", title: "Segment" },
    y: { field: "revenue", type: "quantitative", title: "Revenue" },
    summary: [{ field: "revenue", aggregate: "sum", label: "Total revenue" }],
    tooltip: { mode: "auto" },
    options: { orientation: "horizontal", stack: "none", curve: "monotone", grid: true, legend: "auto" },
    equivalentView: "table",
    accessibility: { label: "Revenue by segment" },
  }, {
    columns: [
      { columnId: "segment", label: "Segment", valueType: "string" },
      { columnId: "revenue", label: "Revenue", valueType: "number" },
    ],
    rows: [
      { segment: "Enterprise", revenue: 48200 },
      { segment: "Growth", revenue: 31800 },
      { segment: "Starter", revenue: 14700 },
    ],
    totalRows: 3,
    hasMore: false,
  }),
  fixture("data-chart.temporal-line", {
    mark: "line",
    title: "Monthly revenue",
    x: { field: "month", type: "temporal", title: "Month", timeUnit: "month" },
    y: { field: "revenue", type: "quantitative", title: "Revenue" },
    summary: [{ field: "revenue", aggregate: "sum", label: "Revenue" }],
    tooltip: { mode: "auto" },
    options: { orientation: "vertical", stack: "none", curve: "monotone", grid: true, legend: "auto" },
    equivalentView: "table",
    accessibility: { label: "Monthly revenue trend" },
  }, {
    columns: [
      { columnId: "month", label: "Month", valueType: "date" },
      { columnId: "revenue", label: "Revenue", valueType: "number" },
    ],
    rows: [
      { month: "2026-01-01", revenue: 32400 },
      { month: "2026-02-01", revenue: 36700 },
      { month: "2026-03-01", revenue: 41200 },
      { month: "2026-04-01", revenue: 39800 },
    ],
    totalRows: 4,
    hasMore: false,
  }),
  fixture("data-chart.stacked-area", {
    mark: "area",
    title: "Active users by plan",
    x: { field: "week", type: "temporal", title: "Week", timeUnit: "week" },
    y: { field: "activeUsers", type: "quantitative", title: "Active users" },
    color: { field: "plan", type: "nominal", title: "Plan" },
    tooltip: { mode: "auto" },
    options: { orientation: "vertical", stack: "normal", curve: "monotone", grid: true, legend: "auto" },
    equivalentView: "table",
    accessibility: { label: "Active users by plan and week" },
  }, {
    columns: [
      { columnId: "week", label: "Week", valueType: "date" },
      { columnId: "plan", label: "Plan", valueType: "string" },
      { columnId: "activeUsers", label: "Active users", valueType: "number" },
    ],
    rows: [
      { week: "2026-04-06", plan: "Starter", activeUsers: 124 },
      { week: "2026-04-06", plan: "Growth", activeUsers: 92 },
      { week: "2026-04-13", plan: "Starter", activeUsers: 131 },
      { week: "2026-04-13", plan: "Growth", activeUsers: 106 },
    ],
    totalRows: 4,
    hasMore: false,
  }),
  fixture("data-chart.correlation-scatter", {
    mark: "scatter",
    title: "Spend and revenue",
    x: { field: "spend", type: "quantitative", title: "Acquisition spend" },
    y: { field: "revenue", type: "quantitative", title: "Revenue" },
    color: { field: "region", type: "nominal", title: "Region" },
    size: { field: "accounts", type: "quantitative", title: "Accounts" },
    tooltip: { mode: "auto" },
    options: { grid: true, legend: "auto" },
    equivalentView: "table",
    accessibility: { label: "Revenue compared with acquisition spend" },
  }, {
    columns: [
      { columnId: "spend", label: "Acquisition spend", valueType: "number" },
      { columnId: "revenue", label: "Revenue", valueType: "number" },
      { columnId: "accounts", label: "Accounts", valueType: "number" },
      { columnId: "region", label: "Region", valueType: "string" },
    ],
    rows: [
      { spend: 7800, revenue: 38400, accounts: 31, region: "Americas" },
      { spend: 6400, revenue: 29700, accounts: 24, region: "EMEA" },
      { spend: 5100, revenue: 22600, accounts: 18, region: "APAC" },
    ],
    totalRows: 3,
    hasMore: false,
  }),
  fixture("data-chart.share-pie", {
    mark: "pie",
    title: "Revenue share by channel",
    theta: { field: "revenue", type: "quantitative", title: "Revenue" },
    color: { field: "channel", type: "nominal", title: "Channel" },
    tooltip: { mode: "auto" },
    options: { legend: "auto", donut: true },
    equivalentView: "table",
    accessibility: { label: "Revenue share by channel" },
  }, {
    columns: [
      { columnId: "channel", label: "Channel", valueType: "string" },
      { columnId: "revenue", label: "Revenue", valueType: "number" },
    ],
    rows: [
      { channel: "Direct", revenue: 42000 },
      { channel: "Partners", revenue: 27500 },
      { channel: "Marketplace", revenue: 18800 },
    ],
    totalRows: 3,
    hasMore: false,
  }),
  fixture("data-chart.profile-radar", {
    mark: "radar",
    title: "Service profile",
    angle: { field: "dimension", type: "nominal", title: "Dimension" },
    radius: { field: "score", type: "quantitative", title: "Score" },
    tooltip: { mode: "auto" },
    options: { legend: "none" },
    equivalentView: "table",
    accessibility: { label: "Service quality profile" },
  }, {
    columns: [
      { columnId: "dimension", label: "Dimension", valueType: "string" },
      { columnId: "score", label: "Score", valueType: "number" },
    ],
    rows: [
      { dimension: "Reliability", score: 92 },
      { dimension: "Latency", score: 78 },
      { dimension: "Coverage", score: 86 },
      { dimension: "Support", score: 89 },
    ],
    totalRows: 4,
    hasMore: false,
  }),
] as const);

export const dataChartFixtureMarks = dataChartGrammarFixtures.map((fixture) => fixture.mark);
export type DataChartFixtureMark = (typeof dataChartFixtureMarks)[number];
