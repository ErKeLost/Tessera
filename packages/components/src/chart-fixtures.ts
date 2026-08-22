import {
  contractRefSchema,
  sha256HashSchema,
  type HashProvider,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  chartSpecSchema,
  type ChartFamily,
} from "./chart-spec";
import {
  chartCapabilityTokenSchema,
  chartRecipeDefinitionSchema,
  chartRecipeFamilySchema,
  chartRecipeSourceSchema,
  officialChartRecipeDefinitions,
  officialChartRecipeSource,
  type ChartRecipeDefinition,
} from "./chart-recipes";
import type { OfficialCatalogBundle } from "./contracts";
import { hashNamespacedCanonical } from "./integrity";
import { deepFreeze } from "./schema";

const fixtureIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{2,191}$/);

export const chartSpecFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeDefinitionSchema.shape.recipeName,
  recipeFamily: chartRecipeFamilySchema,
  spec: chartSpecSchema,
}).strict();

export const rendererExpectationFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeDefinitionSchema.shape.recipeName,
  semanticRoot: z.literal("chart"),
  chartFamily: z.enum(["area", "bar", "line", "pie", "radar", "radial"]),
  semanticElements: z.array(z.enum([
    "axis",
    "center-text",
    "equivalent-view",
    "grid",
    "labels",
    "legend",
    "series",
    "tooltip",
  ])).min(2).max(8),
  expectedEvents: z.array(z.enum(["legendToggle", "rangeChange", "select"])).max(3),
  requiredCapabilities: z.array(chartCapabilityTokenSchema),
  stableSize: z.literal(true),
}).strict();

export const chartAccessibilityFixtureSchema = z.object({
  fixtureId: fixtureIdSchema,
  recipeName: chartRecipeDefinitionSchema.shape.recipeName,
  accessibleName: z.string().trim().min(1).max(512),
  equivalentView: z.enum(["table", "text-summary"]),
  keyboardInteractions: z.array(z.enum(["navigate", "select"])).max(2),
  reducedMotion: z.literal("disable-animation"),
  dataSemantics: z.literal("preserved-in-equivalent-view"),
}).strict();

export type ChartSpecFixture = z.infer<typeof chartSpecFixtureSchema>;
export type RendererExpectationFixture = z.infer<typeof rendererExpectationFixtureSchema>;
export type ChartAccessibilityFixture = z.infer<typeof chartAccessibilityFixtureSchema>;

const resourceExpr = { kind: "resource-ref", bindingId: "fixture.chart.dataset" } as const;
const selectionState = { kind: "state-ref", stateId: "fixture.chart.selection" } as const;
const rangeState = { kind: "state-ref", stateId: "fixture.chart.range" } as const;
const legendState = { kind: "state-ref", stateId: "fixture.chart.legend" } as const;
const dateFormat = { kind: "date", dateStyle: "medium" } as const;
const numberWithUnit = { kind: "number", notation: "standard", maximumFractionDigits: 1, unit: "units" } as const;

