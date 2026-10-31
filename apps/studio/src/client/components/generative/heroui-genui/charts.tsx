"use client";

import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { z } from "zod";
import { EvilAreaChart } from "@/components/evilcharts/charts/recharts-area-chart";
import { EvilBarChart } from "@/components/evilcharts/charts/recharts-bar-chart";
import { EvilComposedChart } from "@/components/evilcharts/charts/recharts-composed-chart";
import { EvilLineChart } from "@/components/evilcharts/charts/recharts-line-chart";
import { EvilPieChart } from "@/components/evilcharts/charts/recharts-pie-chart";
import { EvilRadarChart } from "@/components/evilcharts/charts/recharts-radar-chart";
import { EvilRadialChart } from "@/components/evilcharts/charts/recharts-radial-chart";
import { EvilSankeyChart } from "@/components/evilcharts/charts/recharts-sankey-chart";
import type { ChartConfig } from "@/components/evilcharts/ui/recharts-chart";
import type { SankeyData } from "recharts";

type ElementNode = Readonly<{ type: "element"; typeName: string; props: Record<string, unknown> }>;
const chartColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"] as const;
const comparisonColors = ["var(--chart-3)", "var(--chart-1)"] as const;
const partOfWholeColors = ["var(--chart-3)", "var(--chart-1)", "var(--chart-5)", "var(--chart-4)", "var(--text-muted)"] as const;
const SeriesSchema = z.object({ category: z.string(), values: z.array(z.any()) });
const SliceSchema = z.object({ category: z.string(), value: z.any() });
const FlowNodeSchema = z.object({ name: z.string().min(1) });
const FlowLinkSchema = z.object({ source: z.string().min(1), target: z.string().min(1), value: z.number().finite().positive() });

function ChartPlaceholder({ kind }: { kind: string }) {
  return <div aria-hidden="true" data-evilcharts-placeholder={kind} className="h-56 min-h-56 w-full rounded-md bg-muted/25" />;
}

function useDeferChart() {
  return useIsStreaming();
}

export const Series = defineComponent({
  name: "Series",
  props: SeriesSchema,
  description: "One named data series for an EvilCharts chart.",
  component: () => null,
});

export const Slice = defineComponent({
  name: "Slice",
  props: SliceSchema,
  description: "One named value for an EvilCharts pie or radial chart.",
  component: () => null,
});

export const FlowNode = defineComponent({
  name: "FlowNode",
  props: FlowNodeSchema,
  description: "One named stage in an EvilCharts Sankey flow.",
  component: () => null,
});

export const FlowLink = defineComponent({
  name: "FlowLink",
  props: FlowLinkSchema,
  description: "A positive-value flow from one named Sankey stage to another.",
  component: () => null,
});

function nodes(value: unknown, typeName: string): ElementNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ElementNode => (
    item !== null && typeof item === "object" && "type" in item && item.type === "element"
    && "typeName" in item && item.typeName === typeName && "props" in item
  ));
}

function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim()) {
    const result = Number(value);
    return Number.isFinite(result) ? result : 0;
  }
  return 0;
}

function chartSeries(labels: unknown, seriesInput: unknown, colors: readonly string[] = chartColors) {
  const categories = Array.isArray(labels) ? labels.map((label) => String(label ?? "")) : [];
  const source = nodes(seriesInput, "Series");
  const series = source.map((node, index) => ({
    key: `series_${index}`,
    label: String(node.props.category ?? `Series ${index + 1}`),
    values: Array.isArray(node.props.values) ? node.props.values : [],
  }));
  const data = categories.map((category, row) => Object.fromEntries([
    ["category", category],
    ...series.map((item) => [item.key, numeric(item.values[row])]),
  ]));
  const config: ChartConfig = Object.fromEntries(series.map((item, index) => [item.key, {
    label: item.label,
    colors: {
      light: [colors[index % colors.length]!],
      dark: [colors[index % colors.length]!],
    },
  }]));
  return { data, series, config };
}

function pieData(input: unknown) {
  const slices = nodes(input, "Slice").map((node, index) => ({
    key: `slice_${index}`,
    label: String(node.props.category ?? `Slice ${index + 1}`),
    value: numeric(node.props.value),
  }));
  const config: ChartConfig = Object.fromEntries(slices.map((item, index) => [item.key, {
    label: item.label,
    colors: {
      light: [partOfWholeColors[index % partOfWholeColors.length]!],
      dark: [partOfWholeColors[index % partOfWholeColors.length]!],
    },
  }]));
  return { data: slices.map((item) => ({ name: item.key, value: item.value })), config };
}

