import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { ApiReference, CodeDiff, CodeExample, ComponentPreview, InstallCommand } from "./component-docs";
import { AnomalyDemo, ArtifactPrimitivesDemo, BreakdownDemo, CalculatorDemo, ChartDemo, CohortDemo, ComparisonDemo, DataQualityDemo, DistributionDemo, DriverDemo, ExperimentDemo, ForecastDemo, FunnelDemo, InsightDemo, MetricsDemo, QueryDemo, RankingDemo, TableDemo, TargetDemo, TimelineDemo, TrendDemo } from "./examples";
import { LocalizedCard } from "./localized-card";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ApiReference,
    AnomalyDemo,
    ArtifactPrimitivesDemo,
    BreakdownDemo,
    CalculatorDemo,
    Card: LocalizedCard,
    ChartDemo,
    CohortDemo,
    CodeDiff,
    CodeExample,
    ComparisonDemo,
    ComponentPreview,
    DataQualityDemo,
    DistributionDemo,
    DriverDemo,
    ExperimentDemo,
    ForecastDemo,
    FunnelDemo,
    InsightDemo,
    InstallCommand,
    MetricsDemo,
    QueryDemo,
    RankingDemo,
    TableDemo,
    TargetDemo,
    TimelineDemo,
    TrendDemo,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global { type MDXProvidedComponents = ReturnType<typeof getMDXComponents>; }
