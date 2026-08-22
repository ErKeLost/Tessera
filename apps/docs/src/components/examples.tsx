"use client";

import type {
  AnomalyArtifact,
  BreakdownArtifact,
  CalculatorArtifact,
  CohortArtifact,
  ComparisonArtifact,
  DataQualityArtifact,
  DistributionArtifact,
  DriverArtifact,
  ExperimentArtifact,
  ForecastArtifact,
  FunnelArtifact,
  InsightArtifact,
  MetricArtifact,
  QueryArtifact,
  RankingArtifact,
  TargetArtifact,
  TimelineArtifact,
  TrendArtifact,
} from "@open-tessera/schema";
import type { ReactNode } from "react";
import {
  AnomalyArtifact as AnomalyArtifactView,
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
  BreakdownArtifact as BreakdownArtifactView,
  CalculatorArtifact as CalculatorArtifactView,
  CohortArtifact as CohortArtifactView,
  ComparisonArtifact as ComparisonArtifactView,
  DataChart,
  ArtifactUIProvider,
  DataQualityArtifact as DataQualityArtifactView,
  DataTable,
  DistributionArtifact as DistributionArtifactView,
  DriverArtifact as DriverArtifactView,
  ExperimentArtifact as ExperimentArtifactView,
  ForecastArtifact as ForecastArtifactView,
  FunnelArtifact as FunnelArtifactView,
  InsightArtifact as InsightArtifactView,
  MetricArtifact as MetricArtifactView,
  QueryArtifact as QueryArtifactView,
  RankingArtifact as RankingArtifactView,
  TargetArtifact as TargetArtifactView,
  TimelineArtifact as TimelineArtifactView,
  TrendArtifact as TrendArtifactView,
} from "@open-generative/ui";

const query: QueryArtifact = {
  protocolVersion: "1.0",
  kind: "query",
  id: "example-query",
  title: "Credit flow",
  description: "Last 30 days · daily completed transactions",
  metricDefinition:
    "Sum of completed Credit ledger transactions grouped by business day.",
  timeZone: "Asia/Shanghai",
  filters: ["status = completed"],
  warnings: [],
  sql: "select date_trunc('day', created_at) as day, sum(amount) as credits from analytics.credit_ledger group by 1 order by 1;",
  columns: [
    { key: "day", label: "Day", type: "date", format: "plain" },
    { key: "credits", label: "Credits", type: "number", format: "compact" },
  ],
  rows: Array.from({ length: 30 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 6, 14 + index, 9)).toISOString(),
    credits: Math.round(
      5000 + Math.sin(index / 2.2) * 2700 + (index % 5) * 600,
    ),
  })),
  rowCount: 30,
  truncated: false,
  durationMs: 760,
  queriedAt: "2026-08-12T09:03:00.000Z",
  sourceTables: ["analytics.credit_ledger"],
  chart: { kind: "area", xKey: "day", yKeys: ["credits"] },
};

