import { describe, expect, test } from "bun:test";
import { jsonPointerSchema } from "@open-generative/protocol";
import { verifyCatalogManifest, verifyComponentContract } from "@open-generative/catalog";
import {
  OFFICIAL_CATALOG_REVISION,
  createOfficialBrowserCatalogProjection,
  createOfficialCatalog,
} from "./contracts";

describe("official component catalog", () => {
  test("contains only the governed data.chart contract", async () => {
    const catalog = await createOfficialCatalog();
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(String(OFFICIAL_CATALOG_REVISION)).toBe(packageJson.version);
    expect(catalog.componentContracts.map((contract) => String(contract.ref.componentType))).toEqual(["data.chart"]);
    expect(catalog.actionContracts).toEqual([]);
    expect(catalog.components.dataChart.slots).toEqual({});
    expect(catalog.components.dataChart.events).toEqual({});
    await expect(verifyCatalogManifest(catalog.manifest)).resolves.toEqual(catalog.manifest);
    await expect(verifyComponentContract(catalog.components.dataChart)).resolves.toEqual(catalog.components.dataChart);
  });

  test("declares one required Resource Binding and no state/literal bindings", async () => {
    const chart = (await createOfficialCatalog()).components.dataChart;
    const dataPath = jsonPointerSchema.parse("/spec/data");
    expect(Object.keys(chart.authoringBindings)).toEqual([dataPath]);
    expect(chart.authoringBindings[dataPath]?.allowedSources).toEqual(["resource"]);
    expect(chart.authoringBindings[dataPath]?.resource?.selector).toMatchObject({
      allowProjection: true,
      maxProjectedColumns: 32,
      maxWindowItems: 10_000,
      allowSort: false,
    });
    expect(chart.readiness.requiredBindings).toEqual([dataPath]);
    expect(chart.accessibility.equivalentView).toBe("host-required");
  });

  test("is deterministic and produces a verified browser projection", async () => {
    const [left, right] = await Promise.all([createOfficialCatalog(), createOfficialCatalog()]);
    expect(left.manifest).toEqual(right.manifest);
    expect(left.components.dataChart.ref).toEqual(right.components.dataChart.ref);
    const projection = await createOfficialBrowserCatalogProjection(left);
    expect(projection.components).toHaveLength(1);
    expect(projection.actions).toHaveLength(0);
    expect("prompt" in projection.components[0]!).toBe(false);
    expect("authoringBindings" in projection.components[0]!).toBe(false);
  });
});
