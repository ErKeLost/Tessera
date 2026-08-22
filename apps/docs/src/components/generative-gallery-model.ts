import {
  officialChartSpecFixtures,
  officialComponentTypes,
} from "@open-generative/components";

export type OfficialComponentType = (typeof officialComponentTypes)[number];

export type PreviewKind = "analysis" | "component" | "filter" | "metrics" | "recipe";

export type PreviewDescriptor = Readonly<{
  kind: PreviewKind;
  value: string;
}>;

export const generativeGalleryPlacement = Object.freeze({
  kind: "inline" as const,
  width: 800,
  height: 600,
});

export const generativeGalleryConformanceDescriptors: readonly PreviewDescriptor[] = Object.freeze([
  ...officialComponentTypes.map((componentType) => ({
    kind: "component" as const,
    value: componentType,
  })),
  ...officialChartSpecFixtures.map((fixture) => ({
    kind: "recipe" as const,
    value: fixture.recipeName,
  })),
  { kind: "analysis", value: "analysis-overview" },
  { kind: "filter", value: "filterable-breakdown" },
  { kind: "metrics", value: "workspace-health" },
]);

export const contractDescriptions: Readonly<Record<OfficialComponentType, string>> = Object.freeze({
  "content.callout": "Bounded insight, warning, or limitation",
  "content.empty": "Explicit empty, unavailable, or filtered state",
  "content.text": "Semantic text without executable markup",
  "control.filter": "State-ready governed data filter",
  "control.group": "Related controls with explicit apply semantics",
  "data.chart": "Resource-backed semantic ChartSpec",
  "data.metric": "Verified scalar and comparison",
  "data.query-details": "SQL, lineage, freshness, and evidence",
  "data.table": "Exact windowed rows and columns",
  "layout.grid": "Responsive comparison layout",
  "layout.section": "Titled semantic grouping",
  "layout.stack": "Ordered analysis reading flow",
});

const descriptorKeys = new Set(
  generativeGalleryConformanceDescriptors.map(descriptorKey),
);

export function parsePreviewDescriptor(kind: string | null, value: string | null): PreviewDescriptor {
  const descriptor = { kind, value } as PreviewDescriptor;
  if (kind === null || value === null || !descriptorKeys.has(descriptorKey(descriptor))) {
    throw new TypeError("Unknown Tessera Agent Generative UI preview descriptor.");
  }
  return Object.freeze({ kind: kind as PreviewKind, value });
}

export function descriptorKey(descriptor: PreviewDescriptor): string {
  return `${descriptor.kind}:${descriptor.value}`;
}
