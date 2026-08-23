import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AnalysisInsightRenderer,
  AnalysisReportRenderer,
  DataMetricRenderer,
  GridRenderer,
  StackRenderer,
} from "./layout-renderers";

const base = {
  node: { props: {}, slots: {}, events: {}, evidence: [] },
  contract: {},
  stateBindings: {},
  resourceBindings: {},
  placement: { kind: "inline", width: 720, height: 520 },
  projectionMode: "read-only-preview",
} as const;

describe("official analytical composition renderers", () => {
  test("renders a report, layouts, metric, and insight through shadcn primitives", () => {
    const metric = renderToStaticMarkup(<DataMetricRenderer {...base as any} resolvedProps={{
      label: "Revenue",
      data: {
        columns: [{ columnId: "revenue", label: "Revenue", valueType: "number" }],
        rows: [{ revenue: 128400 }],
        hasMore: false,
      },
      valueColumn: "revenue",
      format: "compact",
    }} slots={{}} />);
    const insight = renderToStaticMarkup(<AnalysisInsightRenderer {...base as any} resolvedProps={{
      title: "Growth",
      body: "Revenue increased in the selected period.",
      tone: "positive",
    }} slots={{}} />);
    const stack = renderToStaticMarkup(<StackRenderer {...base as any} resolvedProps={{ gap: "md" }} slots={{ body: [<div key="a">A</div>] }} />);
    const grid = renderToStaticMarkup(<GridRenderer {...base as any} resolvedProps={{ columns: 2, gap: "sm" }} slots={{ body: [<div key="a">A</div>, <div key="b">B</div>] }} />);
    const report = renderToStaticMarkup(<AnalysisReportRenderer {...base as any} resolvedProps={{ title: "Overview", description: "Verified analysis" }} slots={{ body: [<div key="body">Body</div>] }} />);

    expect(metric).toContain('data-slot="card"');
    expect(metric).toContain("128.4K");
    expect(insight).toContain('data-slot="badge"');
    expect(stack).toContain('data-og-component="layout.stack"');
    expect(grid).toContain("--og-grid-columns:2");
    expect(report).toContain('data-og-component="analysis.report"');
  });
});
