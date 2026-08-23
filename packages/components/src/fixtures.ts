import { jsonValueSchema } from "@open-generative/protocol";
import { z } from "zod";
import { officialChartSpecFixtures } from "./chart-fixtures";
import { dataChartAuthoringPropsSchema, dataChartPropsSchema } from "./props";
import {
  analysisInsightPropsSchema,
  analysisReportPropsSchema,
  dataMetricAuthoringPropsSchema,
  dataMetricPropsSchema,
  layoutGridPropsSchema,
  layoutStackPropsSchema,
} from "./generative-spec";
import { deepFreeze } from "./schema";

export const officialComponentTypes = [
  "data.chart",
  "data.metric",
  "analysis.insight",
  "layout.stack",
  "layout.grid",
  "analysis.report",
] as const;
export const officialComponentTypeSchema = z.enum(officialComponentTypes);

export const componentFixtureSchema = z.object({
  fixtureId: z.string().regex(/^component\.[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  authoringProps: jsonValueSchema,
  resolvedProps: jsonValueSchema,
}).strict();
export type ComponentFixture = z.infer<typeof componentFixtureSchema>;

const chartFixture = officialChartSpecFixtures[0]!;

export const officialComponentFixtures = deepFreeze([
  componentFixtureSchema.parse({
    fixtureId: "component.data.chart",
    componentType: "data.chart",
    authoringProps: dataChartAuthoringPropsSchema.parse({ spec: chartFixture.spec }),
    resolvedProps: dataChartPropsSchema.parse({ spec: chartFixture.resolvedSpec }),
  }),
  componentFixtureSchema.parse({
    fixtureId: "component.data.metric",
    componentType: "data.metric",
    authoringProps: dataMetricAuthoringPropsSchema.parse({ label: "Total", data: { kind: "resource-ref", bindingId: "data" }, format: "number" }),
    resolvedProps: dataMetricPropsSchema.parse({ label: "Total", data: chartFixture.dataset, format: "number" }),
  }),
  componentFixtureSchema.parse({
    fixtureId: "component.analysis.insight",
    componentType: "analysis.insight",
    authoringProps: analysisInsightPropsSchema.parse({ title: "Insight", body: "A verified observation.", tone: "neutral" }),
    resolvedProps: analysisInsightPropsSchema.parse({ title: "Insight", body: "A verified observation.", tone: "neutral" }),
  }),
  componentFixtureSchema.parse({ fixtureId: "component.layout.stack", componentType: "layout.stack", authoringProps: layoutStackPropsSchema.parse({ gap: "md" }), resolvedProps: layoutStackPropsSchema.parse({ gap: "md" }) }),
  componentFixtureSchema.parse({ fixtureId: "component.layout.grid", componentType: "layout.grid", authoringProps: layoutGridPropsSchema.parse({ columns: 2, gap: "md" }), resolvedProps: layoutGridPropsSchema.parse({ columns: 2, gap: "md" }) }),
  componentFixtureSchema.parse({ fixtureId: "component.analysis.report", componentType: "analysis.report", authoringProps: analysisReportPropsSchema.parse({ title: "Analysis report" }), resolvedProps: analysisReportPropsSchema.parse({ title: "Analysis report" }) }),
]);

const recipeNodeSchema = z.object({
  nodeId: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  propsFixtureId: componentFixtureSchema.shape.fixtureId,
  slots: z.record(z.string(), z.array(z.string())).default({}),
}).strict();

export const compositionRecipeSchema = z.object({
  recipeId: z.literal("composition.data-chart"),
  summary: z.string().trim().min(1).max(512),
  rootNodeId: recipeNodeSchema.shape.nodeId,
  nodes: z.tuple([recipeNodeSchema]),
}).strict().superRefine((recipe, context) => {
  if (recipe.nodes[0].nodeId !== recipe.rootNodeId) {
    context.addIssue({ code: "custom", path: ["rootNodeId"], message: "Composition root must identify its only chart node." });
  }
});

export type CompositionRecipe = z.infer<typeof compositionRecipeSchema>;

export const officialCompositionRecipes = deepFreeze([
  compositionRecipeSchema.parse({
    recipeId: "composition.data-chart",
    summary: "One governed Data Chart surface backed by a Resource Binding.",
    rootNodeId: "chart",
    nodes: [{
      nodeId: "chart",
      componentType: "data.chart",
      propsFixtureId: "component.data.chart",
      slots: {},
    }],
  }),
]);
