import { describe, expect, test } from "bun:test";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import { toOpenGenerativeSurfaceDataChunk } from "@open-generative/ai-sdk/server";
import type { DataChartSpecInput } from "@open-generative/host";
import { createOpenGenerativeHost } from "@open-generative/host";
import {
  createTesseraDataChartPresentation,
  createTesseraPresentationAuthority,
} from "./presentation";

type Column = Readonly<{ outputId: string; label: string; type: string }>;
type ChartCase = Readonly<{
  recipe: DataChartSpecInput["recipe"];
  columns: readonly Column[];
  rows: readonly Record<string, unknown>[];
}>;

function completedResult(input: Readonly<{
  columns: readonly Column[];
  rows: readonly Record<string, unknown>[];
}>): DataAgentRunResult {
  return {
    columns: input.columns,
    execution: { result: { rows: input.rows } },
  } as DataAgentRunResult;
}

const identity = { subject: "member-42", tenantId: "tenant-7" };
const dailyRows = Array.from({ length: 7 }, (_, index) => ({
  day: `2026-07-${String(index + 1).padStart(2, "0")}`,
  steps: 2_000 + index * 500,
  target: 8_000,
}));
const scatterRows = Array.from({ length: 16 }, (_, index) => ({
  account: `Account ${index + 1}`,
  revenue: 100 + index * 80,
  sessions: 10 + index * 4,
  opportunities: 2 + index,
  plan: ["Starter", "Growth", "Scale"][index % 3]!,
  change: 0.08,
}));
const sankeyRows = Array.from({ length: 5 }, (_, source) => (
  Array.from({ length: 7 }, (_, target) => ({
    source: `Source ${source + 1}`,
    target: `Target ${target + 1}`,
    hours: source + target + 1,
  }))
)).flat();

