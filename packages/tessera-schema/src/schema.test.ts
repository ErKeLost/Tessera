import { describe, expect, test } from "bun:test";
import {
  V1_PROTOCOL_LIMITS,
  artifactActionEventSchema,
  artifactKinds,
  artifactSchemas,
  safeParseArtifact,
  safeParseBuiltInArtifactActionEvent,
} from "./index";

describe("artifact protocol", () => {
  test("derives every public kind from the schema map", () => {
    expect([...artifactKinds] as string[]).toEqual(Object.keys(artifactSchemas));
    expect(new Set(artifactKinds).size).toBe(18);
  });

  test("accepts a registered protocol shape", () => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "calculator",
      id: "calc-1",
      title: "Compound interest",
      description: "Explore growth",
      calculatorId: "compound-interest",
      initialValues: { principal: 1000 },
      currency: "USD",
      locale: "en-US",
    });
    expect(result.success).toBe(true);
  });

  test("rejects executable artifact kinds", () => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "html",
      id: "unsafe",
      title: "Unsafe",
      html: "<script>alert(1)</script>",
    });
    expect(result.success).toBe(false);
  });

  test.each([
    {
      kind: "trend",
      metricLabel: "Revenue",
      format: "currency",
      currency: "USD",
      change: 12,
      changeLabel: "vs previous month",
      points: [
        { timestamp: "2026-08-10T00:00:00.000Z", value: 120 },
        { timestamp: "2026-08-11T00:00:00.000Z", value: 132 },
      ],
      insight: "Growth accelerated after the launch.",
    },
    {
      kind: "anomaly",
      format: "number",
      summary: "One high-severity spike needs attention.",
      anomalies: [{
        id: "failed-jobs",
        label: "Failed jobs",
        timestamp: "2026-08-12T03:00:00.000Z",
        severity: "high",
        actual: 18,
        expected: 3,
        deviation: 5,
      }],
    },
    {
      kind: "forecast",
      metricLabel: "Weekly demand",
      format: "compact",
      confidenceLevel: 95,
      horizon: "8 weeks",
      method: "Prophet model v4",
      points: [
        { timestamp: "2026-08-10T00:00:00.000Z", actual: 860 },
        { timestamp: "2026-08-17T00:00:00.000Z", forecast: 910, lower: 870, upper: 950 },
      ],
    },
    {
      kind: "funnel",
      steps: [
        { id: "visit", label: "Visited", value: 10_000 },
        { id: "signup", label: "Signed up", value: 2_500, conversionFromPrevious: 25 },
      ],
      footnote: "Same-session conversion.",
    },
    {
      kind: "data-quality",
      score: 82,
      source: "analytics.orders",
      updatedAt: "2026-08-12T10:00:00.000Z",
      checks: [{
        id: "freshness",
        label: "Freshness",
        status: "warning",
        detail: "Data is 42 minutes late.",
        observed: "42m",
        threshold: "15m",
      }],
    },
    {
      kind: "insight",
      insights: [{
        id: "activation",
        headline: "Activation improved",
        detail: "Activation rose after onboarding changed.",
        evidence: "+8.4 percentage points",
      }],
      recommendedAction: "Compare performance by acquisition channel.",
    },
    {
      kind: "breakdown",
      dimensionLabel: "Channel",
      metricLabel: "Revenue",
      format: "currency",
      currency: "USD",
      total: 212_400,
      items: [
        { id: "organic", label: "Organic", value: 91_200, share: 42.9 },
        { id: "paid", label: "Paid", value: 74_800, share: 35.2 },
      ],
    },
    {
      kind: "distribution",
      metricLabel: "Query latency",
      format: "number",
      bins: [
        { id: "0-1", label: "0–1s", min: 0, max: 1, count: 42 },
        { id: "1-2", label: "1–2s", min: 1, max: 2, count: 18 },
      ],
      summary: { count: 60, min: 0.1, p25: 0.4, median: 0.7, mean: 0.9, p75: 1.2, max: 2 },
      outlierCount: 2,
    },
    {
      kind: "cohort",
      metricLabel: "Workspace retention",
      periods: ["Week 0", "Week 1", "Week 2"],
      cohorts: [
        { id: "jul-21", label: "Jul 21", size: 842, values: [100, 68.2, 54.1] },
        { id: "jul-28", label: "Jul 28", size: 911, values: [100, 70.4, null] },
      ],
    },
    {
      kind: "experiment",
      metricLabel: "Activation rate",
      format: "percent",
      control: { id: "control", label: "Existing onboarding", sampleSize: 4_812, value: 61.2 },
      treatment: { id: "treatment", label: "Guided onboarding", sampleSize: 4_764, value: 66.8 },
      effect: { absolute: 5.6, relative: 9.2, ciLower: 3.1, ciUpper: 8.1, confidenceLevel: 95, pValue: 0.002, significant: true },
      method: "Two-proportion z-test",
      guardrails: [{ id: "latency", label: "Query latency", status: "passed" }],
    },
    {
      kind: "driver",
      metricLabel: "Monthly recurring revenue",
      format: "currency",
      currency: "USD",
      startLabel: "July",
      startValue: 428_000,
      endLabel: "August",
      endValue: 461_400,
      drivers: [
        { id: "new", label: "New business", value: 48_200 },
        { id: "churn", label: "Churn", value: -14_800 },
      ],
    },
    {
      kind: "ranking",
      metricLabel: "Monthly recurring revenue",
      format: "currency",
      currency: "USD",
      items: [
        { id: "north-america", rank: 1, label: "North America", value: 184_200, change: 8.4 },
        { id: "europe", rank: 2, label: "Europe", value: 142_800, note: "Enterprise growth led the region." },
      ],
      highlightId: "europe",
      insight: "Europe closed the gap after enterprise expansion.",
    },
    {
      kind: "target",
      metricLabel: "Net burn",
      actual: -120_000,
      target: -100_000,
      baseline: -180_000,
      direction: "higher-is-better",
      status: "on-track",
      format: "currency",
      currency: "USD",
      deadline: "2026-09-30T23:59:59.000Z",
      insight: "The trusted planning service reports the target as on track.",
    },
    {
      kind: "timeline",
      order: "ascending",
      timeZone: "Asia/Shanghai",
      events: [
        {
          id: "design-approved",
          timestamp: "2026-08-10T02:00:00.000Z",
          label: "Design approved",
          description: "The release design passed review.",
          status: "completed",
          actor: "Design systems",
        },
        {
          id: "production-rollout",
          timestamp: "2026-08-18T02:00:00.000Z",
          label: "Production rollout",
          description: "The staged production rollout begins.",
          status: "planned",
        },
      ],
    },
  ])("accepts the $kind declarative artifact", (shape) => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      id: `${shape.kind}-1`,
      title: `Example ${shape.kind}`,
      description: "Validated tool output",
      ...shape,
    });
    expect(result.success).toBe(true);
  });

  test("rejects out-of-range forecast confidence and quality scores", () => {
    const forecast = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "forecast",
      id: "forecast-unsafe",
      title: "Forecast",
      metricLabel: "Revenue",
      confidenceLevel: 101,
      horizon: "3 months",
      method: "Validated forecast service",
      points: [
        { timestamp: "2026-07-01T00:00:00.000Z", actual: 11 },
        { timestamp: "2026-08-01T00:00:00.000Z", forecast: 12 },
      ],
    });
    const quality = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "data-quality",
      id: "quality-unsafe",
      title: "Quality",
      score: 101,
      source: "orders",
      checks: [{ id: "valid", label: "Validity", status: "passed", detail: "Valid" }],
    });
    expect(forecast.success).toBe(false);
    expect(quality.success).toBe(false);
  });

  test("rejects forecast points without actual or forecast values", () => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "forecast",
      id: "forecast-empty-point",
      title: "Forecast",
      metricLabel: "Revenue",
      confidenceLevel: 80,
      horizon: "3 months",
      method: "Validated forecast service",
      points: [
        { timestamp: "2026-07-01T00:00:00.000Z", actual: 11 },
        { timestamp: "2026-08-01T00:00:00.000Z" },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects out-of-range percentages in trend, anomaly, and funnel payloads", () => {
    const trend = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "trend",
      id: "trend-out-of-range",
      title: "Trend",
      metricLabel: "Revenue",
      change: 101,
      points: [
        { timestamp: "2026-08-10T00:00:00.000Z", value: 120 },
        { timestamp: "2026-08-11T00:00:00.000Z", value: 132 },
      ],
    });
    const anomaly = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "anomaly",
      id: "anomaly-out-of-range",
      title: "Anomaly",
      anomalies: [{
        id: "failure-rate",
        label: "Failure rate",
        timestamp: "2026-08-12T03:00:00.000Z",
        severity: "high",
        actual: 20,
        expected: 5,
        deviation: 120,
      }],
    });
    const funnel = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "funnel",
      id: "funnel-out-of-range",
      title: "Funnel",
      steps: [
        { id: "view", label: "View", value: 100 },
        { id: "buy", label: "Buy", value: 20, conversionFromPrevious: 101 },
      ],
    });
    expect(trend.success).toBe(false);
    expect(anomaly.success).toBe(false);
    expect(funnel.success).toBe(false);
  });

  test("rejects executable fields from strict declarative artifacts", () => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "insight",
      id: "unsafe-insight",
      title: "Unsafe insight",
      insights: [{ id: "a", headline: "A", detail: "A detail" }],
      jsx: "<button onClick={() => eval(code)}>Run</button>",
    });
    expect(result.success).toBe(false);
  });

  test("accepts actions for every protocol artifact kind", () => {
    for (const artifactKind of [
      "query",
      "calculator",
      "metric",
      "comparison",
      "trend",
      "anomaly",
      "forecast",
      "funnel",
      "data-quality",
      "insight",
      "breakdown",
      "distribution",
      "cohort",
      "experiment",
      "driver",
      "ranking",
      "target",
      "timeline",
    ]) {
      const result = artifactActionEventSchema.safeParse({
        protocolVersion: "1.0",
        eventId: `event-${artifactKind}`,
        artifactId: `${artifactKind}-1`,
        artifactKind,
        action: "refresh",
        payload: {},
        timestamp: "2026-08-12T10:00:00.000Z",
      });
      expect(result.success).toBe(true);
    }
  });

  test("validates built-in action ports and their payloads", () => {
    const event = {
      protocolVersion: "1.0",
      eventId: "event-metric",
      artifactId: "metric-1",
      artifactKind: "metric",
      action: "metric-select",
      payload: { metricId: "mrr" },
      timestamp: "2026-08-12T10:00:00.000Z",
    };
    expect(safeParseBuiltInArtifactActionEvent(event).success).toBe(true);
    expect(safeParseBuiltInArtifactActionEvent({ ...event, artifactKind: "query" }).success).toBe(false);
    expect(safeParseBuiltInArtifactActionEvent({ ...event, payload: { metric: "mrr" } }).success).toBe(false);
    expect(safeParseBuiltInArtifactActionEvent({ ...event, action: "run-javascript" }).success).toBe(false);

    expect(safeParseBuiltInArtifactActionEvent({
      ...event,
      eventId: "event-ranking",
      artifactId: "ranking-1",
      artifactKind: "ranking",
      action: "ranking-item-select",
      payload: { itemId: "north-america", rank: 1 },
    }).success).toBe(true);
    expect(safeParseBuiltInArtifactActionEvent({
      ...event,
      eventId: "event-timeline",
      artifactId: "timeline-1",
      artifactKind: "timeline",
      action: "timeline-item-select",
      payload: { eventId: "production-rollout" },
    }).success).toBe(true);
  });

  test("enforces shared string and query row budgets", () => {
    const oversized = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "metric",
      id: "metric-large",
      title: "Large",
      description: "x".repeat(V1_PROTOCOL_LIMITS.maxStringBytes + 1),
      metrics: [{ id: "m", label: "Metric", value: 1 }],
    });
    const tooManyRows = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "query",
      id: "query-large",
      title: "Large query",
      columns: [{ key: "value", label: "Value", type: "number" }],
      rows: Array.from({ length: V1_PROTOCOL_LIMITS.maxQueryRows + 1 }, () => ({ value: 1 })),
      rowCount: V1_PROTOCOL_LIMITS.maxQueryRows + 1,
    });
    expect(oversized.success).toBe(false);
    expect(tooManyRows.success).toBe(false);
  });

  test("preserves the frozen v1 unknown-field behavior", () => {
    const result = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "metric",
      id: "metric-compatible",
      title: "Compatible",
      metrics: [{ id: "m", label: "Metric", value: 1 }],
      legacyExtension: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect("legacyExtension" in result.data).toBe(false);
  });

  test("rejects malformed statistical artifacts", () => {
    const distribution = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "distribution",
      id: "distribution-invalid",
      title: "Invalid distribution",
      metricLabel: "Latency",
      bins: [
        { id: "a", label: "A", min: 2, max: 1, count: 3 },
        { id: "b", label: "B", min: 2, max: 3, count: 4 },
      ],
      summary: { count: 7, min: 0, p25: 4, median: 3, mean: 2, p75: 5, max: 6 },
    });
    const cohort = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "cohort",
      id: "cohort-invalid",
      title: "Invalid cohort",
      metricLabel: "Retention",
      periods: ["Week 0", "Week 1"],
      cohorts: [{ id: "aug", label: "August", size: 100, values: [100] }],
    });
    const experiment = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "experiment",
      id: "experiment-invalid",
      title: "Invalid experiment",
      metricLabel: "Activation",
      control: { id: "a", label: "A", sampleSize: 100, value: 20 },
      treatment: { id: "b", label: "B", sampleSize: 100, value: 24 },
      effect: { absolute: 4, relative: 20, ciLower: 8, ciUpper: 2, confidenceLevel: 95, significant: true },
      method: "Validated test",
    });
    expect(distribution.success).toBe(false);
    expect(cohort.success).toBe(false);
    expect(experiment.success).toBe(false);
  });

  test("enforces semantic ranking, target, and timeline invariants", () => {
    const ranking = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "ranking",
      id: "ranking-invalid",
      title: "Invalid ranking",
      metricLabel: "Revenue",
      items: [
        { id: "same", rank: 2, label: "Second", value: 20 },
        { id: "same", rank: 1, label: "First", value: 10 },
      ],
      highlightId: "missing",
    });
    const targetWithoutTrustedStatus = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "target",
      id: "target-invalid",
      title: "Invalid target",
      metricLabel: "Net burn",
      actual: -120_000,
      target: -100_000,
      direction: "higher-is-better",
    });
    const timeline = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "timeline",
      id: "timeline-invalid",
      title: "Invalid timeline",
      events: [
        { id: "same", timestamp: "2026-08-10T02:00:00.000Z", label: "One", description: "One", status: "info" },
        { id: "same", timestamp: "2026-08-11T02:00:00.000Z", label: "Two", description: "Two", status: "planned" },
      ],
    });
    const timelineWithInvalidTimeZone = safeParseArtifact({
      protocolVersion: "1.0",
      kind: "timeline",
      id: "timeline-invalid-timezone",
      title: "Invalid timeline timezone",
      timeZone: "Not/A_Time_Zone",
      events: [
        { id: "one", timestamp: "2026-08-10T02:00:00.000Z", label: "One", description: "One", status: "info" },
      ],
    });

    expect(ranking.success).toBe(false);
    expect(targetWithoutTrustedStatus.success).toBe(false);
    expect(timeline.success).toBe(false);
    expect(timelineWithInvalidTimeZone.success).toBe(false);
  });
});