function createChartSpecFixture(recipe: ChartRecipeDefinition): ChartSpecFixture {
  const capabilities = new Set(recipe.requiredCapabilities);
  const chartFamily: ChartFamily = recipe.family === "tooltip" ? "bar" : recipe.family;
  const multiple = capabilities.has("series.multiple");
  const series = [
    {
      column: "revenue",
      label: "Revenue",
      colorToken: "chart.1",
      ...(capabilities.has("series.icon") || capabilities.has("tooltip.icon") ? { iconToken: "activity" } : {}),
    },
    ...(multiple ? [{ column: "cost", label: "Cost", colorToken: "chart.2" as const }] : []),
  ];

  const common: Record<string, unknown> = {
    family: chartFamily,
    data: resourceExpr,
    title: recipe.recipeName,
    series,
    equivalentView: "table",
    accessibility: {
      label: `${recipe.recipeName} chart fixture`,
      description: "Equivalent data is available as a table.",
    },
  };

  if (capabilities.has("legend")) {
    common.legend = {
      visibility: "always",
      iconMode: capabilities.has("series.icon") ? "series-icon" : "swatch",
      visibilityState: legendState,
    };
  }

  if (capabilities.has("interaction.range-select")) {
    common.interaction = { kind: "range-select", state: rangeState, minimumPoints: 2 };
  } else if (capabilities.has("interaction.series-select")) {
    common.interaction = { kind: "series-select", state: selectionState };
  } else if (capabilities.has("interaction.slice-select")) {
    common.interaction = { kind: "slice-select", state: selectionState };
  }

  if (capabilities.has("label.custom")) {
    common.labels = { mode: "formatted", format: numberWithUnit, position: "auto", leaderLine: false };
  } else if (capabilities.has("label.list")) {
    common.labels = { mode: "list", position: "outside", leaderLine: true };
  } else if (capabilities.has("label.category")) {
    common.labels = { mode: "category", position: "outside", leaderLine: true };
  } else if (capabilities.has("label.value")) {
    common.labels = { mode: "value", position: "auto", leaderLine: true };
  }

  const tooltip = createTooltipFixture(recipe);
  if (tooltip !== undefined) common.tooltip = tooltip;

  if (chartFamily === "area") {
    Object.assign(common, {
      x: "month",
      axes: capabilities.has("axis.y")
        ? {
            x: { visible: true, scale: "time", label: "Month" },
            y: { visible: true, scale: "number", label: "Revenue" },
            grid: "horizontal",
          }
        : { x: { visible: true, scale: "time" }, grid: "horizontal" },
      curve: capabilities.has("curve.linear") ? "linear" : capabilities.has("curve.step") ? "step" : "natural",
      fill: capabilities.has("fill.gradient") ? "gradient" : "solid",
      activeMark: capabilities.has("mark.active"),
      ...(createStack(capabilities) === undefined ? {} : { stack: createStack(capabilities) }),
    });
  } else if (chartFamily === "bar") {
    Object.assign(common, {
      category: "month",
      orientation: capabilities.has("orientation.horizontal") ? "horizontal" : "vertical",
      axes: capabilities.has("orientation.horizontal")
        ? { x: { visible: true, scale: "number" }, y: { visible: true, scale: "category" }, grid: "vertical" }
        : { x: { visible: true, scale: "category" }, y: { visible: false, scale: "number" }, grid: "horizontal" },
      activeMark: capabilities.has("mark.active"),
      shape: capabilities.has("shape.custom") ? "active-rounded" : "default",
      colorMode: capabilities.has("color.per-datum") ? "per-datum" : capabilities.has("color.sign") ? "by-sign" : "series",
      allowNegative: capabilities.has("value.negative"),
      ...(createStack(capabilities) === undefined ? {} : { stack: createStack(capabilities) }),
    });
  } else if (chartFamily === "line") {
    Object.assign(common, {
      x: "month",
      axes: { x: { visible: true, scale: "time" }, grid: "horizontal" },
      curve: capabilities.has("curve.linear") ? "linear" : capabilities.has("curve.step") ? "step" : "monotone",
      points: capabilities.has("point.custom")
        ? "custom-symbol"
        : capabilities.has("point.series-color")
          ? "series-color"
          : capabilities.has("point.visible")
            ? "visible"
            : "hidden",
      activeMark: capabilities.has("mark.active"),
    });
  } else if (chartFamily === "pie") {
    Object.assign(common, {
      name: "channel",
      innerRadius: capabilities.has("pie.donut") ? "md" : "none",
      separator: capabilities.has("separator.none") ? "none" : "default",
      rings: capabilities.has("pie.rings.multiple") ? "stacked" : "single",
      activeMark: capabilities.has("mark.active"),
      shape: capabilities.has("shape.custom") ? "active-sector" : "default",
      ...(capabilities.has("center.text")
        ? { centerText: { value: selectionState, label: "Total", format: numberWithUnit } }
        : {}),
    });
  } else if (chartFamily === "radar") {
    Object.assign(common, {
      angle: "dimension",
      grid: radarGrid(recipe),
      points: capabilities.has("point.visible") ? "visible" : "hidden",
      fill: capabilities.has("fill.none") ? "none" : "area",
      ...(capabilities.has("axis.radius")
        ? { radiusAxis: { visible: true, domain: [0, 100] } }
        : {}),
    });
  } else {
    Object.assign(common, {
      name: "channel",
      domain: { min: 0, max: 100 },
      sweep: capabilities.has("radial.semicircle")
        ? "semicircle"
        : recipe.recipeName === "chart-radial-label"
          ? "extended-full"
          : capabilities.has("radial.partial")
            ? "partial"
            : "full",
      grid: capabilities.has("grid.ring") ? "ring" : capabilities.has("grid.circle") ? "circle" : "none",
      shape: capabilities.has("shape.custom") ? "custom" : "default",
      ...(createStack(capabilities) === undefined ? {} : { stack: createStack(capabilities) }),
      ...(capabilities.has("center.text")
        ? { centerText: { value: selectionState, label: "Total", format: numberWithUnit } }
        : {}),
    });
  }

  return chartSpecFixtureSchema.parse({
    fixtureId: `chart-spec.${recipe.recipeName}`,
    recipeName: recipe.recipeName,
    recipeFamily: recipe.family,
    spec: chartSpecSchema.parse(common),
  });
}

