import { describe, expect, test } from "bun:test";
import {
  createOfficialCatalog,
  officialChartAccessibilityFixtures,
  officialChartSpecFixtures,
  officialRendererExpectationFixtures,
  resolvedChartSpecSchema,
} from "@open-generative/components";
import {
  canonicalNodeSchema,
  type JsonObject,
} from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChartRenderer } from "./chart-renderer";

const data = {
  columns: [
    { columnId: "month", label: "Month", valueType: "date" },
    { columnId: "revenue", label: "Revenue", valueType: "number" },
    { columnId: "cost", label: "Cost", valueType: "number" },
    { columnId: "channel", label: "Channel", valueType: "string" },
    { columnId: "dimension", label: "Dimension", valueType: "string" },
  ],
  rows: [
    { month: "2026-05-01", revenue: 120, cost: 74, channel: "Direct", dimension: "Speed" },
    { month: "2026-06-01", revenue: -36, cost: 81, channel: "Partner", dimension: "Quality" },
    { month: "2026-07-01", revenue: 154, cost: 96, channel: "Search", dimension: "Coverage" },
  ],
  totalRows: 3,
};

describe("all 70 official chart recipes", () => {
  test("SSR renders every recipe with stable size and its declared semantics", async () => {
    const catalog = await createOfficialCatalog();
    expect(officialChartSpecFixtures).toHaveLength(70);
    expect(officialRendererExpectationFixtures).toHaveLength(70);
    expect(officialChartAccessibilityFixtures).toHaveLength(70);

    for (const [index, fixture] of officialChartSpecFixtures.entries()) {
      const expectation = officialRendererExpectationFixtures[index]!;
      const accessibility = officialChartAccessibilityFixtures[index]!;
      const resolved = resolvedChartSpecSchema.parse(resolveFixtureSpec(fixture.spec));
      const markup = renderToStaticMarkup(createElement(
        DataChartRenderer,
        chartInput(catalog.components.dataChart, { spec: resolved } as unknown as JsonObject) as never,
      ));

      expect(markup).toContain('class="recharts-wrapper"');
      expect(markup).toContain("View data table");
      expect(markup).toContain(`data-chart-family="${expectation.chartFamily}"`);
      expect(markup).toContain('data-chart-stable-size="true"');
      expect(markup).toContain('data-reduced-motion="disable-animation"');
      expect(markup).toContain(`data-equivalent-view="${accessibility.equivalentView}"`);
      expect(markup).toContain(accessibility.accessibleName);

      const semanticElements = attributeTokens(markup, "data-semantic-elements");
      const eventPorts = attributeTokens(markup, "data-event-ports");
      for (const semanticElement of expectation.semanticElements) expect(semanticElements).toContain(semanticElement);
      for (const eventPort of expectation.expectedEvents) expect(eventPorts).toContain(eventPort);
      if (fixture.recipeName === "chart-area-axes") {
        expect(markup).toContain("Month");
        expect(markup).toContain("Revenue");
      }
    }
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

function resolveFixtureSpec(spec: (typeof officialChartSpecFixtures)[number]["spec"]): Record<string, unknown> {
  const resolved = structuredClone(spec) as Record<string, any>;
  resolved.data = data;
  if (resolved.legend?.visibilityState !== undefined) {
    resolved.legend.visibilityState = resolved.series.map((series: { column: string }) => series.column);
  }
  if (resolved.interaction?.state !== undefined) {
    resolved.interaction.state = resolved.interaction.kind === "range-select"
      ? { start: 0, end: 2 }
      : resolved.series[0]?.column ?? null;
  }
  if (resolved.centerText?.value !== undefined && typeof resolved.centerText.value === "object") {
    resolved.centerText.value = 120;
  }
  return resolved;
}
