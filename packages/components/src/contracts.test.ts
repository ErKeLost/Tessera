import { describe, expect, test } from "bun:test";
import {
  eventPortSchema,
  jsonPointerSchema,
} from "@open-generative/protocol";
import {
  verifyActionContract,
  verifyCatalogManifest,
  verifyComponentContract,
} from "@open-generative/catalog";
import {
  OFFICIAL_CATALOG_REVISION,
  createOfficialBrowserCatalogProjection,
  createOfficialCatalog,
} from "./contracts";

describe("official component catalog", () => {
  test("creates exactly 12 component contracts and three action contracts at package revision 0.3.12", async () => {
    const catalog = await createOfficialCatalog();
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

    expect(packageJson.version).toBe("0.3.12");
    expect(String(OFFICIAL_CATALOG_REVISION)).toBe("0.3.12");
    expect(catalog.componentContracts).toHaveLength(12);
    expect(catalog.actionContracts).toHaveLength(3);
    expect(new Set(catalog.componentContracts.map((contract) => String(contract.ref.componentType)))).toEqual(new Set([
      "layout.stack",
      "layout.grid",
      "layout.section",
      "content.text",
      "content.callout",
      "content.empty",
      "data.metric",
      "data.table",
      "data.chart",
      "data.query-details",
      "control.filter",
      "control.group",
    ]));
    expect(new Set(catalog.actionContracts.map((contract) => String(contract.ref.actionType)))).toEqual(new Set([
      "data.export",
      "surface.retry",
      "control.apply",
    ]));

    await expect(verifyCatalogManifest(catalog.manifest)).resolves.toEqual(catalog.manifest);
    await Promise.all(catalog.componentContracts.map((contract) => expect(verifyComponentContract(contract)).resolves.toEqual(contract)));
    await Promise.all(catalog.actionContracts.map((contract) => expect(verifyActionContract(contract)).resolves.toEqual(contract)));
  });

  test("is deterministic and uses exact full ContractRefs in an acyclic slot graph", async () => {
    const [left, right] = await Promise.all([createOfficialCatalog(), createOfficialCatalog()]);
    expect(left.manifest.ref.manifestHash).toBe(right.manifest.ref.manifestHash);
    expect(left.manifest.contractSetHash).toBe(right.manifest.contractSetHash);
    expect(left.componentContracts.map((contract) => contract.ref.contractHash)).toEqual(
      right.componentContracts.map((contract) => contract.ref.contractHash),
    );

    const contracts = new Map(left.componentContracts.map((contract) => [contract.ref.componentType, contract]));
    const graph = new Map<string, string[]>();
    for (const contract of left.componentContracts) {
      const targets = Object.values(contract.slots).flatMap((slot) => slot.accepts.map((selector) => {
        const target = contracts.get(selector.contract.componentType);
        expect(target?.ref).toEqual(selector.contract);
        return selector.contract.componentType;
      }));
      graph.set(contract.ref.componentType, targets);
    }
    expect(hasCycle(graph)).toBe(false);
  });

  test("binds governed resources and host intents to the expected contracts", async () => {
    const catalog = await createOfficialCatalog();
    const chart = catalog.components.dataChart;
    const dataPath = jsonPointerSchema.parse("/spec/data");
    const legendStatePath = jsonPointerSchema.parse("/spec/legend/visibilityState");
    const interactionStatePath = jsonPointerSchema.parse("/spec/interaction/state");
    const centerTextPath = jsonPointerSchema.parse("/spec/centerText/value");
    expect(chart.authoringBindings[dataPath]?.allowedSources).toEqual(["resource"]);
    expect(chart.authoringBindings[dataPath]?.resource?.selector.maxWindowItems).toBe(10_000);
    expect(chart.authoringBindings[legendStatePath]?.allowedSources).toEqual(["state"]);
    expect(chart.authoringBindings[interactionStatePath]?.allowedSources).toEqual(["state"]);
    expect(chart.authoringBindings[centerTextPath]?.allowedSources).toEqual(["literal", "state"]);
    expect(chart.readiness.requiredBindings).toEqual([dataPath]);
    expect(chart.accessibility.equivalentView).toBe("host-required");

    expect(catalog.components.dataTable.events[eventPortSchema.parse("export")]?.actionContracts).toEqual([catalog.actions.dataExport.ref]);
    expect(catalog.components.dataQueryDetails.events[eventPortSchema.parse("export")]?.actionContracts).toEqual([catalog.actions.dataExport.ref]);
    expect(catalog.components.contentEmpty.events[eventPortSchema.parse("retry")]?.actionContracts).toEqual([catalog.actions.surfaceRetry.ref]);
    expect(catalog.components.controlGroup.events[eventPortSchema.parse("apply")]?.actionContracts).toEqual([catalog.actions.controlApply.ref]);
  });

  test("verifies before producing a prompt-free browser projection", async () => {
    const catalog = await createOfficialCatalog();
    const projection = await createOfficialBrowserCatalogProjection(catalog);
    expect(projection.components).toHaveLength(12);
    expect(projection.actions).toHaveLength(3);
    for (const component of projection.components) {
      expect("prompt" in component).toBe(false);
      expect("authoringBindings" in component).toBe(false);
      expect("migrations" in component).toBe(false);
    }

    const tamperedChart = structuredClone(catalog.components.dataChart);
    tamperedChart.prompt.summary = "Changed after hashing";
    const tampered = {
      ...catalog,
      components: { ...catalog.components, dataChart: tamperedChart },
      componentContracts: catalog.componentContracts.map((contract) => (
        contract.ref.componentType === "data.chart" ? tamperedChart : contract
      )),
    };
    await expect(createOfficialBrowserCatalogProjection(tampered)).rejects.toThrow();
  });
});

function hasCycle(graph: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(node: string): boolean {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const child of graph.get(node) ?? []) if (visit(child)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return [...graph.keys()].some(visit);
}
