export const chartRecipeNames = [
  "steps-bars",
  "pipeline-stage-bars",
  "sleep-score",
  "revenue-per-account-scatter",
  "tracked-time-sankey",
  "visitors-radial",
  "visitors-radar",
  "activity-calendar",
  "revenue-smooth-area",
  "active-users-heatmap",
  "sign-up-funnel",
  "earned-so-far-bars",
  "contributions-heatmap",
  "sessions-conversion-combo",
  "devices-bars",
  "visitors-stacked-area",
  "activity-rings",
] as const;

export type ChartRecipeName = (typeof chartRecipeNames)[number];

export type PreviewDescriptor = Readonly<{
  kind: "recipe";
  value: ChartRecipeName;
}>;

export type ChartRecipeDocumentation = Readonly<{
  title: string;
  description: string;
}>;

export const generativeGalleryPlacement = Object.freeze({
  kind: "inline" as const,
  width: 800,
  height: 600,
});

export const chartRecipeDocumentation = Object.freeze({
  "steps-bars": {
    title: "Steps bars",
    description: "A selected day, weekly date range, and seven daily goal tracks.",
  },
  "pipeline-stage-bars": {
    title: "Pipeline stage bars",
    description: "Stage volume and falloff in one ordered horizontal pipeline.",
  },
  "sleep-score": {
    title: "Sleep score",
    description: "A compact score history with a prominent current summary.",
  },
  "revenue-per-account-scatter": {
    title: "Revenue per account",
    description: "Account-level relationship and scale without collapsing outliers.",
  },
  "tracked-time-sankey": {
    title: "Tracked time",
    description: "Flow from work categories into destinations with weighted connections.",
  },
  "visitors-radial": {
    title: "Visitors radial",
    description: "A focused radial total with a restrained categorical breakdown.",
  },
  "visitors-radar": {
    title: "Visitors radar",
    description: "A multi-dimensional visitor profile on a shared comparable scale.",
  },
  "activity-calendar": {
    title: "Activity calendar",
    description: "Daily intensity arranged in a familiar month calendar.",
  },
  "revenue-smooth-area": {
    title: "Revenue smooth area",
    description: "Continuous revenue movement with a derived headline value.",
  },
  "active-users-heatmap": {
    title: "Active users heatmap",
    description: "Activity concentration across day and time buckets.",
  },
  "sign-up-funnel": {
    title: "Sign-up funnel",
    description: "Conversion and drop-off across ordered onboarding stages.",
  },
  "earned-so-far-bars": {
    title: "Earned so far",
    description: "Cumulative earnings against an optional target or comparison.",
  },
  "contributions-heatmap": {
    title: "Contributions heatmap",
    description: "Long-range daily contribution density in a compact weekly grid.",
  },
  "sessions-conversion-combo": {
    title: "Sessions and conversion",
    description: "Volume bars and conversion trend aligned on the same timeline.",
  },
  "devices-bars": {
    title: "Devices",
    description: "Device share rendered as direct, readable horizontal bars.",
  },
  "visitors-stacked-area": {
    title: "Visitors stacked area",
    description: "Visitor composition and total movement across time.",
  },
  "activity-rings": {
    title: "Activity rings",
    description: "Several bounded progress measures in one compact status surface.",
  },
} satisfies Readonly<Record<ChartRecipeName, ChartRecipeDocumentation>>);

export const generativeGalleryConformanceDescriptors: readonly PreviewDescriptor[] =
  Object.freeze(
    chartRecipeNames.map((recipeName) => Object.freeze({
      kind: "recipe" as const,
      value: recipeName,
    })),
  );

const descriptorKeys = new Set(
  generativeGalleryConformanceDescriptors.map(descriptorKey),
);

export function parsePreviewDescriptor(
  kind: string | null,
  value: string | null,
): PreviewDescriptor {
  if (kind !== "recipe" || value === null) {
    throw new TypeError("Expected a Tessera Agent data.chart recipe descriptor.");
  }
  const descriptor = { kind, value } as PreviewDescriptor;
  if (!descriptorKeys.has(descriptorKey(descriptor))) {
    throw new TypeError(`Unknown Tessera Agent data.chart recipe: ${value}`);
  }
  return Object.freeze(descriptor);
}

export function descriptorKey(descriptor: PreviewDescriptor): string {
  return `${descriptor.kind}:${descriptor.value}`;
}
