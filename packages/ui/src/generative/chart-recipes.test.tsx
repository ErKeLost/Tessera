import { describe, expect, test } from "bun:test";
import {
  createOfficialCatalog,
  officialChartAccessibilityFixtures,
  officialChartSpecFixtures,
  officialRendererExpectationFixtures,
} from "@open-generative/components";
import { canonicalNodeSchema, type JsonObject } from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChartRenderer } from "./chart-renderer";

const nonRechartsRecipes = new Set([
  "steps-bars",
  "pipeline-stage-bars",
  "tracked-time-sankey",
  "visitors-radial",
  "activity-calendar",
  "active-users-heatmap",
  "sign-up-funnel",
  "contributions-heatmap",
  "devices-bars",
  "activity-rings",
]);

describe("the 17 official data chart recipes", () => {
  test("SSR renders every strict resolved fixture as real chart output", async () => {
    const catalog = await createOfficialCatalog();
    expect(officialChartSpecFixtures).toHaveLength(17);
    expect(officialRendererExpectationFixtures).toHaveLength(17);
    expect(officialChartAccessibilityFixtures).toHaveLength(17);

    for (const [index, fixture] of officialChartSpecFixtures.entries()) {
      const expectation = officialRendererExpectationFixtures[index]!;
      const accessibility = officialChartAccessibilityFixtures[index]!;
      const markup = renderToStaticMarkup(createElement(
        DataChartRenderer,
        chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
      ));

      expect(markup).toContain('data-og-component="data.chart"');
      expect(markup).toContain(`data-chart-recipe="${fixture.recipeName}"`);
      expect(markup).toContain(`data-renderer-kind="${expectation.rendererKind}"`);
      expect(markup).toContain('data-chart-stable-size="true"');
      expect(markup).toContain('data-reduced-motion="disable-animation"');
      expect(markup).toContain(`data-equivalent-view="${accessibility.equivalentView}"`);
      expect(markup).toContain(escapeHtml(fixture.spec.title));
      if (expectation.rendererKind !== "dom") expect(markup).toContain("<svg");
      expect(markup).not.toContain("content.callout");
      expect(markup).not.toContain("data.table");

      for (const semanticElement of expectation.semanticElements) {
        expect(attributeTokens(markup, "data-semantic-elements")).toContain(semanticElement);
      }
      if (expectation.rendererKind !== "dom") expect(markup).toContain("<title>");
      if (!nonRechartsRecipes.has(fixture.recipeName)) expect(markup).toContain('data-renderer-kind="recharts"');
    }
  });

  test("uses resource-resolved rows without serializing authoring bindings", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = officialChartSpecFixtures.find((candidate) => candidate.recipeName === "pipeline-stage-bars")!;
    const markup = renderToStaticMarkup(createElement(
      DataChartRenderer,
      chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
    ));

    expect(markup).toContain("Visits");
    expect(markup).toContain("Enterprise");
    expect(markup).not.toContain("fixture.chart.dataset");
  });

  test("renders steps bars as the selected weekly activity surface", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = officialChartSpecFixtures.find((candidate) => candidate.recipeName === "steps-bars")!;
    const markup = renderToStaticMarkup(createElement(
      DataChartRenderer,
      chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
    ));

    expect(markup).toContain('data-renderer-kind="dom"');
    expect(markup).toContain("Tuesday");
    expect(markup).toContain("2,200");
    expect(markup).toContain("29 Jun - 5 Jul");
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain('data-slot="progress"');
    expect(markup).not.toContain("og-steps-day is-selected");
    expect(markup).not.toContain("Total steps");
    expect(markup).not.toContain("Daily progress");
    expect(markup).not.toContain("Goal 10K");
  });

  test("renders pipeline as six shadcn-backed stages and summary cards", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = officialChartSpecFixtures.find((candidate) => candidate.recipeName === "pipeline-stage-bars")!;
    const markup = renderToStaticMarkup(createElement(
      DataChartRenderer,
      chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
    ));

    expect(markup).toContain('data-renderer-kind="dom"');
    expect(markup).toContain("1,180");
    expect(markup).toContain("+2.4%");
    expect(markup).toContain("Last 7 days");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain('data-slot="card"');
    expect(markup).toContain('data-slot="progress"');
    expect(markup).not.toContain("Total pipeline");
    expect(markup).not.toContain("Opportunities by stage");
  });

  test("renders sleep score as a Recharts-backed segmented scorecard", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = officialChartSpecFixtures.find((candidate) => candidate.recipeName === "sleep-score")!;
    const markup = renderToStaticMarkup(createElement(
      DataChartRenderer,
      chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
    ));

    expect(markup).toContain('data-renderer-kind="recharts"');
    expect(markup).toContain("Excellent");
    expect(markup).toContain("29 Jun - 5 Jul");
    expect(markup).toContain("Duration: 7h 50m");
    expect(markup).toContain("Bedtime: 20m earlier");
    expect(markup).toContain("Interruptions: 5m wake up");
    expect(markup).toContain("49/50");
    expect(markup).toContain('data-slot="chart"');
    expect(markup).toContain('data-slot="card"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).not.toContain("Recent score");
    expect(markup).not.toContain("Last 7 nights");
  });
});

type DataChartContract = Awaited<ReturnType<typeof createOfficialCatalog>>["components"]["dataChart"];

function chartInput(contract: DataChartContract, resolvedProps: JsonObject): RendererInput {
  return {
    node: canonicalNodeSchema.parse({
      contract: contract.ref,
      props: {},
      slots: {},
      events: {},
      evidence: [],
    }),
    contract,
    resolvedProps,
    slots: {},
    stateBindings: {},
    resourceBindings: {},
    placement: { kind: "inline", width: 800, height: 600 },
    projectionMode: "read-only-preview",
  };
}

function attributeTokens(markup: string, attribute: string): string[] {
  const match = markup.match(new RegExp(`${attribute}="([^"]*)"`));
  return match?.[1]?.split(" ").filter(Boolean) ?? [];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
