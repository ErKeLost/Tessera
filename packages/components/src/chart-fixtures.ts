import {
  contractRefSchema,
  sha256HashSchema,
  type HashProvider,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  chartRecipeDefinitionsSchema,
  chartRecipeFamilySchema,
  chartRendererKindSchema,
  chartCapabilityTokenSchema,
  officialChartRecipeDefinitions,
  officialChartRecipeSource,
  chartRecipeSourceSchema,
  type ChartRecipeDefinition,
} from "./chart-recipes";
import {
  chartRecipeSchema,
  chartSpecSchema,
  resolvedChartDataSchema,
  resolvedChartSpecSchema,
  type ChartRecipe,
  type ResolvedChartData,
} from "./chart-spec";
import { type OfficialCatalogBundle } from "./contracts";
import { hashNamespacedCanonical } from "./integrity";
import { deepFreeze } from "./schema";

const fixtureIdSchema = z.string().regex(/^[a-z][a-z0-9.-]+$/);

export const chartSpecFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeSchema,
  recipeFamily: chartRecipeFamilySchema,
  spec: chartSpecSchema,
  dataset: resolvedChartDataSchema,
  resolvedSpec: resolvedChartSpecSchema,
}).strict().superRefine((fixture, context) => {
  if (fixture.recipeName !== fixture.spec.recipe || fixture.recipeName !== fixture.resolvedSpec.recipe) {
    context.addIssue({ code: "custom", path: ["recipeName"], message: "Fixture recipes must agree." });
  }
  if (fixture.spec.data.kind !== "resource-ref") {
    context.addIssue({ code: "custom", path: ["spec", "data"], message: "Authoring fixtures must use Resource Binding." });
  }
});

export const rendererExpectationFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeSchema,
  rendererKind: chartRendererKindSchema,
  semanticElements: z.array(z.enum([
    "equivalent-view",
    "metric",
    "plot",
    "title",
    "tooltip",
  ])).min(4).max(5),
  requiredCapabilities: z.array(chartCapabilityTokenSchema),
  stableSize: z.literal(true),
}).strict();

export const chartAccessibilityFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeSchema,
  accessibleName: z.string().trim().min(1).max(512),
  equivalentView: z.literal("table"),
  keyboardInteractions: z.tuple([z.literal("navigate")]),
  reducedMotion: z.literal("disable-animation"),
  dataSemantics: z.literal("preserved-in-equivalent-view"),
}).strict();

export type ChartSpecFixture = z.infer<typeof chartSpecFixtureSchema>;
export type RendererExpectationFixture = z.infer<typeof rendererExpectationFixtureSchema>;
export type ChartAccessibilityFixture = z.infer<typeof chartAccessibilityFixtureSchema>;

const resourceExpr = { kind: "resource-ref", bindingId: "fixture.chart.dataset" } as const;
const currency = { kind: "currency", currency: "USD", display: "narrow-symbol", maximumFractionDigits: 0 } as const;
const compactNumber = { kind: "number", notation: "compact", maximumFractionDigits: 1 } as const;
const integer = { kind: "number", notation: "standard", maximumFractionDigits: 0 } as const;
const percent = { kind: "percent", maximumFractionDigits: 1 } as const;
const hours = { kind: "number", notation: "standard", maximumFractionDigits: 1, unit: "hours" } as const;
const decimal = { kind: "number", notation: "standard", maximumFractionDigits: 1 } as const;

type DatasetColumn = readonly [id: string, label: string, valueType: "boolean" | "date" | "datetime" | "number" | "string"];

function dataset(columns: readonly DatasetColumn[], rows: readonly Record<string, string | number | boolean | null>[]): ResolvedChartData {
  return resolvedChartDataSchema.parse({
    columns: columns.map(([columnId, label, valueType]) => ({ columnId, label, valueType })),
    rows,
    totalRows: rows.length,
    hasMore: false,
  });
}

