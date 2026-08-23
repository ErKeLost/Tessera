import { describe, expect, test } from "bun:test";
import {
  dataChartFixtureMarks,
  dataChartFixtureSchema,
  dataChartGrammarFixtures,
} from "./data-chart-fixtures";
import { dataChartMarks } from "./data-chart-spec";
import { officialComponentFixtures, officialComponentTypes, officialSurfaceCompositions } from "./fixtures";

describe("Data Chart grammar coverage", () => {
  test("covers each renderer-supported semantic mark exactly once", () => {
    expect(dataChartFixtureMarks).toEqual([...dataChartMarks]);
    expect(new Set(dataChartFixtureMarks).size).toBe(dataChartMarks.length);
    for (const fixture of dataChartGrammarFixtures) {
      expect(dataChartFixtureSchema.parse(fixture)).toEqual(fixture);
      expect(fixture.authoringSpec.mark).toBe(fixture.mark);
      expect(fixture.resolvedSpec.mark).toBe(fixture.mark);
      expect(fixture.resolvedSpec.equivalentView).toBe("table");
    }
  });
});

describe("official component fixtures", () => {
  test("contains only one data.chart component fixture and composition", () => {
    expect(officialComponentTypes).toEqual(["data.chart"]);
    expect(officialComponentFixtures).toHaveLength(1);
    expect(officialComponentFixtures[0]?.componentType).toBe("data.chart");
    expect(officialSurfaceCompositions).toHaveLength(1);
    expect(officialSurfaceCompositions[0]?.nodes).toHaveLength(1);
  });
});
