import { jsonValueSchema } from "@open-generative/protocol";
import { z } from "zod";
import { dataChartGrammarFixtures } from "./data-chart-fixtures";
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

const chartFixture = dataChartGrammarFixtures[0]!;

export const officialComponentFixtures = deepFreeze([
  componentFixtureSchema.parse({
    fixtureId: "component.data.chart",
    componentType: "data.chart",
    authoringProps: dataChartAuthoringPropsSchema.parse({ spec: chartFixture.authoringSpec }),
    resolvedProps: dataChartPropsSchema.parse({ spec: chartFixture.resolvedSpec }),
  }),
]);

const compositionNodeSchema = z.object({
  nodeId: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  propsFixtureId: componentFixtureSchema.shape.fixtureId,
  slots: z.object({}).strict(),
}).strict();

export const surfaceCompositionSchema = z.object({
  compositionId: z.literal("composition.data-chart"),
  summary: z.string().trim().min(1).max(512),
  rootNodeId: compositionNodeSchema.shape.nodeId,
  nodes: z.tuple([compositionNodeSchema]),
}).strict().superRefine((composition, context) => {
  if (composition.nodes[0].nodeId !== composition.rootNodeId) {
    context.addIssue({ code: "custom", path: ["rootNodeId"], message: "Composition root must identify its only chart node." });
  }
});

export type SurfaceComposition = z.infer<typeof surfaceCompositionSchema>;

export const officialSurfaceCompositions = deepFreeze([
  surfaceCompositionSchema.parse({
    compositionId: "composition.data-chart",
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