function sankeyData(nodesInput: unknown, linksInput: unknown) {
  const seen = new Set<string>();
  const sourceNodes = nodes(nodesInput, "FlowNode").flatMap((node) => {
    const name = String(node.props.name ?? "").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ name }];
  });
  const nodeIndexes = new Map(sourceNodes.map((node, index) => [node.name, index]));
  const links = nodes(linksInput, "FlowLink").flatMap((node) => {
    const source = nodeIndexes.get(String(node.props.source ?? ""));
    const target = nodeIndexes.get(String(node.props.target ?? ""));
    const value = numeric(node.props.value);
    if (source === undefined || target === undefined || value <= 0) return [];
    return [{ source, target, value }];
  });
  const config: ChartConfig = Object.fromEntries(sourceNodes.map((node, index) => [node.name, {
    label: node.name,
    colors: {
      light: [chartColors[index % chartColors.length]!],
      dark: [chartColors[index % chartColors.length]!],
    },
  }]));
  return { data: { nodes: sourceNodes, links } satisfies SankeyData, config };
}

function axes(dataKey = "category") {
  return <>
    <EvilBarChart.Grid />
    <EvilBarChart.XAxis dataKey={dataKey} />
    <EvilBarChart.YAxis />
    <EvilBarChart.Tooltip />
    <EvilBarChart.Legend />
  </>;
}

export const BarChart = defineComponent({
  name: "BarChart",
  props: z.object({
    labels: z.array(z.string()), series: z.array(SeriesSchema),
    variant: z.enum(["grouped", "stacked"]).optional(), xLabel: z.string().optional(), yLabel: z.string().optional(),
  }),
  description: "EvilCharts bar chart. Compare categories with one or more named series.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="bar" />;
    const chart = chartSeries(props.labels, props.series);
    if (!chart.data.length || !chart.series.length) return null;
    return <div data-evilcharts-chart="bar"><EvilBarChart data={chart.data} config={chart.config} className="h-56 min-h-56 w-full" animationType="none" stackType={props.variant === "stacked" ? "stacked" : "default"}>
      {axes()}
      {chart.series.map((item) => <EvilBarChart.Bar key={item.key} dataKey={item.key} />)}
    </EvilBarChart></div>;
  },
});

export const LineChart = defineComponent({
  name: "LineChart",
  props: z.object({ labels: z.array(z.string()), series: z.array(SeriesSchema), xLabel: z.string().optional(), yLabel: z.string().optional() }),
  description: "EvilCharts line chart. Track change over time with styled lines, dots and a legend.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="line" />;
    const chart = chartSeries(props.labels, props.series);
    if (!chart.data.length || !chart.series.length) return null;
    return <div data-evilcharts-chart="line"><EvilLineChart data={chart.data} config={chart.config} className="h-56 min-h-56 w-full" animationType="none">
      <EvilLineChart.Grid /> <EvilLineChart.XAxis dataKey="category" /> <EvilLineChart.YAxis />
      <EvilLineChart.Tooltip /> <EvilLineChart.Legend />
      {chart.series.map((item) => <EvilLineChart.Line key={item.key} dataKey={item.key} />)}
    </EvilLineChart></div>;
  },
});

export const AreaChart = defineComponent({
  name: "AreaChart",
  props: z.object({ labels: z.array(z.string()), series: z.array(SeriesSchema), xLabel: z.string().optional(), yLabel: z.string().optional() }),
  description: "EvilCharts area chart. Show volume and trends with gradient filled areas.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="area" />;
    const chart = chartSeries(props.labels, props.series);
    if (!chart.data.length || !chart.series.length) return null;
    return <div data-evilcharts-chart="area"><EvilAreaChart data={chart.data} config={chart.config} className="h-56 min-h-56 w-full" animationType="none">
      <EvilAreaChart.Grid /> <EvilAreaChart.XAxis dataKey="category" /> <EvilAreaChart.YAxis />
      <EvilAreaChart.Tooltip /> <EvilAreaChart.Legend />
      {chart.series.map((item) => <EvilAreaChart.Area key={item.key} dataKey={item.key} />)}
    </EvilAreaChart></div>;
  },
});

