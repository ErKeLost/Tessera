import { describe, expect, test } from "bun:test";
import { officialChartSpecFixtures } from "./chart-fixtures";
import { chartRecipes, chartSpecSchema, resolvedChartSpecSchema } from "./chart-spec";

describe("Data Chart spec", () => {
  test("is an exact 17-recipe discriminated union", () => {
    expect(officialChartSpecFixtures).toHaveLength(17);
    expect(officialChartSpecFixtures.map((fixture) => fixture.recipeName)).toEqual([...chartRecipes]);
    for (const fixture of officialChartSpecFixtures) {
      expect(chartSpecSchema.parse(fixture.spec)).toEqual(fixture.spec);
      expect(resolvedChartSpecSchema.parse(fixture.resolvedSpec)).toEqual(fixture.resolvedSpec);
      expect(fixture.spec.recipe).toBe(fixture.recipeName);
    }
  });

  test("separates authoring Resource Bindings from resolved datasets", () => {
    const fixture = officialChartSpecFixtures[0]!;
    expect(chartSpecSchema.safeParse(fixture.spec).success).toBe(true);
    expect(resolvedChartSpecSchema.safeParse(fixture.spec).success).toBe(false);
    expect(resolvedChartSpecSchema.safeParse(fixture.resolvedSpec).success).toBe(true);
    expect(chartSpecSchema.safeParse(fixture.resolvedSpec).success).toBe(false);
  });

  test("rejects inline rows and renderer-controlled presentation", () => {
    const base = structuredClone(officialChartSpecFixtures[0]!.spec) as Record<string, unknown>;
    expect(chartSpecSchema.safeParse({ ...base, data: [{ day: "Mon", steps: 42 }] }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, color: "#9cdf15" }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, className: "h-80" }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, style: { color: "red" } }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, onSelect: () => undefined }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, svg: "<svg />" }).success).toBe(false);
    expect(chartSpecSchema.safeParse({ ...base, recipe: "chart-area-default" }).success).toBe(false);
  });

  test("rejects undeclared or semantically invalid resolved columns", () => {
    const base = structuredClone(officialChartSpecFixtures[0]!.resolvedSpec) as Record<string, any>;
    base.valueColumn = "missing";
    expect(resolvedChartSpecSchema.safeParse(base).success).toBe(false);

    const invalidType = structuredClone(officialChartSpecFixtures[0]!.resolvedSpec) as Record<string, any>;
    const steps = invalidType.data.columns.find((column: Record<string, unknown>) => column.columnId === "steps")!;
    steps.valueType = "string";
    expect(resolvedChartSpecSchema.safeParse(invalidType).success).toBe(false);
  });

  test("requires steps bars to resolve one complete week and an existing selected date", () => {
    const missingSelection = structuredClone(officialChartSpecFixtures[0]!.resolvedSpec) as Record<string, any>;
    missingSelection.selectedDate = "2026-07-06";
    expect(resolvedChartSpecSchema.safeParse(missingSelection).success).toBe(false);

    const incompleteWeek = structuredClone(officialChartSpecFixtures[0]!.resolvedSpec) as Record<string, any>;
    incompleteWeek.data.rows.pop();
    incompleteWeek.data.totalRows = incompleteWeek.data.rows.length;
    expect(resolvedChartSpecSchema.safeParse(incompleteWeek).success).toBe(false);
  });
});
