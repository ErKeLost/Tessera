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
    subtitle: "Account performance",
    accountColumn: "account",
    revenueColumn: "revenue",
    comparisonColumn: "users",
    sizeColumn: "opportunities",
    summary: { column: "revenue", aggregate: "average", label: "Average revenue", format: currency },
    revenueFormat: currency,
    comparisonFormat: integer,
  }, dataset([
    ["account", "Account", "string"], ["revenue", "Revenue", "number"], ["users", "Users", "number"], ["opportunities", "Opportunities", "number"],
  ], [
    { account: "Acme", revenue: 78_000, users: 42, opportunities: 12 }, { account: "Northstar", revenue: 112_000, users: 64, opportunities: 18 },
    { account: "Orbit", revenue: 57_000, users: 71, opportunities: 8 }, { account: "Vertex", revenue: 142_000, users: 95, opportunities: 24 },
    { account: "Harbor", revenue: 91_000, users: 128, opportunities: 15 }, { account: "Lumen", revenue: 169_000, users: 154, opportunities: 27 },
  ])),
  fixture(definition("tracked-time-sankey"), {
    title: "Tracked time",
    subtitle: "Where the week went",
    sourceColumn: "source",
    targetColumn: "target",
    valueColumn: "hours",
    summary: { column: "hours", aggregate: "sum", label: "Tracked", format: hours },
    valueFormat: hours,
  }, dataset([["source", "Source", "string"], ["target", "Target", "string"], ["hours", "Hours", "number"]], [
    { source: "Product", target: "Design", hours: 13.5 }, { source: "Product", target: "Research", hours: 8.5 },
    { source: "Engineering", target: "Frontend", hours: 15 }, { source: "Engineering", target: "Backend", hours: 12 },
    { source: "Operations", target: "Planning", hours: 6 }, { source: "Operations", target: "Meetings", hours: 9 },
  ])),
  fixture(definition("visitors-radial"), {
    title: "Visitors",
    subtitle: "Traffic by source",
    categoryColumn: "source",
    valueColumn: "visitors",
    summary: { column: "visitors", aggregate: "sum", label: "Total visitors", format: compactNumber },
    valueFormat: compactNumber,
  }, dataset([["source", "Source", "string"], ["visitors", "Visitors", "number"]], [
    { source: "Organic", visitors: 2_480 }, { source: "Direct", visitors: 1_820 },
    { source: "Referral", visitors: 1_160 }, { source: "Social", visitors: 740 },
  ])),
  fixture(definition("visitors-radar"), {
    title: "Visitors",
    subtitle: "Weekly audience profile",
    dimensionColumn: "day",
    valueColumn: "current",
    comparisonColumn: "previous",
    summary: { column: "current", aggregate: "sum", label: "This week", format: compactNumber },
    valueFormat: compactNumber,
  }, dataset([["day", "Day", "string"], ["current", "Current", "number"], ["previous", "Previous", "number"]], [
    { day: "Mon", current: 860, previous: 720 }, { day: "Tue", current: 940, previous: 810 },
    { day: "Wed", current: 1_120, previous: 980 }, { day: "Thu", current: 1_080, previous: 1_010 },
    { day: "Fri", current: 1_260, previous: 1_090 }, { day: "Sat", current: 1_540, previous: 1_320 },
    { day: "Sun", current: 1_430, previous: 1_250 },
  ])),
  fixture(definition("activity-calendar"), {
    title: "Activity",
    subtitle: "Last five weeks",
    dateColumn: "date",
    valueColumn: "sessions",
    summary: { column: "sessions", aggregate: "sum", label: "Sessions", format: integer },
    valueFormat: integer,
  }, dataset([["date", "Date", "date"], ["sessions", "Sessions", "number"]], calendarDates.map((date, index) => ({ date, sessions: calendarValues[index]! })))),
  fixture(definition("revenue-smooth-area"), {
    title: "Revenue",
    subtitle: "Trailing 12 months",
    timeColumn: "month",
    revenueColumn: "revenue",
    summary: { column: "revenue", aggregate: "sum", label: "Revenue", format: currency },
    revenueFormat: currency,
  }, dataset([["month", "Month", "date"], ["revenue", "Revenue", "number"]], [
    { month: "2025-09-01", revenue: 41_000 }, { month: "2025-10-01", revenue: 48_000 }, { month: "2025-11-01", revenue: 45_000 },
    { month: "2025-12-01", revenue: 57_000 }, { month: "2026-01-01", revenue: 62_000 }, { month: "2026-02-01", revenue: 59_000 },
    { month: "2026-03-01", revenue: 71_000 }, { month: "2026-04-01", revenue: 76_000 }, { month: "2026-05-01", revenue: 73_000 },
    { month: "2026-06-01", revenue: 84_000 }, { month: "2026-07-01", revenue: 92_000 }, { month: "2026-08-01", revenue: 101_000 },
  ])),
  fixture(definition("active-users-heatmap"), {
    title: "Active users",
    subtitle: "By weekday and time",
    dayColumn: "day",
    timeBucketColumn: "hour",
    valueColumn: "users",
    summary: { column: "users", aggregate: "maximum", label: "Peak users", format: integer },
    valueFormat: integer,
  }, dataset([["day", "Day", "string"], ["hour", "Hour", "string"], ["users", "Users", "number"]],
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].flatMap((day, dayIndex) => (
      ["00", "04", "08", "12", "16", "20"].map((hour, hourIndex) => ({ day, hour, users: 12 + ((dayIndex * 11 + hourIndex * 17) % 88) }))
    )),
  )),
  fixture(definition("sign-up-funnel"), {
    title: "Sign-up funnel",
    subtitle: "Last 30 days",
    stageColumn: "stage",
    valueColumn: "users",
    summary: { column: "users", aggregate: "first", label: "Started", format: compactNumber },
    conversion: { column: "conversion", aggregate: "last", label: "Completed", format: percent },
    valueFormat: compactNumber,
  }, dataset([["stage", "Stage", "string"], ["users", "Users", "number"], ["conversion", "Conversion", "number"]], [
    { stage: "Visited", users: 12_480, conversion: 1 }, { stage: "Started", users: 8_320, conversion: 0.667 },
    { stage: "Verified", users: 5_840, conversion: 0.468 }, { stage: "Completed", users: 4_260, conversion: 0.341 },
  ])),
  fixture(definition("earned-so-far-bars"), {
    title: "Earned so far",
    subtitle: "Monthly goal progress",
    periodColumn: "month",
    earnedColumn: "earned",
    targetColumn: "target",
    summary: { column: "earned", aggregate: "sum", label: "Earned", format: currency },
    earnedFormat: currency,
  }, dataset([["month", "Month", "string"], ["earned", "Earned", "number"], ["target", "Target", "number"]], [
    { month: "Mar", earned: 18_200, target: 25_000 }, { month: "Apr", earned: 23_800, target: 25_000 },
    { month: "May", earned: 21_400, target: 25_000 }, { month: "Jun", earned: 27_600, target: 25_000 },
    { month: "Jul", earned: 29_100, target: 25_000 }, { month: "Aug", earned: 24_700, target: 25_000 },
  ])),
  fixture(definition("contributions-heatmap"), {
    title: "Contributions",
    subtitle: "Past five weeks",
    dateColumn: "date",
    valueColumn: "contributions",
    summary: { column: "contributions", aggregate: "sum", label: "Contributions", format: integer },
    valueFormat: integer,
  }, dataset([["date", "Date", "date"], ["contributions", "Contributions", "number"]], calendarDates.map((date, index) => ({ date, contributions: calendarValues[(index * 3) % calendarValues.length]! })))),
  fixture(definition("sessions-conversion-combo"), {
    title: "Sessions & conversion",
    subtitle: "Traffic quality",
    timeColumn: "month",
    sessionsColumn: "sessions",
    conversionColumn: "conversion",
    sessionsSummary: { column: "sessions", aggregate: "sum", label: "Sessions", format: compactNumber },
    conversionSummary: { column: "conversion", aggregate: "average", label: "Conversion", format: percent },
    sessionsFormat: compactNumber,
    conversionFormat: percent,
  }, dataset([["month", "Month", "date"], ["sessions", "Sessions", "number"], ["conversion", "Conversion", "number"]], [
    { month: "2026-03-01", sessions: 8_400, conversion: 0.031 }, { month: "2026-04-01", sessions: 9_100, conversion: 0.034 },
    { month: "2026-05-01", sessions: 10_300, conversion: 0.032 }, { month: "2026-06-01", sessions: 11_800, conversion: 0.038 },
    { month: "2026-07-01", sessions: 12_600, conversion: 0.041 }, { month: "2026-08-01", sessions: 13_900, conversion: 0.044 },
  ])),
  fixture(definition("devices-bars"), {
    title: "Devices",
    subtitle: "Visitor share",
    deviceColumn: "device",
    valueColumn: "visitors",
    summary: { column: "visitors", aggregate: "sum", label: "Visitors", format: compactNumber },
    valueFormat: compactNumber,
  }, dataset([["device", "Device", "string"], ["visitors", "Visitors", "number"]], [
    { device: "Desktop", visitors: 4_820 }, { device: "Mobile", visitors: 3_740 }, { device: "Tablet", visitors: 1_160 },
  ])),
  fixture(definition("visitors-stacked-area"), {
    title: "Visitors",
    subtitle: "Audience by device",
    timeColumn: "month",
    series: [
      { column: "desktop", label: "Desktop", format: compactNumber },
      { column: "mobile", label: "Mobile", format: compactNumber },
      { column: "tablet", label: "Tablet", format: compactNumber },
    ],
    summary: { column: "total", aggregate: "sum", label: "Visitors", format: compactNumber },
  }, dataset([
    ["month", "Month", "date"], ["desktop", "Desktop", "number"], ["mobile", "Mobile", "number"], ["tablet", "Tablet", "number"], ["total", "Total", "number"],
  ], [
    { month: "2026-03-01", desktop: 3_800, mobile: 2_900, tablet: 840, total: 7_540 },
    { month: "2026-04-01", desktop: 4_200, mobile: 3_100, tablet: 910, total: 8_210 },
    { month: "2026-05-01", desktop: 4_450, mobile: 3_480, tablet: 980, total: 8_910 },
    { month: "2026-06-01", desktop: 4_720, mobile: 3_820, tablet: 1_040, total: 9_580 },
    { month: "2026-07-01", desktop: 5_080, mobile: 4_160, tablet: 1_120, total: 10_360 },
    { month: "2026-08-01", desktop: 5_420, mobile: 4_530, tablet: 1_260, total: 11_210 },
  ])),
  fixture(definition("activity-rings"), {
    title: "Activity",
    subtitle: "Today",
    activityColumn: "activity",
    valueColumn: "value",
    targetColumn: "target",
    valueFormat: integer,
  }, dataset([["activity", "Activity", "string"], ["value", "Value", "number"], ["target", "Target", "number"]], [
    { activity: "Move", value: 540, target: 600 }, { activity: "Exercise", value: 36, target: 45 }, { activity: "Stand", value: 10, target: 12 },
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