function fixture(
  definition: ChartRecipeDefinition,
  fields: Readonly<{ title: string }> & Readonly<Record<string, unknown>>,
  data: ResolvedChartData,
): ChartSpecFixture {
  const spec = chartSpecSchema.parse({
    recipe: definition.recipeName,
    data: resourceExpr,
    equivalentView: "table",
    accessibility: {
      label: `${fields.title} chart`,
      description: "The same values are available in the equivalent data table.",
    },
    ...fields,
  });
  const resolvedSpec = resolvedChartSpecSchema.parse({ ...spec, data });
  return chartSpecFixtureSchema.parse({
    fixtureId: `chart-spec.${definition.recipeName}`,
    recipeName: definition.recipeName,
    recipeFamily: definition.family,
    spec,
    dataset: data,
    resolvedSpec,
  });
}

const byName = new Map(officialChartRecipeDefinitions.map((definition) => [definition.recipeName, definition]));

function definition(recipeName: ChartRecipe): ChartRecipeDefinition {
  const value = byName.get(recipeName);
  if (value === undefined) throw new TypeError(`Missing chart recipe definition for ${recipeName}.`);
  return value;
}

const calendarDates = [
  "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25", "2026-07-26",
  "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02",
  "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09",
  "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16",
  "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23",
] as const;
const calendarValues = [0, 2, 4, 1, 6, 3, 0, 5, 8, 3, 7, 4, 1, 0, 9, 5, 3, 10, 7, 2, 1, 4, 6, 8, 3, 5, 2, 0, 7, 9, 4, 6, 8, 11, 3] as const;
const julyDates = Array.from({ length: 31 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
const contributionDates = Array.from({ length: 371 }, (_, index) => (
  new Date(Date.UTC(2025, 0, 5 + index)).toISOString().slice(0, 10)
));

const fixtures: readonly ChartSpecFixture[] = [
  fixture(definition("steps-bars"), {
    title: "Tuesday",
    dateColumn: "date",
    valueColumn: "steps",
    goalColumn: "goal",
    selectedDate: "2026-06-30",
    unitLabel: "steps",
    locale: "en-GB",
    valueFormat: integer,
  }, dataset([
    ["date", "Date", "date"], ["steps", "Steps", "number"], ["goal", "Goal", "number"],
  ], [
    { date: "2026-06-29", steps: 5_600, goal: 8_000 }, { date: "2026-06-30", steps: 2_200, goal: 8_000 },
    { date: "2026-07-01", steps: 1_900, goal: 8_000 }, { date: "2026-07-02", steps: 6_300, goal: 8_000 },
    { date: "2026-07-03", steps: 7_100, goal: 8_000 }, { date: "2026-07-04", steps: 5_300, goal: 8_000 },
    { date: "2026-07-05", steps: 3_200, goal: 8_000 },
  ])),
  fixture(definition("pipeline-stage-bars"), {
    title: "Pipeline",
    stageColumn: "stage",
    valueColumn: "value",
    summary: { column: "value", aggregate: "maximum", label: "Pipeline", format: integer },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "Last 7 days",
    valueFormat: integer,
  }, dataset([["stage", "Stage", "string"], ["value", "Value", "number"], ["change", "Change", "number"]], [
    { stage: "Visits", value: 1_180, change: 0.024 }, { stage: "Sign-up", value: 790, change: null },
    { stage: "Active", value: 460, change: null }, { stage: "Pro", value: 250, change: null },
    { stage: "Team", value: 120, change: null }, { stage: "Enterprise", value: 40, change: null },
  ])),
  fixture(definition("sleep-score"), {
    title: "Sleep score",
    subtitle: "Excellent",
    labelColumn: "category",
    detailColumn: "detail",
    scoreColumn: "score",
    targetColumn: "target",
    score: { column: "score", aggregate: "sum", label: "Sleep score", format: integer },
    periodStart: "2026-06-29",
    periodEnd: "2026-07-05",
    locale: "en-GB",
    scoreFormat: integer,
  }, dataset([["category", "Category", "string"], ["detail", "Detail", "string"], ["score", "Score", "number"], ["target", "Target", "number"]], [
    { category: "Duration", detail: "7h 50m", score: 49, target: 50 },
    { category: "Bedtime", detail: "20m earlier", score: 29, target: 30 },
    { category: "Interruptions", detail: "5m wake up", score: 20, target: 20 },
  ])),
  fixture(definition("revenue-per-account-scatter"), {
    title: "Revenue per account",
    accountColumn: "account",
    revenueColumn: "revenue",
    comparisonColumn: "sessions",
    sizeColumn: "opportunities",
    groupColumn: "plan",
    summary: { column: "revenue", aggregate: "average", label: "Revenue per account", format: integer },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "This quarter",
    revenueFormat: compactNumber,
    comparisonFormat: integer,
  }, dataset([
    ["account", "Account", "string"], ["revenue", "Revenue", "number"], ["sessions", "Sessions", "number"],
    ["opportunities", "Opportunities", "number"], ["plan", "Plan", "string"], ["change", "Change", "number"],
  ], [
    { account: "Aster", revenue: 180, sessions: 12, opportunities: 11, plan: "Starter", change: 0.068 },
    { account: "Brim", revenue: 240, sessions: 18, opportunities: 13, plan: "Starter", change: null },
    { account: "Cinder", revenue: 210, sessions: 24, opportunities: 9, plan: "Starter", change: null },
    { account: "Dune", revenue: 320, sessions: 31, opportunities: 17, plan: "Starter", change: null },
    { account: "Elm", revenue: 290, sessions: 38, opportunities: 12, plan: "Starter", change: null },
    { account: "Fjord", revenue: 380, sessions: 45, opportunities: 16, plan: "Starter", change: null },
    { account: "Grove", revenue: 640, sessions: 42, opportunities: 18, plan: "Growth", change: null },
    { account: "Harbor", revenue: 760, sessions: 55, opportunities: 22, plan: "Growth", change: null },
    { account: "Iris", revenue: 700, sessions: 61, opportunities: 16, plan: "Growth", change: null },
    { account: "Juniper", revenue: 900, sessions: 68, opportunities: 24, plan: "Growth", change: null },
    { account: "Keel", revenue: 830, sessions: 74, opportunities: 20, plan: "Growth", change: null },
    { account: "Lumen", revenue: 868, sessions: 83, opportunities: 19, plan: "Growth", change: null },
    { account: "Morrow", revenue: 1_240, sessions: 78, opportunities: 25, plan: "Scale", change: null },
    { account: "Northstar", revenue: 1_430, sessions: 86, opportunities: 28, plan: "Scale", change: null },
    { account: "Orbit", revenue: 1_320, sessions: 92, opportunities: 23, plan: "Scale", change: null },
    { account: "Pillar", revenue: 1_562, sessions: 97, opportunities: 30, plan: "Scale", change: null },
  ])),
  fixture(definition("tracked-time-sankey"), {
    title: "Tracked time",
    sourceColumn: "source",
    targetColumn: "target",
    valueColumn: "hours",
    summary: { column: "hours", aggregate: "sum", label: "Tracked time", format: decimal },
    periodLabel: "This week",
    unitLabel: "h",
    valueFormat: decimal,
  }, dataset([["source", "Source", "string"], ["target", "Target", "string"], ["hours", "Hours", "number"]], [
    { source: "Focus", target: "Browsing", hours: 10.5 }, { source: "Focus", target: "Writing", hours: 8.2 },
    { source: "Focus", target: "Messaging", hours: 5.2 }, { source: "Focus", target: "Productivity", hours: 4.6 },
    { source: "Focus", target: "Email", hours: 2.1 }, { source: "Focus", target: "Video calls", hours: 0.8 },
    { source: "Focus", target: "Everything else", hours: 0.6 },
    { source: "Meetings", target: "Writing", hours: 2.5 }, { source: "Meetings", target: "Messaging", hours: 1.4 },
    { source: "Meetings", target: "Email", hours: 1.86 }, { source: "Meetings", target: "Video calls", hours: 9.24 },
    { source: "Meetings", target: "Everything else", hours: 3 },
    { source: "Breaks", target: "Browsing", hours: 3.5 }, { source: "Breaks", target: "Video calls", hours: 2 },
    { source: "Breaks", target: "Everything else", hours: 6.5 },
    { source: "Admin", target: "Writing", hours: 3.4 }, { source: "Admin", target: "Messaging", hours: 3 },
    { source: "Admin", target: "Productivity", hours: 3.6 }, { source: "Admin", target: "Email", hours: 2.92 },
    { source: "Admin", target: "Everything else", hours: 1.08 },
    { source: "Learning", target: "Browsing", hours: 4.92 }, { source: "Learning", target: "Writing", hours: 1.38 },
    { source: "Learning", target: "Messaging", hours: 1.58 }, { source: "Learning", target: "Productivity", hours: 2.12 },
  ])),
  fixture(definition("visitors-radial"), {
    title: "Visitors",
    categoryColumn: "source",
    valueColumn: "visitors",
    summary: { column: "visitors", aggregate: "sum", label: "Total visitors", format: compactNumber },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "Last 7 days",
    valueFormat: compactNumber,
  }, dataset([["source", "Source", "string"], ["visitors", "Visitors", "number"], ["change", "Change", "number"]], [
    { source: "Other", visitors: 90, change: 0.052 }, { source: "Edge", visitors: 173, change: 0.052 },
    { source: "Firefox", visitors: 187, change: 0.052 }, { source: "Safari", visitors: 200, change: 0.052 },
    { source: "Chrome", visitors: 275, change: 0.052 },
  ])),
  fixture(definition("visitors-radar"), {
    title: "Visitors",
    dimensionColumn: "month",
    valueColumn: "visitors",
    summary: { column: "visitors", aggregate: "sum", label: "Visitors", format: compactNumber },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "H1 2024",
    valueFormat: compactNumber,
  }, dataset([["month", "Month", "string"], ["visitors", "Visitors", "number"], ["change", "Change", "number"]], [
    { month: "January", visitors: 186, change: 0.052 }, { month: "February", visitors: 305, change: 0.052 },
    { month: "March", visitors: 237, change: 0.052 }, { month: "April", visitors: 273, change: 0.052 },
    { month: "May", visitors: 209, change: 0.052 }, { month: "June", visitors: 214, change: 0.052 },
  ])),
  fixture(definition("activity-calendar"), {
    title: "Most active days",
    dateColumn: "date",
    valueColumn: "steps",
    summary: { column: "totalSteps", aggregate: "first", label: "Total steps", format: integer },
    series: [
      { column: "move", label: "Move", format: integer },
      { column: "exercise", label: "Exercise", format: integer },
      { column: "running", label: "Running", format: decimal },
    ],
    selectedDate: "2026-07-10",
    valueFormat: integer,
  }, dataset([
    ["date", "Date", "date"], ["steps", "Steps", "number"], ["totalSteps", "Total steps", "number"],
    ["move", "Move", "number"], ["exercise", "Exercise", "number"], ["running", "Running", "number"],
  ], julyDates.map((date, index) => ({
    date,
    steps: index < 10 ? [4210, 5080, 6180, 5320, 7010, 6420, 3960, 7250, 6810, 32459][index]! : 0,
    totalSteps: 32459,
    move: index === 9 ? 816 : 340 + (index * 47) % 510,
    exercise: index === 9 ? 101 : 18 + (index * 13) % 76,
    running: index === 9 ? 5.2 : Number((1.4 + (index * 0.7) % 5).toFixed(1)),
  })))),
  fixture(definition("revenue-smooth-area"), {
    title: "Revenue",
    timeColumn: "month",
    revenueColumn: "revenue",
    summary: { column: "headline", aggregate: "first", label: "Revenue", format: currency },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    revenueFormat: currency,
  }, dataset([["month", "Month", "date"], ["revenue", "Revenue", "number"], ["headline", "Headline", "number"], ["change", "Change", "number"]],
    [1500, 1900, 2700, 2350, 3500, 3200, 2750, 4100, 4750, 4400, 3650, 5500].map((revenue, index) => ({
      month: `2026-${String(index + 1).padStart(2, "0")}-01`, revenue, headline: 18240, change: 0.094,
    })),
  )),
  fixture(definition("active-users-heatmap"), {
    title: "Active users",
    dayColumn: "day",
    timeBucketColumn: "hour",
    valueColumn: "users",
    summary: { column: "headline", aggregate: "first", label: "Active users", format: integer },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "Last 7 days",
    valueFormat: integer,
  }, dataset([["day", "Day", "string"], ["hour", "Hour", "string"], ["users", "Users", "number"], ["headline", "Headline", "number"], ["change", "Change", "number"]],
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].flatMap((day, dayIndex) => (
      ["00", "02", "04", "06", "08", "10", "12", "14", "16", "18", "20", "22"].map((hour, hourIndex) => ({
        day, hour, users: 12 + Math.round(88 * Math.max(0.1, 1 - Math.abs(hourIndex - 6) / 7) * (1 - dayIndex * 0.055)), headline: 1892, change: 0.052,
      }))
    )),
  )),
  fixture(definition("sign-up-funnel"), {
    title: "Sign-up funnel",
    stageColumn: "stage",
    valueColumn: "users",
    summary: { column: "users", aggregate: "first", label: "Sign-up funnel", format: compactNumber },
    conversion: { column: "conversion", aggregate: "last", label: "Converted", format: percent },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "Last 7 days",
    valueFormat: compactNumber,
  }, dataset([["stage", "Stage", "string"], ["users", "Users", "number"], ["conversion", "Conversion", "number"], ["change", "Change", "number"]], [
    { stage: "Link opened", users: 197, conversion: 1, change: 0.052 }, { stage: "Started", users: 110, conversion: 0.56, change: 0.052 },
    { stage: "Completed", users: 77, conversion: 0.39, change: 0.052 }, { stage: "Converted", users: 38, conversion: 0.19, change: 0.052 },
  ])),
  fixture(definition("earned-so-far-bars"), {
    title: "Earned so far",
    periodColumn: "month",
    earnedColumn: "earned",
    targetColumn: "target",
    summary: { column: "headline", aggregate: "first", label: "Earned so far", format: currency },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    earnedFormat: currency,
  }, dataset([["month", "Month", "string"], ["earned", "Earned", "number"], ["target", "Target", "number"], ["headline", "Headline", "number"], ["change", "Change", "number"]],
    [3200, 7400, 9700, 7100, 3600, 2300, 3700, 5000, 6800, 4500, 11800, 8200].map((earned, index) => ({
      month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][index]!, earned, target: 12000, headline: 7462, change: 0.148,
    })),
  )),
  fixture(definition("contributions-heatmap"), {
    title: "Contributions this year",
    dateColumn: "date",
    valueColumn: "contributions",
    summary: { column: "headline", aggregate: "first", label: "Contributions this year", format: currency },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    highlights: [
      { column: "lifetimeTokens", aggregate: "first", label: "Lifetime tokens", format: compactNumber },
      { column: "peakTokens", aggregate: "first", label: "Peak tokens", format: compactNumber },
      { column: "longestTask", aggregate: "first", label: "Longest task", format: decimal },
      { column: "topStreak", aggregate: "first", label: "Top streak", format: integer },
    ],
    valueFormat: integer,
  }, dataset([
    ["date", "Date", "date"], ["contributions", "Contributions", "number"], ["headline", "Headline", "number"], ["change", "Change", "number"],
    ["lifetimeTokens", "Lifetime tokens", "number"], ["peakTokens", "Peak tokens", "number"], ["longestTask", "Longest task", "number"], ["topStreak", "Top streak", "number"],
  ], contributionDates.map((date, index) => ({
    date, contributions: (index * 7 + index % 13) % 12, headline: 7462, change: 0.148,
    lifetimeTokens: 9_000_000_000, peakTokens: 562_700_000, longestTask: 12.9, topStreak: 62,
  })))),
  fixture(definition("sessions-conversion-combo"), {
    title: "Sessions · Conversion 3.7%",
    timeColumn: "month",
    sessionsColumn: "sessions",
    conversionColumn: "conversion",
    sessionsSummary: { column: "headline", aggregate: "first", label: "Sessions", format: compactNumber },
    conversionSummary: { column: "conversion", aggregate: "average", label: "Conversion", format: percent },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "This year",
    sessionsFormat: compactNumber,
    conversionFormat: percent,
  }, dataset([["month", "Month", "date"], ["sessions", "Sessions", "number"], ["conversion", "Conversion", "number"], ["headline", "Headline", "number"], ["change", "Change", "number"]],
    [4000, 4500, 5200, 4900, 6000, 6800, 6500, 7400, 8000, 7700, 9000, 9200].map((sessions, index) => ({
      month: `2026-${String(index + 1).padStart(2, "0")}-01`, sessions,
      conversion: [0.024, 0.026, 0.032, 0.030, 0.035, 0.039, 0.037, 0.042, 0.045, 0.043, 0.051, 0.055][index]!,
      headline: 83200, change: 0.094,
    })),
  )),
  fixture(definition("devices-bars"), {
    title: "Devices",
    subtitle: "Visitor share",
    deviceColumn: "device",
    valueColumn: "visitors",
    summary: { column: "visitors", aggregate: "sum", label: "Visitors", format: percent },
    valueFormat: percent,
  }, dataset([["device", "Device", "string"], ["visitors", "Visitors", "number"]], [
    { device: "Desktop", visitors: 0.61 }, { device: "Mobile", visitors: 0.31 }, { device: "Tablet", visitors: 0.08 },
  ])),
  fixture(definition("visitors-stacked-area"), {
    title: "Visitors",
    timeColumn: "month",
    series: [
      { column: "organic", label: "Organic", format: compactNumber },
      { column: "referral", label: "Referral", format: compactNumber },
      { column: "paid", label: "Paid", format: compactNumber },
    ],
    summary: { column: "headline", aggregate: "first", label: "Visitors", format: compactNumber },
    change: { column: "change", aggregate: "maximum", label: "Change", format: percent },
    periodLabel: "This year",
  }, dataset([
    ["month", "Month", "date"], ["organic", "Organic", "number"], ["referral", "Referral", "number"], ["paid", "Paid", "number"],
    ["headline", "Headline", "number"], ["change", "Change", "number"],
  ], [2500, 2800, 3200, 3000, 3700, 4200, 4600, 4400, 5100, 5600, 5400, 5900].map((organic, index) => ({
    month: `2026-${String(index + 1).padStart(2, "0")}-01`, organic,
    referral: [1400, 1550, 1450, 1650, 1900, 2050, 2150, 2300, 2450, 2700, 2900, 3450][index]!,
    paid: [600, 650, 800, 700, 950, 1100, 1200, 1250, 1500, 1650, 1800, 2100][index]!,
    headline: 94700, change: 0.082,
  })))),
  fixture(definition("activity-rings"), {
    title: "Activity",
    activityColumn: "activity",
    valueColumn: "value",
    targetColumn: "target",
    detailColumn: "detail",
    valueFormat: decimal,
  }, dataset([["activity", "Activity", "string"], ["value", "Value", "number"], ["target", "Target", "number"], ["detail", "Detail", "string"]], [
    { activity: "Move", value: 1592, target: 1800, detail: "1,592 kcal" },
    { activity: "Exercise", value: 105, target: 120, detail: "1h 45m" },
    { activity: "Running", value: 5.2, target: 6.5, detail: "5.2 km" },
  ])),
];

