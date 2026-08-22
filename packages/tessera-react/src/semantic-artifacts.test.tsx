import { describe, expect, test } from "bun:test";
import type { RankingArtifact as RankingArtifactData, TargetArtifact as TargetArtifactData, TimelineArtifact as TimelineArtifactData } from "@open-tessera/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactRenderer, defaultArtifactNodeRendererRegistry, defaultRendererRegistry } from "./renderer";

const rankingArtifact: RankingArtifactData = {
  protocolVersion: "1.0",
  id: "ranking-regions",
  kind: "ranking",
  title: "Regional revenue",
  description: "Quarterly leaders",
  metricLabel: "Revenue",
  format: "currency",
  currency: "USD",
  items: [
    { id: "west", rank: 2, label: "West", value: 980_000, change: -1.2 },
    { id: "east", rank: 1, label: "East", value: 1_250_000, change: 4.2, note: "Enterprise growth" },
  ],
  highlightId: "east",
  insight: "East leads on expansion revenue.",
};

const targetArtifact: TargetArtifactData = {
  protocolVersion: "1.0",
  id: "target-arr",
  kind: "target",
  title: "ARR target",
  description: "Annual plan progress",
  metricLabel: "ARR",
  actual: 900_000,
  target: 1_000_000,
  baseline: 500_000,
  direction: "higher-is-better",
  status: "on-track",
  format: "currency",
  currency: "USD",
  deadline: "2026-12-31T00:00:00.000Z",
  insight: "Pipeline coverage supports the remaining gap.",
};

const timelineArtifact: TimelineArtifactData = {
  protocolVersion: "1.0",
  id: "timeline-launch",
  kind: "timeline",
  title: "Launch timeline",
  description: "Milestones and decisions",
  order: "descending",
  timeZone: "UTC",
  events: [
    { id: "design", timestamp: "2026-08-01T09:00:00.000Z", label: "Design approved", description: "Core flows are signed off.", status: "completed", actor: "Design" },
    { id: "beta", timestamp: "2026-08-12T12:00:00.000Z", label: "Private beta", description: "First customer cohort is active.", status: "in-progress", actor: "Product" },
  ],
};

describe("semantic artifact renderers", () => {
  test("registers ranking, target, and timeline for v1 and v2 rendering", () => {
    expect(defaultRendererRegistry.ranking).toBeDefined();
    expect(defaultRendererRegistry.target).toBeDefined();
    expect(defaultRendererRegistry.timeline).toBeDefined();
    expect(defaultArtifactNodeRendererRegistry["artifact.ranking"]).toBeDefined();
    expect(defaultArtifactNodeRendererRegistry["artifact.target"]).toBeDefined();
    expect(defaultArtifactNodeRendererRegistry["artifact.timeline"]).toBeDefined();
  });

  test("renders explicit ranks, ordering, highlight, and formatted values", () => {
    const markup = renderToStaticMarkup(<ArtifactRenderer artifact={rankingArtifact} locale="en-US" />);
    expect(markup.indexOf("East")).toBeLessThan(markup.indexOf("West"));
    expect(markup).toContain('data-highlighted="true"');
    expect(markup).toContain("$1,250,000");
    expect(markup).toContain("+4.2%");
    expect(markup).toContain("East leads on expansion revenue.");
  });

  test("renders the authoritative target status and baseline progress", () => {
    const markup = renderToStaticMarkup(<ArtifactRenderer artifact={targetArtifact} locale="en-US" />);
    expect(markup).toContain("On track");
    expect(markup).toContain("$900,000");
    expect(markup).toContain("80%");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("Pipeline coverage supports the remaining gap.");
  });

  test("does not invent progress for a non-positive target without a baseline", () => {
    const markup = renderToStaticMarkup(<ArtifactRenderer artifact={{
      ...targetArtifact,
      actual: -120_000,
      baseline: undefined,
      target: -100_000,
    }} locale="en-US" />);
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).toContain("Gap to target");
  });

  test("orders timeline events and exposes status, actor, and timezone", () => {
    const markup = renderToStaticMarkup(<ArtifactRenderer artifact={timelineArtifact} locale="en-US" />);
    expect(markup.indexOf("Private beta")).toBeLessThan(markup.indexOf("Design approved"));
    expect(markup).toContain("In progress");
    expect(markup).toContain("Product");
    expect(markup).toContain("Newest first");
    expect(markup).toContain("UTC");
  });

  test("fails closed to UTC for an invalid host-provided timezone", () => {
    const markup = renderToStaticMarkup(<ArtifactRenderer artifact={{
      ...timelineArtifact,
      timeZone: "Not/A_Time_Zone",
    }} locale="en-US" />);
    expect(markup).toContain("UTC");
    expect(markup).not.toContain("Not/A_Time_Zone");
  });
});
