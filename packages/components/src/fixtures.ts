import { jsonValueSchema } from "@open-generative/protocol";
import { z } from "zod";
import { officialChartSpecFixtures } from "./chart-fixtures";
import { dataChartAuthoringPropsSchema, dataChartPropsSchema } from "./props";
import { deepFreeze } from "./schema";

export const officialComponentTypes = ["data.chart"] as const;
export const officialComponentTypeSchema = z.enum(officialComponentTypes);

export const componentFixtureSchema = z.object({
  fixtureId: z.literal("component.data.chart"),
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
]);

const recipeNodeSchema = z.object({
  nodeId: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  propsFixtureId: componentFixtureSchema.shape.fixtureId,
  slots: z.object({}).strict(),
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