export const officialChartSpecFixtures = deepFreeze(fixtures);

export const officialRendererExpectationFixtures = deepFreeze(officialChartRecipeDefinitions.map((recipe) => {
  const fixtureValue = officialChartSpecFixtures.find((candidate) => candidate.recipeName === recipe.recipeName)!;
  const hasMetric = Object.keys(fixtureValue.spec).some((key) => key === "summary" || key.endsWith("Summary") || key === "score");
  return rendererExpectationFixtureSchema.parse({
    fixtureId: `renderer-expectation.${recipe.recipeName}`,
    recipeName: recipe.recipeName,
    rendererKind: recipe.rendererKind,
    semanticElements: ["equivalent-view", ...(hasMetric ? ["metric" as const] : []), "plot", "title", "tooltip"].sort(),
    requiredCapabilities: recipe.requiredCapabilities,
    stableSize: true,
  });
}));

export const officialChartAccessibilityFixtures = deepFreeze(officialChartSpecFixtures.map((fixtureValue) => (
  chartAccessibilityFixtureSchema.parse({
    fixtureId: `accessibility.${fixtureValue.recipeName}`,
    recipeName: fixtureValue.recipeName,
    accessibleName: fixtureValue.spec.accessibility.label,
    equivalentView: "table",
    keyboardInteractions: ["navigate"],
    reducedMotion: "disable-animation",
    dataSemantics: "preserved-in-equivalent-view",
  })
)));

