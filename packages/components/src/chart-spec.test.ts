import { describe, expect, test } from "bun:test";
import {
  chartSpecSchema,
  resolvedChartSpecSchema,
} from "./chart-spec";
import { officialChartSpecFixtures } from "./chart-fixtures";

describe("ChartSpec", () => {
  test("validates one strict authoring fixture for every official chart recipe", () => {
    expect(officialChartSpecFixtures).toHaveLength(70);
    for (const fixture of officialChartSpecFixtures) {
      expect(chartSpecSchema.parse(fixture.spec)).toEqual(fixture.spec);
      expect(fixture.spec.equivalentView === "table" || fixture.spec.equivalentView === "text-summary").toBe(true);
    }
  });

  test("keeps authoring resource expressions separate from resolved data", () => {
    const fixture = structuredClone(officialChartSpecFixtures[0]!.spec);
    expect(chartSpecSchema.safeParse(fixture).success).toBe(true);
    expect(resolvedChartSpecSchema.safeParse(fixture).success).toBe(false);

    const resolved = {
      ...fixture,
      data: {
        columns: [
          { columnId: "month", label: "Month", valueType: "date" },
          { columnId: "revenue", label: "Revenue", valueType: "number" },
        ],
        rows: [{ month: "2026-08-01", revenue: 42 }],
      },
    };
    expect(resolvedChartSpecSchema.safeParse(resolved).success).toBe(true);
    expect(chartSpecSchema.safeParse(resolved).success).toBe(false);
  });

  test("rejects inline data, raw presentation values, callbacks, and renderer props", () => {
    const base = structuredClone(officialChartSpecFixtures[0]!.spec) as Record<string, any>;

    expect(chartSpecSchema.safeParse({ ...base, data: [{ month: "2026-08", revenue: 42 }] }).success).toBe(false);
    const forbiddenPresentationKey = ["class", "Name"].join("");
    expect(chartSpecSchema.safeParse({ ...base, [forbiddenPresentationKey]: "h-80" }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, style: { color: "red" } }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, margin: { top: 10 } }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, content: () => null }).success).toBe(false);

    const invalidColorToken = structuredClone(base);
    invalidColorToken.series[0].colorToken = "#ff0000";
    expect(chartSpecSchema.safeParse(invalidColorToken).success).toBe(false);

    const rawIcon = structuredClone(base);
    rawIcon.series[0].iconToken = "MyIconComponent";
    expect(chartSpecSchema.safeParse(rawIcon).success).toBe(false);
  });

  test("rejects family-specific fields and invalid domains or stacks", () => {
    const line = structuredClone(officialChartSpecFixtures.find((fixture) => fixture.spec.family === "line")!.spec);
    expect(chartSpecSchema.safeParse({ ...line, innerRadius: "md" }).success).toBe(false);

    const radial = structuredClone(officialChartSpecFixtures.find((fixture) => fixture.spec.family === "radial")!.spec);
    expect(chartSpecSchema.safeParse({ ...radial, domain: { min: 10, max: 10 } }).success).toBe(false);

    const stacked = structuredClone(officialChartSpecFixtures.find((fixture) => (
      "stack" in fixture.spec && fixture.spec.stack?.mode === "normal"
    ))!.spec) as Record<string, any>;
    stacked.series = [stacked.series[0]];
    expect(chartSpecSchema.safeParse(stacked).success).toBe(false);
  });
});
