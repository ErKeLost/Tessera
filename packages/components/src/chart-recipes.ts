import { z } from "zod";
import { deepFreeze } from "./schema";

export const chartRecipeFamilies = ["area", "bar", "line", "pie", "radar", "radial", "tooltip"] as const;
export const chartRecipeFamilySchema = z.enum(chartRecipeFamilies);

export const chartCapabilityTokens = [
  "axis.category",
  "axis.radius",
  "axis.y",
  "center.text",
  "color.per-datum",
  "color.sign",
  "curve.linear",
  "curve.step",
  "fill.gradient",
  "fill.none",
  "grid.circle",
  "grid.custom-radius",
  "grid.fill",
  "grid.none",
  "grid.radial-lines.none",
  "grid.ring",
  "interaction.range-select",
  "interaction.series-select",
  "interaction.slice-select",
  "label.category",
  "label.custom",
  "label.list",
  "label.value",
  "legend",
  "mark.active",
  "orientation.horizontal",
  "pie.donut",
  "pie.rings.multiple",
  "point.custom",
  "point.series-color",
  "point.visible",
  "radial.partial",
  "radial.semicircle",
  "separator.none",
  "series.icon",
  "series.multiple",
  "shape.custom",
  "stack.normal",
  "stack.normalized",
  "tooltip.aggregate",
  "tooltip.default",
  "tooltip.icon",
  "tooltip.indicator.dashed",
  "tooltip.indicator.line",
  "tooltip.indicator.none",
  "tooltip.label.formatter",
  "tooltip.label.key",
  "tooltip.label.none",
  "tooltip.value.advanced",
  "tooltip.value.formatter",
  "value.negative",
] as const;
export const chartCapabilityTokenSchema = z.enum(chartCapabilityTokens);

export const chartRecipeDefinitionSchema = z.object({
  recipeName: z.string().regex(/^chart-(?:area|bar|line|pie|radar|radial|tooltip)-[a-z0-9-]+$/),
  family: chartRecipeFamilySchema,
  sourceFile: z.string().regex(/^charts\/chart-[a-z0-9-]+\.tsx$/),
  requiredCapabilities: z.array(chartCapabilityTokenSchema).max(chartCapabilityTokens.length),
}).strict().superRefine((recipe, context) => {
  if (recipe.sourceFile !== `charts/${recipe.recipeName}.tsx`) {
    context.addIssue({ code: "custom", path: ["sourceFile"], message: "Source file must be derived from the recipe name." });
  }
  if (new Set(recipe.requiredCapabilities).size !== recipe.requiredCapabilities.length) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Capabilities must be unique." });
  }
  const sorted = [...recipe.requiredCapabilities].sort();
  if (sorted.some((token, index) => token !== recipe.requiredCapabilities[index])) {
    context.addIssue({ code: "custom", path: ["requiredCapabilities"], message: "Capabilities must use canonical ordering." });
  }
});

export type ChartRecipeFamily = z.infer<typeof chartRecipeFamilySchema>;
export type ChartCapabilityToken = z.infer<typeof chartCapabilityTokenSchema>;
export type ChartRecipeDefinition = z.infer<typeof chartRecipeDefinitionSchema>;

function recipe(
  family: ChartRecipeFamily,
  recipeName: string,
  requiredCapabilities: ChartCapabilityToken[] = [],
): ChartRecipeDefinition {
  return chartRecipeDefinitionSchema.parse({
    recipeName,
    family,
    sourceFile: `charts/${recipeName}.tsx`,
    requiredCapabilities: [...requiredCapabilities].sort(),
  });
}