export const chartRecipeCoverageEntrySchema = z.object({
  recipeName: chartRecipeSchema,
  family: chartRecipeFamilySchema,
  rendererKind: chartRendererKindSchema,
  requiredCapabilities: z.array(chartCapabilityTokenSchema),
  chartSpecFixtureId: fixtureIdSchema,
  rendererExpectationFixtureId: fixtureIdSchema,
  accessibilityFixtureId: fixtureIdSchema,
}).strict();

const manifestShape = {
  source: chartRecipeSourceSchema,
  dataChartContract: contractRefSchema,
  contractSetHash: sha256HashSchema,
  recipes: z.array(chartRecipeCoverageEntrySchema).length(17),
  chartSpecFixtures: z.array(chartSpecFixtureSchema).length(17),
  rendererExpectations: z.array(rendererExpectationFixtureSchema).length(17),
  accessibilityFixtures: z.array(chartAccessibilityFixtureSchema).length(17),
} as const;

export const chartRecipeManifestDefinitionSchema = z.object(manifestShape).strict();
export const chartRecipeManifestSchema = z.object({ recipeManifestHash: sha256HashSchema, ...manifestShape }).strict();
export type ChartRecipeCoverageEntry = z.infer<typeof chartRecipeCoverageEntrySchema>;
export type ChartRecipeManifestDefinition = z.infer<typeof chartRecipeManifestDefinitionSchema>;
export type ChartRecipeManifest = z.infer<typeof chartRecipeManifestSchema>;

