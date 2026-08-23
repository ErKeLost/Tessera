import type { JsonObject } from "@open-generative/protocol";
import type { RendererInput } from "@open-generative/react";
import type {
  AnalysisInsightProps,
  AnalysisReportProps,
  DataMetricProps,
  LayoutGridProps,
  LayoutStackProps,
} from "@open-generative/components";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import type { CSSProperties } from "react";

type Input<T extends JsonObject> = RendererInput<T>;

export function AnalysisReportRenderer(input: Input<AnalysisReportProps>) {
  const { title, description } = input.resolvedProps;
  return <section className="og-ui og-analysis-report" data-og-component="analysis.report" aria-label={title}>
    <Card className="og-analysis-report-card">
      <CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader>
      <CardContent className="og-analysis-report-body">{input.slots.body}</CardContent>
    </Card>
  </section>;
}

export function StackRenderer(input: Input<LayoutStackProps>) {
  return <div className={`og-ui og-layout-stack og-gap-${input.resolvedProps.gap}`} data-og-component="layout.stack" role="group">{input.slots.body}</div>;
}

export function GridRenderer(input: Input<LayoutGridProps>) {
  return <div className={`og-ui og-layout-grid og-gap-${input.resolvedProps.gap}`} style={{ "--og-grid-columns": input.resolvedProps.columns } as CSSProperties} data-og-component="layout.grid" role="group">{input.slots.body}</div>;
}

export function DataMetricRenderer(input: Input<DataMetricProps>) {
  const { label, data, valueColumn, format } = input.resolvedProps;
  const column = valueColumn ?? data.columns.find((candidate) => candidate.valueType === "number")?.columnId;
  const value = data.rows[0]?.[column ?? ""];
  const formatted = typeof value === "number"
    ? format === "percent" ? `${(value * 100).toFixed(1)}%` : format === "compact" ? Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value) : Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
    : value === null || value === undefined ? "-" : String(value);
  return <Card className="og-metric-card" data-og-component="data.metric" aria-label={label}>
    <CardHeader><CardDescription>{label}</CardDescription></CardHeader>
    <CardContent><div className="og-metric-value">{formatted}</div></CardContent>
  </Card>;
}

export function AnalysisInsightRenderer(input: Input<AnalysisInsightProps>) {
  const { title, body, tone } = input.resolvedProps;
  return <Card className="og-insight-card" data-og-component="analysis.insight" data-tone={tone} role="status">
    <CardHeader><div className="og-insight-heading"><CardTitle>{title}</CardTitle><Badge variant={tone === "positive" ? "positive" : "secondary"}>{tone}</Badge></div></CardHeader>
    <CardContent><p className="og-insight-body">{body}</p></CardContent>
  </Card>;
}