const calculator: CalculatorArtifact = {
  protocolVersion: "1.0",
  kind: "calculator",
  id: "example-calculator",
  title: "Compound interest",
  description: "Move the controls to explore future value.",
  calculatorId: "compound-interest",
  initialValues: { principal: 10000, rate: 5, years: 20 },
  currency: "USD",
  locale: "en-US",
};
const metrics: MetricArtifact = {
  protocolVersion: "1.0",
  kind: "metric",
  id: "example-metrics",
  title: "Workspace health",
  description: "A compact operational snapshot.",
  metrics: [
    {
      id: "revenue",
      label: "Monthly revenue",
      value: 128400,
      format: "currency",
      currency: "USD",
      change: 12.4,
      changeLabel: "vs previous month",
    },
    {
      id: "activation",
      label: "Activation",
      value: 68.2,
      format: "percent",
      change: 3.8,
      changeLabel: "vs previous month",
    },
    {
      id: "runs",
      label: "Agent runs",
      value: 18420,
      format: "compact",
      change: -2.1,
      changeLabel: "vs previous month",
    },
  ],
  footnote: "Updated 4 minutes ago from approved sources.",
};
const comparison: ComparisonArtifact = {
  protocolVersion: "1.0",
  kind: "comparison",
  id: "example-comparison",
  title: "Choose a warehouse",
  description:
    "A stable comparison across the criteria that matter for this workload.",
  subjectLabel: "Criteria",
  subjects: [
    { id: "snowflake", label: "Snowflake" },
    { id: "bigquery", label: "BigQuery" },
    { id: "clickhouse", label: "ClickHouse" },
  ],
  criteria: [
    {
      id: "latency",
      label: "Interactive latency",
      values: { snowflake: "Low", bigquery: "Low", clickhouse: "Very low" },
      winnerId: "clickhouse",
    },
    {
      id: "ops",
      label: "Operations",
      values: {
        snowflake: "Managed",
        bigquery: "Managed",
        clickhouse: "Self-managed",
      },
      winnerId: "snowflake",
    },
    {
      id: "cost",
      label: "Cost shape",
      values: { snowflake: "Usage", bigquery: "Usage", clickhouse: "Compute" },
    },
  ],
  recommendation:
    "Start with Snowflake when your team values managed operations; choose ClickHouse for sustained, latency-sensitive exploration.",
};
const trend: TrendArtifact = {
  protocolVersion: "1.0",
  kind: "trend",
  id: "example-trend",
  title: "Activation trend",
  description: "Weekly activation across the last twelve weeks.",
  metricLabel: "Activated workspaces",
  format: "compact",
  change: 18.6,
  changeLabel: "over 12 weeks",
  target: 8500,
  points: Array.from({ length: 12 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 4, 25 + index * 7)).toISOString(),
    value: Math.round(5600 + index * 240 + Math.sin(index * 1.3) * 420),
  })),
  insight:
    "Activation accelerated after the guided onboarding experiment launched in week seven.",
};
const anomaly: AnomalyArtifact = {
  protocolVersion: "1.0",
  kind: "anomaly",
  id: "example-anomaly",
  title: "Revenue anomalies",
  description: "Prioritized deviations from the expected daily baseline.",
  format: "currency",
  currency: "USD",
  summary:
    "Three material changes require review; the largest is concentrated in enterprise renewals.",
  anomalies: [
    {
      id: "renewals",
      label: "Enterprise renewals",
      timestamp: "2026-08-12T08:00:00.000Z",
      severity: "high",
      actual: 184200,
      expected: 126000,
      deviation: 46.2,
      explanation:
        "Two annual renewals landed earlier than their modeled billing dates.",
    },
    {
      id: "self-serve",
      label: "Self-serve upgrades",
      timestamp: "2026-08-11T08:00:00.000Z",
      severity: "medium",
      actual: 58400,
      expected: 67700,
      deviation: -13.7,
      explanation:
        "Upgrade completion fell after a payment-provider latency incident.",
    },
    {
      id: "refunds",
      label: "Refund volume",
      timestamp: "2026-08-10T08:00:00.000Z",
      severity: "low",
      actual: 8400,
      expected: 7600,
      deviation: 10.5,
    },
  ],
  nextStep: "Review enterprise renewal timing",
};
const forecast: ForecastArtifact = {
  protocolVersion: "1.0",
  kind: "forecast",
  id: "example-forecast",
  title: "Revenue forecast",
  description: "Observed monthly revenue and the next-quarter projection.",
  metricLabel: "Monthly revenue",
  format: "currency",
  currency: "USD",
  confidenceLevel: 90,
  horizon: "3 months",
  method: "Seasonal exponential smoothing",
  target: 185000,
  points: Array.from({ length: 10 }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, index, 1)).toISOString();
    const baseline = 118000 + index * 6500 + Math.sin(index) * 5200;
    return index < 7
      ? { timestamp, actual: Math.round(baseline) }
      : {
          timestamp,
          forecast: Math.round(baseline),
          lower: Math.round(baseline * 0.91),
          upper: Math.round(baseline * 1.09),
        };
  }),
};
const funnel: FunnelArtifact = {
  protocolVersion: "1.0",
  kind: "funnel",
  id: "example-funnel",
  title: "Activation funnel",
  description: "From workspace creation to the first successful agent run.",
  steps: [
    {
      id: "created",
      label: "Workspace created",
      value: 18240,
      note: "100% entry",
    },
    {
      id: "connected",
      label: "Data source connected",
      value: 13680,
      conversionFromPrevious: 75,
    },
    {
      id: "query",
      label: "First query completed",
      value: 9840,
      conversionFromPrevious: 71.9,
    },
    {
      id: "agent",
      label: "First agent run",
      value: 7210,
      conversionFromPrevious: 73.3,
    },
  ],
  footnote: "Cohort: workspaces created in the last 30 days.",
};
const dataQuality: DataQualityArtifact = {
  protocolVersion: "1.0",
  kind: "data-quality",
  id: "example-quality",
  title: "Orders data quality",
  description:
    "Freshness, completeness, and integrity checks for the production model.",
  score: 92.4,
  source: "analytics.fact_orders",
  updatedAt: "2026-08-12T09:18:00.000Z",
  checks: [
    {
      id: "freshness",
      label: "Freshness",
      status: "passed",
      detail: "Latest partition arrived within the 30 minute SLA.",
      observed: "18 min",
      threshold: "30 min",
    },
    {
      id: "null-rate",
      label: "Customer ID completeness",
      status: "warning",
      detail: "The null rate increased above the preferred operating range.",
      observed: 0.9,
      threshold: 0.5,
    },
    {
      id: "uniqueness",
      label: "Order key uniqueness",
      status: "passed",
      detail: "No duplicate order keys were detected.",
      observed: 100,
      threshold: 100,
    },
    {
      id: "amount",
      label: "Order amount validity",
      status: "failed",
      detail: "Seven negative amounts lack a matching refund event.",
      observed: 7,
      threshold: 0,
    },
  ],
};
const insight: InsightArtifact = {
  protocolVersion: "1.0",
  kind: "insight",
  id: "example-insight",
  title: "What changed this week",
  description: "Evidence-backed findings distilled from trusted metrics.",
  insights: [
    {
      id: "activation",
      headline: "Activation improved in assisted onboarding",
      detail:
        "Teams using the connection checklist reached a first successful query 1.8 days faster.",
      evidence: "Activation: 71.4% vs 62.0% · n=1,842 workspaces",
    },
    {
      id: "retention",
      headline: "Scheduled runs correlate with retention",
      detail:
        "Accounts creating a schedule in week one were substantially more likely to return in week four.",
      evidence: "Week-four retention: 68% scheduled vs 41% unscheduled",
    },
    {
      id: "latency",
      headline: "Warehouse latency is now the main drop-off driver",
      detail:
        "Most failed first runs came from queries exceeding the interactive timeout.",
      evidence: "42% of failed first runs exceeded 30 seconds",
    },
  ],
  recommendedAction: "Open the onboarding experiment brief",
};
const breakdown: BreakdownArtifact = {
  protocolVersion: "1.0",
  kind: "breakdown",
  id: "example-breakdown",
  title: "Revenue by acquisition channel",
  description: "Completed subscription revenue in the last 30 days.",
  dimensionLabel: "Channel",
  metricLabel: "Revenue",
  format: "currency",
  currency: "USD",
  total: 472_860,
  items: [
    {
      id: "organic",
      label: "Organic search",
      value: 164_820,
      share: 34.9,
      change: 14.2,
      note: "Enterprise comparison pages led growth",
    },
    {
      id: "partners",
      label: "Technology partners",
      value: 118_640,
      share: 25.1,
      change: 8.6,
    },
    {
      id: "paid",
      label: "Paid search",
      value: 96_410,
      share: 20.4,
      change: -5.3,
      note: "Brand campaigns remained efficient",
    },
    { id: "direct", label: "Direct", value: 61_870, share: 13.1, change: 2.4 },
    {
      id: "community",
      label: "Community",
      value: 31_120,
      share: 6.6,
      change: 19.8,
    },
  ],
  insight:
    "Organic search and partners produced 60.0% of revenue; paid search was the only declining major channel.",
};
const distribution: DistributionArtifact = {
  protocolVersion: "1.0",
  kind: "distribution",
  id: "example-distribution",
  title: "Interactive query latency",
  description:
    "Duration of successful warehouse queries over the last seven days.",
  metricLabel: "Query latency (seconds)",
  format: "number",
  bins: [
    { id: "0-1", label: "0–1s", min: 0, max: 1, count: 316 },
    { id: "1-2", label: "1–2s", min: 1, max: 2, count: 842 },
    { id: "2-3", label: "2–3s", min: 2, max: 3, count: 1194 },
    { id: "3-5", label: "3–5s", min: 3, max: 5, count: 923 },
    { id: "5-8", label: "5–8s", min: 5, max: 8, count: 431 },
    { id: "8-15", label: "8–15s", min: 8, max: 15, count: 177 },
    { id: "15-30", label: "15–30s", min: 15, max: 30, count: 68 },
    { id: "30-60", label: "30–60s", min: 30, max: 60, count: 27 },
  ],
  summary: {
    count: 3978,
    min: 0.18,
    p25: 1.8,
    median: 2.9,
    mean: 4.7,
    p75: 5.1,
    max: 58.4,
  },
  outlierCount: 41,
  insight:
    "The mean sits above the median because a small long-running tail pulls latency upward.",
};
const cohort: CohortArtifact = {
  protocolVersion: "1.0",
  kind: "cohort",
  id: "example-cohort",
  title: "Workspace retention",
  description: "Weekly active retention aligned by workspace creation week.",
  metricLabel: "Active workspace retention",
  periods: ["W0", "W1", "W2", "W3", "W4", "W5"],
  cohorts: [
    {
      id: "jun-29",
      label: "Jun 29",
      size: 842,
      values: [100, 72.4, 61.8, 55.1, 49.7, 46.2],
    },
    {
      id: "jul-06",
      label: "Jul 06",
      size: 911,
      values: [100, 73.1, 63.4, 57.8, 53.2, 49.1],
    },
    {
      id: "jul-13",
      label: "Jul 13",
      size: 876,
      values: [100, 75.8, 66.9, 61.4, 56.7, null],
    },
    {
      id: "jul-20",
      label: "Jul 20",
      size: 1024,
      values: [100, 78.2, 69.6, 64.8, null, null],
    },
    {
      id: "jul-27",
      label: "Jul 27",
      size: 1088,
      values: [100, 79.4, 71.3, null, null, null],
    },
  ],
  insight:
    "Week-one retention improved after guided onboarding launched in the Jul 20 cohort; recent periods remain incomplete.",
};
const experiment: ExperimentArtifact = {
  protocolVersion: "1.0",
  kind: "experiment",
  id: "example-experiment",
  title: "Guided onboarding experiment",
  description:
    "Primary outcome measured within seven days of workspace creation.",
  metricLabel: "Activation rate",
  format: "percent",
  control: {
    id: "control",
    label: "Existing onboarding",
    sampleSize: 4812,
    value: 61.2,
  },
  treatment: {
    id: "treatment",
    label: "Guided onboarding",
    sampleSize: 4764,
    value: 66.8,
  },
  effect: {
    absolute: 5.6,
    relative: 9.2,
    ciLower: 3.1,
    ciUpper: 8.1,
    confidenceLevel: 95,
    pValue: 0.002,
    significant: true,
  },
  method: "Two-proportion z-test",
  guardrails: [
    {
      id: "query-latency",
      label: "First-query latency",
      status: "passed",
      detail: "No material change",
    },
    {
      id: "support",
      label: "Support contact rate",
      status: "warning",
      detail: "+0.8 pp, below the 1.0 pp limit",
    },
  ],
  conclusion:
    "The treatment improved activation with a positive 95% interval; keep monitoring support demand during rollout.",
};
const driver: DriverArtifact = {
  protocolVersion: "1.0",
  kind: "driver",
  id: "example-driver",
  title: "What moved monthly recurring revenue",
  description: "Additive bridge from July close to August close.",
  metricLabel: "Monthly recurring revenue",
  format: "currency",
  currency: "USD",
  startLabel: "July",
  startValue: 428000,
  endLabel: "August",
  endValue: 461400,
  drivers: [
    {
      id: "new",
      label: "New business",
      value: 48200,
      note: "92 new paid workspaces",
    },
    {
      id: "expansion",
      label: "Expansion",
      value: 11900,
      note: "Seat and usage upgrades",
    },
    { id: "contraction", label: "Contraction", value: -11900 },
    {
      id: "churn",
      label: "Churn",
      value: -14800,
      note: "Concentrated in self-serve annual plans",
    },
  ],
  footnote:
    "Drivers reconcile exactly to the August close. Values are recognized MRR, not bookings.",
};
const ranking: RankingArtifact = {
  protocolVersion: "1.0",
  kind: "ranking",
  id: "example-ranking",
  title: "Pipeline by acquisition channel",
  description: "Qualified pipeline created in the current quarter.",
  metricLabel: "Qualified pipeline",
  format: "currency",
  currency: "USD",
  highlightId: "partners",
  items: [
    {
      id: "organic",
      rank: 1,
      label: "Organic search",
      value: 2840000,
      change: 14.8,
      note: "Enterprise comparison pages",
    },
    {
      id: "partners",
      rank: 2,
      label: "Technology partners",
      value: 2310000,
      change: 22.4,
      note: "Fastest-growing channel",
    },
    {
      id: "events",
      rank: 3,
      label: "Field events",
      value: 1760000,
      change: 5.1,
    },
    {
      id: "paid",
      rank: 4,
      label: "Paid search",
      value: 1420000,
      change: -3.7,
      note: "Brand terms remain efficient",
    },
    {
      id: "community",
      rank: 5,
      label: "Community",
      value: 980000,
      change: 9.6,
    },
  ],
  insight:
    "Partners moved into second place and contributed the largest quarter-over-quarter increase.",
};
const target: TargetArtifact = {
  protocolVersion: "1.0",
  kind: "target",
  id: "example-target",
  title: "AI resolution target",
  description: "Share of support conversations resolved without escalation.",
  metricLabel: "AI resolution rate",
  actual: 71.8,
  target: 75,
  baseline: 63.2,
  direction: "higher-is-better",
  status: "on-track",
  format: "percent",
  deadline: "2026-09-30T23:59:59.000Z",
  insight:
    "The team has closed 74% of the gap from the Q2 baseline; billing intents remain the largest opportunity.",
};
const timeline: TimelineArtifact = {
  protocolVersion: "1.0",
  kind: "timeline",
  id: "example-timeline",
  title: "Enterprise rollout",
  description: "Validated milestones for the North America launch.",
  order: "ascending",
  timeZone: "America/New_York",
  events: [
    {
      id: "design",
      timestamp: "2026-07-08T14:00:00.000Z",
      label: "Control design approved",
      description: "Security and finance approved the production control set.",
      status: "completed",
      actor: "Risk council",
    },
    {
      id: "pilot",
      timestamp: "2026-07-22T15:30:00.000Z",
      label: "Pilot completed",
      description: "Twelve design partners completed the governed workflow.",
      status: "completed",
      actor: "Customer success",
    },
    {
      id: "migration",
      timestamp: "2026-08-18T13:00:00.000Z",
      label: "Tenant migration",
      description:
        "Move the first production cohort onto the regional data plane.",
      status: "in-progress",
      actor: "Platform operations",
    },
    {
      id: "review",
      timestamp: "2026-08-25T16:00:00.000Z",
      label: "Readiness review",
      description:
        "Confirm support coverage, rollback evidence, and launch communications.",
      status: "planned",
      actor: "Launch council",
    },
    {
      id: "launch",
      timestamp: "2026-09-02T13:00:00.000Z",
      label: "General availability",
      description:
        "Enable the governed enterprise workflow for eligible tenants.",
      status: "planned",
    },
  ],
};