export async function createOfficialChartRecipeManifest(catalog: OfficialCatalogBundle, provider?: HashProvider): Promise<ChartRecipeManifest> {
  const recipes = chartRecipeDefinitionsSchema.parse(officialChartRecipeDefinitions).map((recipe, index) => ({
    recipeName: recipe.recipeName,
    family: recipe.family,
    rendererKind: recipe.rendererKind,
    requiredCapabilities: recipe.requiredCapabilities,
    chartSpecFixtureId: officialChartSpecFixtures[index]!.fixtureId,
    rendererExpectationFixtureId: officialRendererExpectationFixtures[index]!.fixtureId,
    accessibilityFixtureId: officialChartAccessibilityFixtures[index]!.fixtureId,
  }));
  const definitionValue = chartRecipeManifestDefinitionSchema.parse({
    source: officialChartRecipeSource,
    dataChartContract: catalog.components.dataChart.ref,
    contractSetHash: catalog.manifest.contractSetHash,
    recipes,
    chartSpecFixtures: officialChartSpecFixtures,
    rendererExpectations: officialRendererExpectationFixtures,
    accessibilityFixtures: officialChartAccessibilityFixtures,
  });
  assertManifestCoverage(definitionValue);
  const recipeManifestHash = await hashNamespacedCanonical("open-generative.chart-recipe-manifest", definitionValue, provider);
  return deepFreeze(chartRecipeManifestSchema.parse({ recipeManifestHash, ...definitionValue }));
}