function createStack(capabilities: Set<string>) {
  if (capabilities.has("stack.normalized")) return { mode: "normalized" as const };
  if (capabilities.has("stack.normal")) return { mode: "normal" as const };
  return undefined;
}

function radarGrid(recipe: ChartRecipeDefinition) {
  const capabilities = new Set(recipe.requiredCapabilities);
  if (capabilities.has("grid.none")) return "none";
  if (capabilities.has("grid.custom-radius")) return "custom-radius-no-radial-lines";
  if (capabilities.has("grid.circle") && capabilities.has("grid.fill")) return "circle-filled";
  if (capabilities.has("grid.circle") && capabilities.has("grid.radial-lines.none")) return "circle-no-radial-lines";
  if (capabilities.has("grid.circle")) return "circle";
  if (capabilities.has("grid.fill")) return "polygon-filled";
  if (capabilities.has("grid.radial-lines.none")) return "polygon-no-radial-lines";
  return "polygon";
}

function createTooltipFixture(recipe: ChartRecipeDefinition): Record<string, unknown> | undefined {
  const capabilities = new Set(recipe.requiredCapabilities);
  const hasTooltipCapability = recipe.family === "tooltip"
    || recipe.requiredCapabilities.some((token) => token.startsWith("tooltip."));
  if (!hasTooltipCapability) return undefined;

  const tooltip: Record<string, unknown> = {
    enabled: true,
    indicator: capabilities.has("tooltip.indicator.none")
      ? "none"
      : capabilities.has("tooltip.indicator.line")
        ? "line"
        : "dot",
    label: capabilities.has("tooltip.label.none")
      ? { mode: "none" }
      : capabilities.has("tooltip.label.key")
        ? { mode: "column", column: "month" }
        : capabilities.has("tooltip.label.formatter")
          ? { mode: "formatted", column: "month", format: dateFormat }
          : { mode: "default" },
    seriesIcons: capabilities.has("tooltip.icon"),
    aggregate: capabilities.has("tooltip.aggregate") ? "total" : "none",
  };
  if (capabilities.has("tooltip.value.formatter") || capabilities.has("tooltip.value.advanced")) {
    tooltip.valueFormat = numberWithUnit;
  }
  return tooltip;
}