const definitions = [
  recipe("area", "chart-area-axes", ["axis.y"]),
  recipe("area", "chart-area-default"),
  recipe("area", "chart-area-gradient", ["fill.gradient"]),
  recipe("area", "chart-area-icons", ["series.multiple", "series.icon", "stack.normal", "legend"]),
  recipe("area", "chart-area-interactive", ["fill.gradient", "series.multiple", "legend", "interaction.range-select", "tooltip.label.formatter"]),
  recipe("area", "chart-area-legend", ["series.multiple", "stack.normal", "legend"]),
  recipe("area", "chart-area-linear", ["curve.linear"]),
  recipe("area", "chart-area-stacked-expand", ["series.multiple", "stack.normalized"]),
  recipe("area", "chart-area-stacked", ["series.multiple", "stack.normal"]),
  recipe("area", "chart-area-step", ["curve.step"]),

  recipe("bar", "chart-bar-active", ["mark.active", "shape.custom"]),
  recipe("bar", "chart-bar-default"),
  recipe("bar", "chart-bar-horizontal", ["orientation.horizontal"]),
  recipe("bar", "chart-bar-interactive", ["interaction.series-select", "tooltip.label.formatter"]),
  recipe("bar", "chart-bar-label-custom", ["label.custom"]),
  recipe("bar", "chart-bar-label", ["label.value"]),
  recipe("bar", "chart-bar-mixed", ["orientation.horizontal", "color.per-datum", "axis.category"]),
  recipe("bar", "chart-bar-multiple", ["series.multiple"]),
  recipe("bar", "chart-bar-negative", ["value.negative", "color.sign", "label.category"]),
  recipe("bar", "chart-bar-stacked", ["series.multiple", "stack.normal", "legend"]),

  recipe("line", "chart-line-default"),
  recipe("line", "chart-line-dots-colors", ["series.multiple", "point.visible", "point.series-color"]),
  recipe("line", "chart-line-dots-custom", ["point.custom"]),
  recipe("line", "chart-line-dots", ["point.visible"]),
  recipe("line", "chart-line-interactive", ["interaction.series-select", "tooltip.label.formatter"]),
  recipe("line", "chart-line-label-custom", ["label.custom"]),
  recipe("line", "chart-line-label", ["label.value"]),
  recipe("line", "chart-line-linear", ["curve.linear"]),
  recipe("line", "chart-line-multiple", ["series.multiple"]),
  recipe("line", "chart-line-step", ["curve.step"]),

  recipe("pie", "chart-pie-donut-active", ["pie.donut", "mark.active", "shape.custom"]),
  recipe("pie", "chart-pie-donut-text", ["pie.donut", "center.text"]),
  recipe("pie", "chart-pie-donut", ["pie.donut"]),
  recipe("pie", "chart-pie-interactive", ["pie.donut", "mark.active", "interaction.slice-select", "center.text"]),
  recipe("pie", "chart-pie-label-custom", ["label.custom"]),
  recipe("pie", "chart-pie-label-list", ["label.list"]),
  recipe("pie", "chart-pie-label", ["label.value"]),
  recipe("pie", "chart-pie-legend", ["legend"]),
  recipe("pie", "chart-pie-separator-none", ["separator.none"]),
  recipe("pie", "chart-pie-simple"),
  recipe("pie", "chart-pie-stacked", ["pie.rings.multiple", "series.multiple", "tooltip.label.formatter"]),

  recipe("radar", "chart-radar-default"),
  recipe("radar", "chart-radar-dots", ["point.visible"]),
  recipe("radar", "chart-radar-grid-circle-fill", ["grid.circle", "grid.fill"]),
  recipe("radar", "chart-radar-grid-circle-no-lines", ["grid.circle", "grid.radial-lines.none", "point.visible"]),
  recipe("radar", "chart-radar-grid-circle", ["grid.circle", "point.visible"]),
  recipe("radar", "chart-radar-grid-custom", ["grid.custom-radius", "grid.radial-lines.none"]),
  recipe("radar", "chart-radar-grid-fill", ["grid.fill"]),
  recipe("radar", "chart-radar-grid-none", ["grid.none", "point.visible"]),
  recipe("radar", "chart-radar-icons", ["series.multiple", "series.icon", "legend"]),
  recipe("radar", "chart-radar-label-custom", ["label.custom"]),
  recipe("radar", "chart-radar-legend", ["series.multiple", "legend"]),
  recipe("radar", "chart-radar-lines-only", ["series.multiple", "fill.none", "grid.radial-lines.none"]),
  recipe("radar", "chart-radar-multiple", ["series.multiple"]),
  recipe("radar", "chart-radar-radius", ["series.multiple", "axis.radius"]),

  recipe("radial", "chart-radial-grid", ["grid.circle"]),
  recipe("radial", "chart-radial-label", ["label.list"]),
  recipe("radial", "chart-radial-shape", ["radial.partial", "shape.custom", "grid.ring", "center.text"]),
  recipe("radial", "chart-radial-simple"),
  recipe("radial", "chart-radial-stacked", ["radial.semicircle", "series.multiple", "stack.normal", "center.text"]),
  recipe("radial", "chart-radial-text", ["radial.partial", "grid.ring", "center.text"]),

  recipe("tooltip", "chart-tooltip-advanced", ["tooltip.value.advanced", "tooltip.label.none", "tooltip.aggregate"]),
  recipe("tooltip", "chart-tooltip-default", ["tooltip.default"]),
  recipe("tooltip", "chart-tooltip-formatter", ["tooltip.value.formatter", "tooltip.label.none"]),
  recipe("tooltip", "chart-tooltip-icons", ["tooltip.icon", "tooltip.label.none"]),
  recipe("tooltip", "chart-tooltip-indicator-line", ["tooltip.indicator.line"]),
  recipe("tooltip", "chart-tooltip-indicator-none", ["tooltip.indicator.none"]),
  recipe("tooltip", "chart-tooltip-label-custom", ["tooltip.label.key", "tooltip.indicator.line"]),
  recipe("tooltip", "chart-tooltip-label-formatter", ["tooltip.label.formatter"]),
  recipe("tooltip", "chart-tooltip-label-none", ["tooltip.label.none", "tooltip.indicator.none"]),
] as const;