export async function verifyChartRecipeManifest(input: unknown, provider?: HashProvider): Promise<ChartRecipeManifest> {
  const manifest = chartRecipeManifestSchema.parse(input);
  const { recipeManifestHash, ...definitionValue } = manifest;
  assertManifestCoverage(definitionValue);
  const expected = await hashNamespacedCanonical("open-generative.chart-recipe-manifest", definitionValue, provider);
  if (recipeManifestHash !== expected) throw new Error("Chart recipe manifest hash mismatch.");
  return deepFreeze(manifest);
}

function assertManifestCoverage(value: ChartRecipeManifestDefinition): void {
  const names = value.recipes.map((recipe) => recipe.recipeName);
  if (new Set(names).size !== 17 || names.some((name, index) => name !== officialChartRecipeDefinitions[index]?.recipeName)) {
    throw new Error("Chart recipe manifest must cover the exact canonical recipe set.");
  }
  const specFixtures = new Map(value.chartSpecFixtures.map((fixtureValue) => [fixtureValue.fixtureId, fixtureValue.recipeName]));
  const rendererFixtures = new Map(value.rendererExpectations.map((fixtureValue) => [fixtureValue.fixtureId, fixtureValue.recipeName]));
  const accessibilityFixtures = new Map(value.accessibilityFixtures.map((fixtureValue) => [fixtureValue.fixtureId, fixtureValue.recipeName]));
  for (const recipe of value.recipes) {
    if (specFixtures.get(recipe.chartSpecFixtureId) !== recipe.recipeName
      || rendererFixtures.get(recipe.rendererExpectationFixtureId) !== recipe.recipeName
      || accessibilityFixtures.get(recipe.accessibilityFixtureId) !== recipe.recipeName) {
      throw new Error(`Incomplete fixture coverage for ${recipe.recipeName}.`);
    }
  }
}