function DemoProvider({ children }: { children: ReactNode }) {
  return (
    <ArtifactUIProvider
      onAction={(event) => console.info("Tessera Agent action", event)}
    >
      {children}
    </ArtifactUIProvider>
  );
}

export function QueryDemo() {
  return (
    <DemoProvider>
      <QueryArtifactView artifact={query} />
    </DemoProvider>
  );
}
export function CalculatorDemo() {
  return (
    <DemoProvider>
      <CalculatorArtifactView artifact={calculator} />
    </DemoProvider>
  );
}
export function MetricsDemo() {
  return (
    <DemoProvider>
      <MetricArtifactView artifact={metrics} />
    </DemoProvider>
  );
}
export function ComparisonDemo() {
  return (
    <DemoProvider>
      <ComparisonArtifactView artifact={comparison} />
    </DemoProvider>
  );
}
export function TrendDemo() {
  return (
    <DemoProvider>
      <TrendArtifactView artifact={trend} />
    </DemoProvider>
  );
}
export function AnomalyDemo() {
  return (
    <DemoProvider>
      <AnomalyArtifactView artifact={anomaly} />
    </DemoProvider>
  );
}
export function ForecastDemo() {
  return (
    <DemoProvider>
      <ForecastArtifactView artifact={forecast} />
    </DemoProvider>
  );
}
export function FunnelDemo() {
  return (
    <DemoProvider>
      <FunnelArtifactView artifact={funnel} />
    </DemoProvider>
  );
}
export function DataQualityDemo() {
  return (
    <DemoProvider>
      <DataQualityArtifactView artifact={dataQuality} />
    </DemoProvider>
  );
}
export function InsightDemo() {
  return (
    <DemoProvider>
      <InsightArtifactView artifact={insight} />
    </DemoProvider>
  );
}
export function BreakdownDemo() {
  return (
    <DemoProvider>
      <BreakdownArtifactView artifact={breakdown} />
    </DemoProvider>
  );
}
export function DistributionDemo() {
  return (
    <DemoProvider>
      <DistributionArtifactView artifact={distribution} />
    </DemoProvider>
  );
}
export function CohortDemo() {
  return (
    <DemoProvider>
      <CohortArtifactView artifact={cohort} />
    </DemoProvider>
  );
}
export function ExperimentDemo() {
  return (
    <DemoProvider>
      <ExperimentArtifactView artifact={experiment} />
    </DemoProvider>
  );
}
export function DriverDemo() {
  return (
    <DemoProvider>
      <DriverArtifactView artifact={driver} />
    </DemoProvider>
  );
}
export function RankingDemo() {
  return (
    <DemoProvider>
      <RankingArtifactView artifact={ranking} />
    </DemoProvider>
  );
}
export function TargetDemo() {
  return (
    <DemoProvider>
      <TargetArtifactView artifact={target} />
    </DemoProvider>
  );
}
export function TimelineDemo() {
  return (
    <DemoProvider>
      <TimelineArtifactView artifact={timeline} />
    </DemoProvider>
  );
}
export function ChartDemo({ height = 250 }: { height?: number }) {
  return <DataChart chart={query.chart} height={height} rows={query.rows} />;
}
export function TableDemo() {
  return <DataTable artifact={query} pageSize={5} />;
}
export function ArtifactPrimitivesDemo() {
  return (
    <Artifact>
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ArtifactTitle>Revenue analysis</ArtifactTitle>
            <ArtifactStatus>Ready</ArtifactStatus>
          </div>
          <ArtifactDescription>
            Generated from approved warehouse sources.
          </ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent className="p-6">
        <p className="text-sm font-medium">Your trusted renderer goes here.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Compose the frame with charts, tables, metrics, or a custom catalog
          renderer.
        </p>
      </ArtifactContent>
    </Artifact>
  );
}
