import {
  createOfficialCatalog,
  verifyOfficialRendererRelease,
  type OfficialCatalogBundle,
  type OfficialRendererRelease,
} from "@open-generative/components";
import {
  createRendererRegistry,
  createVerifiedRendererRegistry,
  type NodeRenderer,
  type RendererRegistration,
  type RendererRegistry,
} from "@open-generative/react";
import { DataChartRenderer } from "./chart-renderer";
import {
  AnalysisInsightRenderer,
  AnalysisReportRenderer,
  DataMetricRenderer,
  GridRenderer,
  StackRenderer,
} from "./layout-renderers";

export const officialRendererComponents = Object.freeze({
  "data.chart": DataChartRenderer,
  "data.metric": DataMetricRenderer,
  "analysis.insight": AnalysisInsightRenderer,
  "layout.stack": StackRenderer,
  "layout.grid": GridRenderer,
  "analysis.report": AnalysisReportRenderer,
});

export const officialRendererEventPorts = Object.freeze({});

export type OfficialRendererComponentMap = typeof officialRendererComponents;
export type OfficialRendererRegistration = RendererRegistration;

export function createOfficialRendererRegistrations(
  catalog: OfficialCatalogBundle,
): readonly OfficialRendererRegistration[] {
  const byType = new Map<string, (typeof catalog.componentContracts)[number]>(
    catalog.componentContracts.map((contract) => [contract.ref.componentType, contract]),
  );
  const registrations = Object.entries(officialRendererComponents).map(([componentType, renderer]) => {
    const contract = byType.get(componentType);
    if (contract === undefined) {
      throw new TypeError(`The official catalog is missing ${componentType}.`);
    }
    return Object.freeze({
      contract: contract.ref,
      placements: contract.placements,
      renderer: renderer as NodeRenderer<any>,
    });
  });
  if (registrations.length !== catalog.componentContracts.length) {
    const unsupported = catalog.componentContracts
      .map((contract) => contract.ref.componentType)
      .filter((componentType) => !(componentType in officialRendererComponents));
    throw new TypeError(`The official renderer set is not exact: ${unsupported.join(", ") || "catalog cardinality mismatch"}.`);
  }
  return Object.freeze(registrations);
}

export async function createOfficialRendererRegistry(
  catalog?: OfficialCatalogBundle,
): Promise<RendererRegistry> {
  const resolvedCatalog = catalog ?? await createOfficialCatalog();
  return createRendererRegistry(createOfficialRendererRegistrations(resolvedCatalog));
}

export async function createVerifiedOfficialRendererRegistry(
  release: OfficialRendererRelease,
  catalog?: OfficialCatalogBundle,
): Promise<RendererRegistry> {
  const resolvedCatalog = catalog ?? await createOfficialCatalog();
  const verifiedRelease = await verifyOfficialRendererRelease(release, resolvedCatalog);
  return createVerifiedRendererRegistry(
    createOfficialRendererRegistrations(resolvedCatalog),
    verifiedRelease.manifest,
  );
}
