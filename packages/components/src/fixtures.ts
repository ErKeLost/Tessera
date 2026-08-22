import { jsonValueSchema } from "@open-generative/protocol";
import { z } from "zod";
import { resolvedChartSpecSchema } from "./chart-spec";
import { officialChartSpecFixtures } from "./chart-fixtures";
import {
  contentCalloutPropsSchema,
  contentEmptyPropsSchema,
  contentTextPropsSchema,
  controlFilterAuthoringPropsSchema,
  controlFilterPropsSchema,
  controlGroupPropsSchema,
  dataChartAuthoringPropsSchema,
  dataChartPropsSchema,
  dataMetricAuthoringPropsSchema,
  dataMetricPropsSchema,
  dataQueryDetailsAuthoringPropsSchema,
  dataQueryDetailsPropsSchema,
  dataTableAuthoringPropsSchema,
  dataTablePropsSchema,
  layoutGridPropsSchema,
  layoutSectionPropsSchema,
  layoutStackPropsSchema,
} from "./props";
import { deepFreeze } from "./schema";

export const officialComponentTypes = [
  "content.callout",
  "content.empty",
  "content.text",
  "control.filter",
  "control.group",
  "data.chart",
  "data.metric",
  "data.query-details",
  "data.table",
  "layout.grid",
  "layout.section",
  "layout.stack",
] as const;
export const officialComponentTypeSchema = z.enum(officialComponentTypes);

