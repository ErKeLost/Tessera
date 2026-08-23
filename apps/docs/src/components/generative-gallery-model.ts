export const dataChartFixtureNames = [
  "data-chart.categorical-bar",
  "data-chart.temporal-line",
  "data-chart.stacked-area",
  "data-chart.correlation-scatter",
  "data-chart.share-pie",
  "data-chart.profile-radar",
] as const;

export type DataChartFixtureName = (typeof dataChartFixtureNames)[number];

export type PreviewDescriptor = Readonly<{
  kind: "fixture";
  value: DataChartFixtureName;
}>;

export type DataChartFixtureDocumentation = Readonly<{
  title: string;
  description: string;
}>;

export const generativeGalleryPlacement = Object.freeze({
  kind: "inline" as const,
  width: 800,
  height: 600,
});

export const dataChartFixtureDocumentation = Object.freeze({
  "data-chart.categorical-bar": {
    title: "Categorical bar",
    description: "A categorical comparison with an explicit quantitative measure.",
  },
  "data-chart.temporal-line": {
    title: "Temporal line",
    description: "A time series with a temporal x encoding and quantitative y encoding.",
  },
  "data-chart.stacked-area": {
    title: "Stacked area",
    description: "A temporal series grouped by a categorical color encoding.",
  },
  "data-chart.correlation-scatter": {
    title: "Correlation scatter",
    description: "A quantitative comparison with optional color and size encodings.",
  },
  "data-chart.share-pie": {
    title: "Share pie",
    description: "A categorical share with quantitative angular encoding.",
  },
  "data-chart.profile-radar": {
    title: "Profile radar",
    description: "A categorical profile with a comparable quantitative radius.",
  },
} satisfies Readonly<Record<DataChartFixtureName, DataChartFixtureDocumentation>>);

export const generativeGalleryConformanceDescriptors: readonly PreviewDescriptor[] =
  Object.freeze(
    dataChartFixtureNames.map((fixtureName) => Object.freeze({
      kind: "fixture" as const,
      value: fixtureName,
    })),
  );

const descriptorKeys = new Set(
  generativeGalleryConformanceDescriptors.map(descriptorKey),
);

export function parsePreviewDescriptor(
  kind: string | null,
  value: string | null,
): PreviewDescriptor {
  if (kind !== "fixture" || value === null) {
    throw new TypeError("Expected a data.chart grammar fixture descriptor.");
  }
  const descriptor = { kind, value } as PreviewDescriptor;
  if (!descriptorKeys.has(descriptorKey(descriptor))) {
    throw new TypeError(`Unknown data.chart grammar fixture: ${value}`);
  }
  return Object.freeze(descriptor);
}

export function descriptorKey(descriptor: PreviewDescriptor): string {
  return `${descriptor.kind}:${descriptor.value}`;
}
