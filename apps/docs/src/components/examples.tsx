"use client";

import {
  ChartRecipeDemo,
  ComponentContractDemo,
  DataAgentAnalysisDemo,
  DataAgentFilterDemo,
  DataAgentMetricsDemo,
} from "./generative-gallery";

export { ComponentContractDemo };

export function QueryDemo() {
  return <DataAgentAnalysisDemo />;
}

export function CalculatorDemo() {
  return <DataAgentFilterDemo />;
}

export function MetricsDemo() {
  return <DataAgentMetricsDemo />;
}

export function ComparisonDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-multiple" />;
}

export function TrendDemo() {
  return <ChartRecipeDemo recipeName="chart-line-default" />;
}

export function AnomalyDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-negative" />;
}

export function ForecastDemo() {
  return <ChartRecipeDemo recipeName="chart-area-gradient" />;
}

export function FunnelDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-horizontal" />;
}

export function DataQualityDemo() {
  return <ComponentContractDemo componentType="content.callout" />;
}

export function InsightDemo() {
  return <ComponentContractDemo componentType="content.callout" />;
}

export function BreakdownDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-stacked" />;
}

export function DistributionDemo() {
  return <ChartRecipeDemo recipeName="chart-pie-simple" />;
}

export function CohortDemo() {
  return <ChartRecipeDemo recipeName="chart-area-stacked" />;
}

export function ExperimentDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-multiple" />;
}

export function DriverDemo() {
  return <ChartRecipeDemo recipeName="chart-bar-negative" />;
}

export function RankingDemo() {
  return <ComponentContractDemo componentType="data.table" />;
}

export function TargetDemo() {
  return <ComponentContractDemo componentType="data.metric" />;
}

export function TimelineDemo() {
  return <ComponentContractDemo componentType="data.query-details" />;
}

export function ChartDemo({ height = 250 }: { height?: number }) {
  return (
    <div style={{ minHeight: height }}>
      <ChartRecipeDemo recipeName="chart-area-default" />
    </div>
  );
}

export function TableDemo() {
  return <ComponentContractDemo componentType="data.table" />;
}

export function ArtifactPrimitivesDemo() {
  return <DataAgentAnalysisDemo />;
}