export const componentFixtureSchema = z.object({
  fixtureId: z.string().regex(/^component\.[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  authoringProps: jsonValueSchema,
  resolvedProps: jsonValueSchema,
}).strict();
export type ComponentFixture = z.infer<typeof componentFixtureSchema>;

function componentFixture(
  componentType: z.infer<typeof officialComponentTypeSchema>,
  authoringSchema: z.ZodType,
  resolvedSchema: z.ZodType,
  authoringProps: unknown,
  resolvedProps: unknown,
): ComponentFixture {
  return componentFixtureSchema.parse({
    fixtureId: `component.${componentType}`,
    componentType,
    authoringProps: authoringSchema.parse(authoringProps),
    resolvedProps: resolvedSchema.parse(resolvedProps),
  });
}

const chartFixture = officialChartSpecFixtures.find((fixture) => fixture.recipeName === "chart-area-default")!;
const resolvedDataset = {
  columns: [
    { columnId: "month", label: "Month", valueType: "date" },
    { columnId: "revenue", label: "Revenue", valueType: "number" },
  ],
  rows: [
    { month: "2026-06-01", revenue: 128_400 },
    { month: "2026-07-01", revenue: 139_200 },
  ],
  totalRows: 2,
};
const resolvedChartSpec = resolvedChartSpecSchema.parse({ ...chartFixture.spec, data: resolvedDataset });

const componentFixtures = [
  componentFixture(
    "content.callout",
    contentCalloutPropsSchema,
    contentCalloutPropsSchema,
    { title: "Interpretation", body: "Revenue increased while acquisition cost remained stable.", tone: "info" },
    { title: "Interpretation", body: "Revenue increased while acquisition cost remained stable.", tone: "info" },
  ),
  componentFixture(
    "content.empty",
    contentEmptyPropsSchema,
    contentEmptyPropsSchema,
    { reason: "filtered", title: "No matching rows", description: "Broaden the active filters." },
    { reason: "filtered", title: "No matching rows", description: "Broaden the active filters." },
  ),
  componentFixture(
    "content.text",
    contentTextPropsSchema,
    contentTextPropsSchema,
    { text: "Monthly performance", role: "heading", level: 2 },
    { text: "Monthly performance", role: "heading", level: 2 },
  ),
  componentFixture(
    "control.filter",
    controlFilterAuthoringPropsSchema,
    controlFilterPropsSchema,
    {
      filterId: "region",
      label: "Region",
      kind: "select",
      operator: "equals",
      value: { kind: "state-ref", stateId: "filter.region" },
      options: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
      ],
    },
    {
      filterId: "region",
      label: "Region",
      kind: "select",
      operator: "equals",
      value: "north",
      options: [
        { value: "north", label: "North" },
        { value: "south", label: "South" },
      ],
    },
  ),
  componentFixture(
    "control.group",
    controlGroupPropsSchema,
    controlGroupPropsSchema,
    { label: "Data filters", orientation: "horizontal", submitMode: "explicit" },
    { label: "Data filters", orientation: "horizontal", submitMode: "explicit" },
  ),
  componentFixture(
    "data.chart",
    dataChartAuthoringPropsSchema,
    dataChartPropsSchema,
    { spec: chartFixture.spec },
    { spec: resolvedChartSpec },
  ),
  componentFixture(
    "data.metric",
    dataMetricAuthoringPropsSchema,
    dataMetricPropsSchema,
    {
      label: "Revenue",
      value: { kind: "resource-ref", bindingId: "metric.revenue", path: ["value"] },
      format: { kind: "currency", currency: "USD" },
      comparison: {
        value: { kind: "resource-ref", bindingId: "metric.revenue", path: ["change"] },
        direction: "higher-is-better",
        format: { kind: "percent", maximumFractionDigits: 1 },
      },
    },
    {
      label: "Revenue",
      value: 128_400,
      format: { kind: "currency", currency: "USD" },
      comparison: {
        value: 0.084,
        direction: "higher-is-better",
        format: { kind: "percent", maximumFractionDigits: 1 },
      },
    },
  ),
  componentFixture(
    "data.query-details",
    dataQueryDetailsAuthoringPropsSchema,
    dataQueryDetailsPropsSchema,
    {
      details: { kind: "resource-ref", bindingId: "query.details" },
      sections: ["summary", "sql", "lineage", "freshness", "evidence"],
      defaultSection: "summary",
    },
    {
      details: {
        queryId: "query-2026-08-22",
        status: "succeeded",
        sql: "select month, sum(revenue) from sales group by month",
        durationMs: 142,
        rowCount: 2,
        freshness: { observedAt: "2026-08-22T09:30:00+08:00", status: "fresh" },
        lineage: [{ kind: "source", label: "sales" }, { kind: "output", label: "monthly revenue" }],
        evidence: [{ label: "Query result", summary: "Two monthly aggregates were returned." }],
      },
      sections: ["summary", "sql", "lineage", "freshness", "evidence"],
      defaultSection: "summary",
    },
  ),
  componentFixture(
    "data.table",
    dataTableAuthoringPropsSchema,
    dataTablePropsSchema,
    {
      data: { kind: "resource-ref", bindingId: "table.monthly" },
      columns: [
        { column: "month", label: "Month", format: { kind: "date", dateStyle: "medium" } },
        { column: "revenue", label: "Revenue", format: { kind: "currency", currency: "USD" }, align: "end" },
      ],
      pagination: { pageSize: 25 },
    },
    {
      data: { ...resolvedDataset, hasMore: false },
      columns: [
        { column: "month", label: "Month", format: { kind: "date", dateStyle: "medium" } },
        { column: "revenue", label: "Revenue", format: { kind: "currency", currency: "USD" }, align: "end" },
      ],
      pagination: { pageSize: 25, page: 0 },
    },
  ),
  componentFixture(
    "layout.grid",
    layoutGridPropsSchema,
    layoutGridPropsSchema,
    { columns: 3, gap: "md", align: "stretch" },
    { columns: 3, gap: "md", align: "stretch" },
  ),
  componentFixture(
    "layout.section",
    layoutSectionPropsSchema,
    layoutSectionPropsSchema,
    { title: "Overview", description: "Verified monthly measures.", level: 2 },
    { title: "Overview", description: "Verified monthly measures.", level: 2 },
  ),
  componentFixture(
    "layout.stack",
    layoutStackPropsSchema,
    layoutStackPropsSchema,
    { gap: "md", align: "stretch", density: "comfortable" },
    { gap: "md", align: "stretch", density: "comfortable" },
  ),
] as const;

export const officialComponentFixtures = deepFreeze(componentFixtures);

const recipeNodeSchema = z.object({
  nodeId: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  componentType: officialComponentTypeSchema,
  propsFixtureId: componentFixtureSchema.shape.fixtureId.optional(),
  slots: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.array(z.string().regex(/^[a-z][a-z0-9.-]+$/)).max(128)),
}).strict();