export const chartRecipeDefinitionsSchema = z.array(chartRecipeDefinitionSchema).length(70).superRefine((recipes, context) => {
  const names = recipes.map((entry) => entry.recipeName);
  const sourceFiles = recipes.map((entry) => entry.sourceFile);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: "custom", message: "Every chart recipe name must map exactly once." });
  }
  if (new Set(sourceFiles).size !== sourceFiles.length) {
    context.addIssue({ code: "custom", message: "Every chart recipe source file must map exactly once." });
  }
  const expectedCounts: Record<ChartRecipeFamily, number> = {
    area: 10,
    bar: 10,
    line: 10,
    pie: 11,
    radar: 14,
    radial: 6,
    tooltip: 9,
  };
  for (const family of chartRecipeFamilies) {
    if (recipes.filter((entry) => entry.family === family).length !== expectedCounts[family]) {
      context.addIssue({ code: "custom", message: `Unexpected ${family} recipe count.` });
    }
  }
  const sorted = [...names].sort();
  if (sorted.some((name, index) => name !== names[index])) {
    context.addIssue({ code: "custom", message: "Chart recipes must use canonical name ordering." });
  }
});

export const officialChartRecipeDefinitions = deepFreeze(chartRecipeDefinitionsSchema.parse(
  [...definitions].sort((left, right) => left.recipeName < right.recipeName ? -1 : left.recipeName > right.recipeName ? 1 : 0),
));

export const chartRecipeSourceSchema = z.object({
  upstreamRepository: z.literal("shadcn-ui/ui"),
  upstreamCommit: z.string().regex(/^[0-9a-f]{40}$/),
  registryPath: z.literal("apps/v4/registry/new-york-v4/charts"),
  registryTree: z.string().regex(/^[0-9a-f]{40}$/),
  registryListingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  registryFileCount: z.literal(71),
  recipeFileCount: z.literal(70),
  sourceVersion: z.literal("4.18.0"),
  sourceDescribe: z.literal("shadcn@4.18.0-5-g25be24cc"),
  rendererPackages: z.object({
    shadcn: z.object({
      version: z.literal("4.18.0"),
      integrity: z.literal("sha512-tUFZgkYmfVNQVm3xX7lhSzOvDsp+O14ac5dwgXIr5mIsr79ISueb/Mu+ZtWMz0DH6v77u4eYyvbQ9TTMpSn3aw=="),
      integritySource: z.literal("npm-registry"),
    }).strict(),
    chartEngine: z.object({
      packageName: z.literal("recharts"),
      version: z.literal("3.8.0"),
      integrity: z.literal("sha512-Z/m38DX3L73ExO4Tpc9/iZWHmHnlzWG4njQbxsF5aSjwqmHNDDIm0rdEBArkwsBvR8U6EirlEHiQNYWCVh9sGQ=="),
      integritySource: z.literal("vendor-lockfile"),
    }).strict(),
  }).strict(),
  vendorLockfileHash: z.literal("sha256:4cdeb1a0cb106189fb36681f435e80a10a676aea41cffee22e059a3b2d49ac7a"),
}).strict();

export type ChartRecipeSource = z.infer<typeof chartRecipeSourceSchema>;

export const officialChartRecipeSource = deepFreeze(chartRecipeSourceSchema.parse({
  upstreamRepository: "shadcn-ui/ui",
  upstreamCommit: "25be24cca34d06eed29a4779c3f48c4816aa812c",
  registryPath: "apps/v4/registry/new-york-v4/charts",
  registryTree: "addee626e9f09551ff366c62deffebedea6bcac2",
  registryListingHash: "sha256:d80981943fe3f674a49b8020df7b6015f63796e95b4b3e153cd742a6ffb82e8e",
  registryFileCount: 71,
  recipeFileCount: 70,
  sourceVersion: "4.18.0",
  sourceDescribe: "shadcn@4.18.0-5-g25be24cc",
  rendererPackages: {
    shadcn: {
      version: "4.18.0",
      integrity: "sha512-tUFZgkYmfVNQVm3xX7lhSzOvDsp+O14ac5dwgXIr5mIsr79ISueb/Mu+ZtWMz0DH6v77u4eYyvbQ9TTMpSn3aw==",
      integritySource: "npm-registry",
    },
    chartEngine: {
      packageName: "recharts",
      version: "3.8.0",
      integrity: "sha512-Z/m38DX3L73ExO4Tpc9/iZWHmHnlzWG4njQbxsF5aSjwqmHNDDIm0rdEBArkwsBvR8U6EirlEHiQNYWCVh9sGQ==",
      integritySource: "vendor-lockfile",
    },
  },
  vendorLockfileHash: "sha256:4cdeb1a0cb106189fb36681f435e80a10a676aea41cffee22e059a3b2d49ac7a",
}));

export function verifyChartRecipeDefinitions(input: unknown): readonly ChartRecipeDefinition[] {
  return deepFreeze(chartRecipeDefinitionsSchema.parse(input));
}
