import { z } from "zod";
import { chartRecipeSchema, chartRecipes, type ChartRecipe } from "./chart-spec";
import { deepFreeze } from "./schema";

export const chartRecipeFamilies = [
  "bars",
  "score",
  "scatter",
  "flow",
  "radial",
  "radar",
  "calendar",
  "area",
  "heatmap",
  "funnel",
  "combo",
  "rings",
] as const;
export const chartRecipeFamilySchema = z.enum(chartRecipeFamilies);

export const chartRendererKinds = ["dom", "svg", "recharts"] as const;
export const chartRendererKindSchema = z.enum(chartRendererKinds);

export const chartCapabilityTokens = [
  "accessibility.equivalent-table",
  "aggregate.dataset-column",
  "chart.area",
  "chart.bars",
  "chart.calendar",
  "chart.combo",
  "chart.funnel",
  "chart.heatmap",
  "chart.radar",
  "chart.radial",
  "chart.rings",
  "chart.sankey",
  "chart.scatter",
  "comparison.target",
  "series.multiple",
  "series.stacked",
  "tooltip.semantic",
] as const;
export const chartCapabilityTokenSchema = z.enum(chartCapabilityTokens);

export const chartRecipeDefinitionSchema = z.object({
  recipeName: chartRecipeSchema,
  family: chartRecipeFamilySchema,
  rendererKind: chartRendererKindSchema,
  requiredCapabilities: z.array(chartCapabilityTokenSchema).min(3).max(chartCapabilityTokens.length),
}).strict().superRefine((recipe, context) => {
  if (new Set(recipe.requiredCapabilities).size !== recipe.requiredCapabilities.length) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Capabilities must be unique." });
  }
  const sorted = [...recipe.requiredCapabilities].sort();
  if (sorted.some((token, index) => token !== recipe.requiredCapabilities[index])) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Capabilities must use canonical ordering." });
  }
});

export type ChartRecipeFamily = z.infer<typeof chartRecipeFamilySchema>;
export type ChartRendererKind = z.infer<typeof chartRendererKindSchema>;
export type ChartCapabilityToken = z.infer<typeof chartCapabilityTokenSchema>;
export type ChartRecipeDefinition = z.infer<typeof chartRecipeDefinitionSchema>;

function recipe(
  recipeName: ChartRecipe,
  family: ChartRecipeFamily,
  rendererKind: ChartRendererKind,
  capabilities: ChartCapabilityToken[],
  usesAggregate = true,
): ChartRecipeDefinition {
  return chartRecipeDefinitionSchema.parse({
    recipeName,
    family,
    rendererKind,
    requiredCapabilities: [
      "accessibility.equivalent-table",
      ...(usesAggregate ? ["aggregate.dataset-column" as const] : []),
      "tooltip.semantic",
      ...capabilities,
    ].sort(),
  });
}

const definitions = [
  recipe("steps-bars", "bars", "dom", ["chart.bars", "comparison.target"], false),
  recipe("pipeline-stage-bars", "bars", "dom", ["chart.bars"]),
  recipe("sleep-score", "score", "recharts", ["chart.radial"]),
  recipe("revenue-per-account-scatter", "scatter", "recharts", ["chart.scatter"]),
  recipe("tracked-time-sankey", "flow", "svg", ["chart.sankey"]),
  recipe("visitors-radial", "radial", "svg", ["chart.radial"]),
  recipe("visitors-radar", "radar", "recharts", ["chart.radar"]),
  recipe("activity-calendar", "calendar", "dom", ["chart.calendar"]),
  recipe("revenue-smooth-area", "area", "recharts", ["chart.area"]),
  recipe("active-users-heatmap", "heatmap", "dom", ["chart.heatmap"]),
  recipe("sign-up-funnel", "funnel", "svg", ["chart.funnel"]),
  recipe("earned-so-far-bars", "bars", "recharts", ["chart.bars", "comparison.target"]),
  recipe("contributions-heatmap", "heatmap", "dom", ["chart.heatmap"]),
  recipe("sessions-conversion-combo", "combo", "recharts", ["chart.combo", "series.multiple"]),
  recipe("devices-bars", "bars", "dom", ["chart.bars"]),
  recipe("visitors-stacked-area", "area", "recharts", ["chart.area", "series.multiple", "series.stacked"]),
  recipe("activity-rings", "rings", "svg", ["chart.rings", "comparison.target"]),
] as const;

export const chartRecipeDefinitionsSchema = z.array(chartRecipeDefinitionSchema).length(chartRecipes.length).superRefine((recipes, context) => {
  const names = recipes.map((entry) => entry.recipeName);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "Every chart recipe must be declared exactly once." });
  }
  if (names.some((name, index) => name !== chartRecipes[index])) {
    context.addIssue({ code: "custom", message: "Chart recipes must use canonical order." });
  }
});

export const officialChartRecipeDefinitions = deepFreeze(chartRecipeDefinitionsSchema.parse(definitions));

export function verifyChartRecipeDefinitions(input: unknown): readonly ChartRecipeDefinition[] {
  return deepFreeze(chartRecipeDefinitionsSchema.parse(input));
}

export const chartRecipeSourceSchema = z.object({
  sourceKind: z.literal("reference-design-set"),
  designSystem: z.literal("shadcn/ui"),
  recipeCount: z.literal(17),
  rendererPackages: z.object({
    chartEngine: z.object({
      packageName: z.literal("recharts"),
      version: z.literal("3.10.1"),
      integrity: z.string().min(1),
      integritySource: z.literal("workspace-lockfile"),
    }).strict(),
  }).strict(),
}).strict();

export const officialChartRecipeSource = deepFreeze(chartRecipeSourceSchema.parse({
  sourceKind: "reference-design-set",
  designSystem: "shadcn/ui",
  recipeCount: 17,
  rendererPackages: {
    chartEngine: {
      packageName: "recharts",
      version: "3.10.1",
      integrity: "sha512-QXFrvt6IVcw7eeZCoyXTwkIJAX3Dv1nyVhMicXJ47GsGDDpcN8z6o644DibE9XjpBTThtsomLKnTV6lc+cVFUA==",
      integritySource: "workspace-lockfile",
    },
  },
}));

export type ChartRecipeSource = z.infer<typeof chartRecipeSourceSchema>;