const recipeCases: readonly ChartCase[] = [
  {
    recipe: "steps-bars",
    columns: [
      { outputId: "day", label: "Day", type: "date" },
      { outputId: "steps", label: "Steps", type: "number" },
      { outputId: "target", label: "Target", type: "number" },
    ],
    rows: dailyRows,
  },
  {
    recipe: "pipeline-stage-bars",
    columns: [
      { outputId: "stage", label: "Stage", type: "string" },
      { outputId: "users", label: "Users", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: Array.from({ length: 6 }, (_, index) => ({ stage: `Stage ${index + 1}`, users: 600 - index * 75, change: 0.04 })),
  },
  {
    recipe: "sleep-score",
    columns: [
      { outputId: "category", label: "Category", type: "string" },
      { outputId: "detail", label: "Detail", type: "string" },
      { outputId: "score", label: "Score", type: "number" },
      { outputId: "target", label: "Target", type: "number" },
      { outputId: "date", label: "Date", type: "date" },
    ],
    rows: [
      { category: "Duration", detail: "7h 50m", score: 49, target: 50, date: "2026-07-01" },
      { category: "Bedtime", detail: "20m earlier", score: 29, target: 30, date: "2026-07-02" },
      { category: "Interruptions", detail: "5m", score: 20, target: 20, date: "2026-07-03" },
    ],
  },
  {
    recipe: "revenue-per-account-scatter",
    columns: [
      { outputId: "account", label: "Account", type: "string" },
      { outputId: "revenue", label: "Revenue", type: "number" },
      { outputId: "sessions", label: "Sessions", type: "number" },
      { outputId: "opportunities", label: "Opportunities", type: "number" },
      { outputId: "plan", label: "Plan", type: "string" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: scatterRows,
  },
  {
    recipe: "tracked-time-sankey",
    columns: [
      { outputId: "source", label: "Source", type: "string" },
      { outputId: "target", label: "Target", type: "string" },
      { outputId: "hours", label: "Hours", type: "number" },
    ],
    rows: sankeyRows,
  },
  {
    recipe: "visitors-radial",
    columns: [
      { outputId: "source", label: "Source", type: "string" },
      { outputId: "visitors", label: "Visitors", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ source: "Direct", visitors: 42, change: 0.08 }, { source: "Search", visitors: 31, change: 0.08 }],
  },
  {
    recipe: "visitors-radar",
    columns: [
      { outputId: "month", label: "Month", type: "string" },
      { outputId: "visitors", label: "Visitors", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ month: "January", visitors: 186, change: 0.05 }, { month: "February", visitors: 305, change: 0.05 }],
  },
  {
    recipe: "activity-calendar",
    columns: [
      { outputId: "date", label: "Date", type: "date" },
      { outputId: "steps", label: "Steps", type: "number" },
      { outputId: "move", label: "Move", type: "number" },
      { outputId: "exercise", label: "Exercise", type: "number" },
      { outputId: "running", label: "Running", type: "number" },
    ],
    rows: [{ date: "2026-07-10", steps: 10_000, move: 820, exercise: 92, running: 5.2 }],
  },
  {
    recipe: "revenue-smooth-area",
    columns: [
      { outputId: "month", label: "Month", type: "date" },
      { outputId: "revenue", label: "Revenue", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ month: "2026-06-01", revenue: 1200, change: 0.1 }, { month: "2026-07-01", revenue: 1800, change: 0.1 }],
  },
  {
    recipe: "active-users-heatmap",
    columns: [
      { outputId: "day", label: "Day", type: "string" },
      { outputId: "hour", label: "Hour", type: "string" },
      { outputId: "users", label: "Active users", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ day: "Mon", hour: "09", users: 84, change: 0.05 }],
  },
  {
    recipe: "sign-up-funnel",
    columns: [
      { outputId: "stage", label: "Stage", type: "string" },
      { outputId: "users", label: "Users", type: "number" },
      { outputId: "conversion", label: "Conversion", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ stage: "Opened", users: 197, conversion: 1, change: 0.05 }, { stage: "Converted", users: 38, conversion: 0.19, change: 0.05 }],
  },
  {
    recipe: "earned-so-far-bars",
    columns: [
      { outputId: "month", label: "Month", type: "string" },
      { outputId: "earned", label: "Earned", type: "number" },
      { outputId: "target", label: "Target", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ month: "January", earned: 2_300, target: 4_000, change: 0.1 }],
  },
  {
    recipe: "contributions-heatmap",
    columns: [
      { outputId: "date", label: "Date", type: "date" },
      { outputId: "contributions", label: "Contributions", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
      { outputId: "lifetime", label: "Lifetime", type: "number" },
      { outputId: "peak", label: "Peak", type: "number" },
      { outputId: "longest", label: "Longest", type: "number" },
      { outputId: "streak", label: "Streak", type: "number" },
    ],
    rows: [{ date: "2026-07-01", contributions: 7, change: 0.1, lifetime: 999, peak: 100, longest: 9, streak: 8 }],
  },
  {
    recipe: "sessions-conversion-combo",
    columns: [
      { outputId: "date", label: "Date", type: "date" },
      { outputId: "sessions", label: "Sessions", type: "number" },
      { outputId: "conversion", label: "Conversion", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ date: "2026-06-01", sessions: 5_000, conversion: 0.03, change: 0.05 }, { date: "2026-07-01", sessions: 6_000, conversion: 0.04, change: 0.05 }],
  },
  {
    recipe: "devices-bars",
    columns: [
      { outputId: "device", label: "Device", type: "string" },
      { outputId: "share", label: "Share", type: "number" },
    ],
    rows: [{ device: "Desktop", share: 0.61 }, { device: "Mobile", share: 0.31 }],
  },
  {
    recipe: "visitors-stacked-area",
    columns: [
      { outputId: "date", label: "Date", type: "date" },
      { outputId: "organic", label: "Organic", type: "number" },
      { outputId: "referral", label: "Referral", type: "number" },
      { outputId: "total", label: "Total visitors", type: "number" },
      { outputId: "change", label: "Change", type: "number" },
    ],
    rows: [{ date: "2026-06-01", organic: 120, referral: 40, total: 160, change: 0.08 }, { date: "2026-07-01", organic: 180, referral: 60, total: 240, change: 0.08 }],
  },
  {
    recipe: "activity-rings",
    columns: [
      { outputId: "activity", label: "Activity", type: "string" },
      { outputId: "detail", label: "Detail", type: "string" },
      { outputId: "value", label: "Value", type: "number" },
      { outputId: "target", label: "Target", type: "number" },
    ],
    rows: [{ activity: "Move", detail: "800 kcal", value: 800, target: 900 }],
  },
];

describe("Tessera Open Generative presentation", () => {
  test("maps every supported analytical shape to its exact custom chart recipe", () => {
    for (const chartCase of recipeCases) {
      const presentation = createTesseraDataChartPresentation({
        analysis: { title: "Analytical result", result: completedResult(chartCase) },
        identity,
      });
      expect(presentation, chartCase.recipe).toBeDefined();
      expect(presentation?.spec.recipe, chartCase.recipe).toBe(chartCase.recipe);
      expect(presentation?.dataset.rows).toHaveLength(chartCase.rows.length);
    }
  });

  test("publishes every custom recipe as the chat surface event consumed by assistant-ui", async () => {
    const host = await createOpenGenerativeHost();

    for (const chartCase of recipeCases) {
      const presentation = createTesseraDataChartPresentation({
        analysis: { title: "Analytical result", result: completedResult(chartCase) },
        identity,
      });
      expect(presentation, chartCase.recipe).toBeDefined();
      if (!presentation) continue;

      const surface = await host.presentDataChart(presentation);
      const dataPart = await toOpenGenerativeSurfaceDataChunk(surface.event);
      expect(dataPart.type, chartCase.recipe).toBe("data-openGenerativeSurface");
      expect(surface.event.payload.type, chartCase.recipe).toBe("snapshot-published");
      if (surface.event.payload.type !== "snapshot-published") continue;

      const props = Object.values(surface.event.payload.snapshot.revision.content.nodes)[0]?.props;
      expect(props, chartCase.recipe).toMatchObject({
        spec: {
          kind: "object",
          entries: {
            recipe: { kind: "literal", value: chartCase.recipe },
          },
        },
      });
    }
  });

  test("does not force an unrelated result into a visual recipe", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Unsupported result",
        result: completedResult({
          columns: [{ outputId: "active", label: "Active", type: "boolean" }],
          rows: [{ active: true }],
        }),
      },
      identity,
    });
    expect(presentation).toBeUndefined();
  });

  test("uses opaque stable audience bindings rather than Studio identities", () => {
    const authority = createTesseraPresentationAuthority(identity);
    expect(authority.actorBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.tenantBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(authority)).not.toContain(identity.subject);
    expect(JSON.stringify(authority)).not.toContain(identity.tenantId);
  });
});