export const compositionRecipeSchema = z.object({
  recipeId: z.string().regex(/^composition\.[a-z][a-z0-9.-]+$/),
  summary: z.string().trim().min(1).max(512),
  rootNodeId: recipeNodeSchema.shape.nodeId,
  nodes: z.array(recipeNodeSchema).min(1).max(128),
}).strict().superRefine((recipe, context) => {
  const nodeIds = recipe.nodes.map((node) => node.nodeId);
  const nodeSet = new Set(nodeIds);
  if (nodeSet.size !== nodeIds.length) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Composition node IDs must be unique." });
  }
  if (!nodeSet.has(recipe.rootNodeId)) {
    context.addIssue({ code: "custom", path: ["rootNodeId"], message: "Composition root must exist." });
  }
  const fixtureIds = new Set(officialComponentFixtures.map((fixture) => fixture.fixtureId));
  for (const [index, node] of recipe.nodes.entries()) {
    if (node.propsFixtureId !== undefined && !fixtureIds.has(node.propsFixtureId)) {
      context.addIssue({ code: "custom", path: ["nodes", index, "propsFixtureId"], message: "Unknown component fixture." });
    }
    for (const children of Object.values(node.slots)) {
      for (const child of children) {
        if (!nodeSet.has(child)) {
          context.addIssue({ code: "custom", path: ["nodes", index, "slots"], message: "Composition slot references an unknown node." });
        }
      }
    }
  }
  if (hasCompositionCycle(recipe.rootNodeId, new Map(recipe.nodes.map((node) => [node.nodeId, node])), new Set(), new Set())) {
    context.addIssue({ code: "custom", path: ["nodes"], message: "Composition recipes must be acyclic." });
  }
});

export type CompositionRecipe = z.infer<typeof compositionRecipeSchema>;

function hasCompositionCycle(
  nodeId: string,
  nodes: Map<string, z.infer<typeof recipeNodeSchema>>,
  visiting: Set<string>,
  visited: Set<string>,
): boolean {
  if (visiting.has(nodeId)) return true;
  if (visited.has(nodeId)) return false;
  visiting.add(nodeId);
  const node = nodes.get(nodeId);
  if (node !== undefined) {
    for (const child of Object.values(node.slots).flat()) {
      if (hasCompositionCycle(child, nodes, visiting, visited)) return true;
    }
  }
  visiting.delete(nodeId);
  visited.add(nodeId);
  return false;
}

export const officialCompositionRecipes = deepFreeze([
  compositionRecipeSchema.parse({
    recipeId: "composition.analysis-overview",
    summary: "Metric, chart, exact rows, and query evidence in one ordered analysis.",
    rootNodeId: "root",
    nodes: [
      { nodeId: "root", componentType: "layout.stack", propsFixtureId: "component.layout.stack", slots: { children: ["overview"] } },
      { nodeId: "overview", componentType: "layout.section", propsFixtureId: "component.layout.section", slots: { children: ["metric", "chart", "table", "query"] } },
      { nodeId: "metric", componentType: "data.metric", propsFixtureId: "component.data.metric", slots: {} },
      { nodeId: "chart", componentType: "data.chart", propsFixtureId: "component.data.chart", slots: {} },
      { nodeId: "table", componentType: "data.table", propsFixtureId: "component.data.table", slots: {} },
      { nodeId: "query", componentType: "data.query-details", propsFixtureId: "component.data.query-details", slots: {} },
    ],
  }),
  compositionRecipeSchema.parse({
    recipeId: "composition.filterable-breakdown",
    summary: "Explicit filters and a responsive comparison grid over the same governed resources.",
    rootNodeId: "root",
    nodes: [
      { nodeId: "root", componentType: "layout.stack", propsFixtureId: "component.layout.stack", slots: { children: ["filters", "breakdown"] } },
      { nodeId: "filters", componentType: "control.group", propsFixtureId: "component.control.group", slots: { controls: ["region"] } },
      { nodeId: "region", componentType: "control.filter", propsFixtureId: "component.control.filter", slots: {} },
      { nodeId: "breakdown", componentType: "layout.grid", propsFixtureId: "component.layout.grid", slots: { children: ["metric", "chart", "table"] } },
      { nodeId: "metric", componentType: "data.metric", propsFixtureId: "component.data.metric", slots: {} },
      { nodeId: "chart", componentType: "data.chart", propsFixtureId: "component.data.chart", slots: {} },
      { nodeId: "table", componentType: "data.table", propsFixtureId: "component.data.table", slots: {} },
    ],
  }),
]);