function createRendererExpectation(recipe: ChartRecipeDefinition, fixture: ChartSpecFixture): RendererExpectationFixture {
  const semanticElements = new Set<z.infer<typeof rendererExpectationFixtureSchema>["semanticElements"][number]>([
    "series",
    "equivalent-view",
  ]);
  if (["area", "bar", "line"].includes(fixture.spec.family)) semanticElements.add("axis");
  if (recipe.requiredCapabilities.some((token) => token.startsWith("grid."))) semanticElements.add("grid");
  if (recipe.requiredCapabilities.includes("legend")) semanticElements.add("legend");
  if (recipe.requiredCapabilities.some((token) => token.startsWith("label."))) semanticElements.add("labels");
  if (recipe.family === "tooltip" || recipe.requiredCapabilities.some((token) => token.startsWith("tooltip."))) semanticElements.add("tooltip");
  if (recipe.requiredCapabilities.includes("center.text")) semanticElements.add("center-text");

  const expectedEvents: Array<"legendToggle" | "rangeChange" | "select"> = [];
  if (recipe.requiredCapabilities.includes("legend")) expectedEvents.push("legendToggle");
  if (recipe.requiredCapabilities.includes("interaction.range-select")) expectedEvents.push("rangeChange");
  if (recipe.requiredCapabilities.some((token) => token === "interaction.series-select" || token === "interaction.slice-select")) {
    expectedEvents.push("select");
  }

  return rendererExpectationFixtureSchema.parse({
    fixtureId: `renderer-expectation.${recipe.recipeName}`,
    recipeName: recipe.recipeName,
    semanticRoot: "chart",
    chartFamily: fixture.spec.family,
    semanticElements: [...semanticElements].sort(),
    expectedEvents: expectedEvents.sort(),
    requiredCapabilities: recipe.requiredCapabilities,
    stableSize: true,
  });
}

function createAccessibilityFixture(recipe: ChartRecipeDefinition, fixture: ChartSpecFixture): ChartAccessibilityFixture {
  const interactive = recipe.requiredCapabilities.some((token) => token.startsWith("interaction."));
  return chartAccessibilityFixtureSchema.parse({
    fixtureId: `accessibility.${recipe.recipeName}`,
    recipeName: recipe.recipeName,
    accessibleName: fixture.spec.accessibility.label,
    equivalentView: fixture.spec.equivalentView,
    keyboardInteractions: interactive ? ["navigate", "select"] : ["navigate"],
    reducedMotion: "disable-animation",
    dataSemantics: "preserved-in-equivalent-view",
  });
}

export const officialChartSpecFixtures = deepFreeze(
  officialChartRecipeDefinitions.map(createChartSpecFixture),
);
export const officialRendererExpectationFixtures = deepFreeze(
  officialChartRecipeDefinitions.map((recipe, index) => createRendererExpectation(recipe, officialChartSpecFixtures[index]!)),
);
export const officialChartAccessibilityFixtures = deepFreeze(
  officialChartRecipeDefinitions.map((recipe, index) => createAccessibilityFixture(recipe, officialChartSpecFixtures[index]!)),
);

export const chartRecipeCoverageEntrySchema = z.object({
  recipeName: chartRecipeDefinitionSchema.shape.recipeName,
  family: chartRecipeFamilySchema,
  sourceFile: chartRecipeDefinitionSchema.shape.sourceFile,
  requiredCapabilities: z.array(chartCapabilityTokenSchema),
  chartSpecFixtureId: fixtureIdSchema,
  rendererExpectationFixtureId: fixtureIdSchema,
  accessibilityFixtureId: fixtureIdSchema,
}).strict();

const chartRecipeManifestContentShape = {
  source: chartRecipeSourceSchema,
  dataChartContract: contractRefSchema,
  contractSetHash: sha256HashSchema,
  recipes: z.array(chartRecipeCoverageEntrySchema).length(70),
  chartSpecFixtures: z.array(chartSpecFixtureSchema).length(70),
  rendererExpectations: z.array(rendererExpectationFixtureSchema).length(70),
  accessibilityFixtures: z.array(chartAccessibilityFixtureSchema).length(70),
} as const;

