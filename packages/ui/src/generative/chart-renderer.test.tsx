import { describe, expect, test } from "bun:test";
import { createOfficialCatalog, dataChartGrammarFixtures, dataChartMarks } from "@open-generative/components";
import { canonicalNodeSchema, type JsonObject } from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DataChartRenderer } from "./chart-renderer";

describe("Data Chart grammar renderer", () => {
  test("SSR renders every supported semantic mark through one renderer", async () => {
    const catalog = await createOfficialCatalog();
    expect(dataChartGrammarFixtures.map((fixture) => fixture.mark)).toEqual([...dataChartMarks]);

    for (const fixture of dataChartGrammarFixtures) {
      const markup = renderToStaticMarkup(createElement(
        DataChartRenderer,
        chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
      ));

      expect(markup).toContain('data-og-component="data.chart"');
      expect(markup).toContain('data-og-renderer="grammar"');
      expect(markup).toContain(`data-chart-mark="${fixture.mark}"`);
      expect(markup).toContain('data-chart-stable-size="true"');
      expect(markup).toContain('data-equivalent-view="table"');
      expect(markup).toContain(escapeHtml(fixture.resolvedSpec.title));
      expect(markup).toContain("<svg");
      expect(markup).not.toContain("data-chart-recipe");
    }
  });

  test("uses resolved resource rows without serializing an authoring binding", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = dataChartGrammarFixtures.find((candidate) => candidate.mark === "bar")!;
    const markup = renderToStaticMarkup(createElement(
      DataChartRenderer,
      chartInput(catalog.components.dataChart, { spec: fixture.resolvedSpec } as unknown as JsonObject) as never,
    ));

    expect(markup).toContain("Enterprise");
    expect(markup).not.toContain("resource-ref");
    expect(markup).not.toContain("fixture.chart.dataset");
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