export const PieChart = defineComponent({
  name: "PieChart",
  props: z.object({ slices: z.array(SliceSchema), donut: z.boolean().optional() }),
  description: "EvilCharts pie or donut chart. Show parts of a whole with a legend and tooltip.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="pie" />;
    const chart = pieData(props.slices);
    if (!chart.data.length) return null;
    return <div data-evilcharts-chart="pie"><EvilPieChart data={chart.data} config={chart.config} dataKey="value" nameKey="name" className="h-56 min-h-56 w-full">
      <EvilPieChart.Pie innerRadius={props.donut ? "52%" : undefined} />
      <EvilPieChart.Tooltip /> <EvilPieChart.Legend />
    </EvilPieChart></div>;
  },
});

export const RadarChart = defineComponent({
  name: "RadarChart",
  props: z.object({ labels: z.array(z.string()), series: z.array(SeriesSchema) }),
  description: "EvilCharts radar chart for comparing multi-metric profiles.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="radar" />;
    const chart = chartSeries(props.labels, props.series, comparisonColors);
    if (!chart.data.length || !chart.series.length) return null;
    return <div data-evilcharts-chart="radar"><EvilRadarChart data={chart.data} config={chart.config} className="h-56 min-h-56 w-full">
      <EvilRadarChart.PolarGrid /> <EvilRadarChart.PolarAngleAxis dataKey="category" />
      <EvilRadarChart.Tooltip /> <EvilRadarChart.Legend />
      {chart.series.map((item) => <EvilRadarChart.Radar key={item.key} dataKey={item.key} />)}
    </EvilRadarChart></div>;
  },
});

export const RadialChart = defineComponent({
  name: "RadialChart",
  props: z.object({ slices: z.array(SliceSchema) }),
  description: "EvilCharts radial chart for comparing named values in a circular layout.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="radial" />;
    const chart = pieData(props.slices);
    if (!chart.data.length) return null;
    return <div data-evilcharts-chart="radial"><EvilRadialChart data={chart.data.map((item) => ({ ...item, value: item.value }))} config={chart.config} nameKey="name" className="h-56 min-h-56 w-full">
      <EvilRadialChart.RadialBar dataKey="value" />
      <EvilRadialChart.Tooltip /> <EvilRadialChart.Legend />
    </EvilRadialChart></div>;
  },
});

export const SankeyChart = defineComponent({
  name: "SankeyChart",
  props: z.object({
    nodes: z.array(FlowNodeSchema),
    links: z.array(FlowLinkSchema),
    nodePadding: z.number().int().min(0).max(48).optional(),
  }),
  description: "EvilCharts Sankey chart for showing how values flow between named stages. Every FlowLink source and target must match a FlowNode name.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="sankey" />;
    const chart = sankeyData(props.nodes, props.links);
    if (chart.data.nodes.length < 2 || chart.data.links.length === 0) return null;
    return <div data-evilcharts-chart="sankey"><EvilSankeyChart data={chart.data} config={chart.config} className="h-64 min-h-64 w-full" nodePadding={props.nodePadding}>
      <EvilSankeyChart.Node isClickable><EvilSankeyChart.NodeLabel position="outside" showValues /></EvilSankeyChart.Node>
      <EvilSankeyChart.Link />
      <EvilSankeyChart.Tooltip />
    </EvilSankeyChart></div>;
  },
});

export const ComposedChart = defineComponent({
  name: "ComposedChart",
  props: z.object({ labels: z.array(z.string()), series: z.array(SeriesSchema), xLabel: z.string().optional(), yLabel: z.string().optional() }),
  description: "EvilCharts composed chart combining bars and lines for the same categories.",
  component: ({ props }) => {
    if (useDeferChart()) return <ChartPlaceholder kind="composed" />;
    const chart = chartSeries(props.labels, props.series, comparisonColors);
    if (!chart.data.length || !chart.series.length) return null;
    return <div data-evilcharts-chart="composed"><EvilComposedChart data={chart.data} config={chart.config} className="h-56 min-h-56 w-full" animationType="none">
      <EvilComposedChart.Grid /> <EvilComposedChart.XAxis dataKey="category" /> <EvilComposedChart.YAxis />
      <EvilComposedChart.Tooltip /> <EvilComposedChart.Legend />
      {chart.series.map((item, index) => index === 0
        ? <EvilComposedChart.Bar key={item.key} dataKey={item.key} />
        : <EvilComposedChart.Line key={item.key} dataKey={item.key} />)}
    </EvilComposedChart></div>;
  },
});