export const chartRecipeManifestDefinitionSchema = z.object(chartRecipeManifestContentShape).strict();
export const chartRecipeManifestSchema = z.object({
  recipeManifestHash: sha256HashSchema,
  ...chartRecipeManifestContentShape,
}).strict();

export type ChartRecipeCoverageEntry = z.infer<typeof chartRecipeCoverageEntrySchema>;
export type ChartRecipeManifestDefinition = z.infer<typeof chartRecipeManifestDefinitionSchema>;
export type ChartRecipeManifest = z.infer<typeof chartRecipeManifestSchema>;

export async function createOfficialChartRecipeManifest(
  catalog: OfficialCatalogBundle,
  provider?: HashProvider,
): Promise<ChartRecipeManifest> {
  const dataChartContract = catalog.components.dataChart.ref;
  if (dataChartContract.componentType !== "data.chart") {
    throw new TypeError("Chart recipe coverage requires the official data.chart contract.");
  }

  const recipes = officialChartRecipeDefinitions.map((recipe, index) => ({
    recipeName: recipe.recipeName,
    family: recipe.family,
    sourceFile: recipe.sourceFile,
    requiredCapabilities: recipe.requiredCapabilities,
    chartSpecFixtureId: officialChartSpecFixtures[index]!.fixtureId,
    rendererExpectationFixtureId: officialRendererExpectationFixtures[index]!.fixtureId,
    accessibilityFixtureId: officialChartAccessibilityFixtures[index]!.fixtureId,
  }));
  const definition = chartRecipeManifestDefinitionSchema.parse({
    source: officialChartRecipeSource,
    dataChartContract,
    contractSetHash: catalog.manifest.contractSetHash,
    recipes,
    chartSpecFixtures: officialChartSpecFixtures,
    rendererExpectations: officialRendererExpectationFixtures,
    accessibilityFixtures: officialChartAccessibilityFixtures,
  });
  assertManifestCoverage(definition);
  const recipeManifestHash = await hashNamespacedCanonical(
    "open-generative.chart-recipe-manifest",
    definition,
    provider,
  );
  return deepFreeze(chartRecipeManifestSchema.parse({ recipeManifestHash, ...definition }));
}

export async function verifyChartRecipeManifest(
  input: unknown,
  provider?: HashProvider,
): Promise<ChartRecipeManifest> {
  const manifest = chartRecipeManifestSchema.parse(input);
  const { recipeManifestHash, ...definition } = manifest;
  assertManifestCoverage(definition);
  const expected = await hashNamespacedCanonical("open-generative.chart-recipe-manifest", definition, provider);
  if (recipeManifestHash !== expected) throw new Error("Chart recipe manifest hash mismatch.");
  return deepFreeze(manifest);
}

function assertManifestCoverage(definition: ChartRecipeManifestDefinition): void {
  const fixtures = new Map(definition.chartSpecFixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const expectations = new Map(definition.rendererExpectations.map((fixture) => [fixture.fixtureId, fixture]));
  const accessibility = new Map(definition.accessibilityFixtures.map((fixture) => [fixture.fixtureId, fixture]));
  if (fixtures.size !== 70 || expectations.size !== 70 || accessibility.size !== 70) {
    throw new Error("Chart coverage fixtures must be unique and complete.");
  }
  for (const recipe of definition.recipes) {
    if (fixtures.get(recipe.chartSpecFixtureId)?.recipeName !== recipe.recipeName) {
      throw new Error(`ChartSpec fixture mismatch for ${recipe.recipeName}.`);
    }
    if (expectations.get(recipe.rendererExpectationFixtureId)?.recipeName !== recipe.recipeName) {
      throw new Error(`Renderer expectation fixture mismatch for ${recipe.recipeName}.`);
    }
    if (accessibility.get(recipe.accessibilityFixtureId)?.recipeName !== recipe.recipeName) {
      throw new Error(`Accessibility fixture mismatch for ${recipe.recipeName}.`);
    }
  }
}
