import { describe, expect, test } from "bun:test";
import { dataChartGrammarFixtures } from "./data-chart-fixtures";
import { dataChartMarks, dataChartSpecSchema, resolvedDataChartSpecSchema } from "./data-chart-spec";

describe("Data Chart semantic grammar", () => {
  test("validates one authoring and resolved fixture for each supported mark", () => {
    expect(dataChartGrammarFixtures.map((fixture) => fixture.mark)).toEqual([...dataChartMarks]);
    for (const fixture of dataChartGrammarFixtures) {
      expect(dataChartSpecSchema.parse(fixture.authoringSpec)).toEqual(fixture.authoringSpec);
      expect(resolvedDataChartSpecSchema.parse(fixture.resolvedSpec)).toEqual(fixture.resolvedSpec);
    }
  });

  test("rejects generated style and non-semantic fields", () => {
    const invalid = structuredClone(dataChartGrammarFixtures[0]!.authoringSpec) as Record<string, unknown>;
    invalid.colors = ["#f00"];
    expect(() => dataChartSpecSchema.parse(invalid)).toThrow();
  });

  test("requires dataset types to agree with encodings", () => {
    const invalid = structuredClone(dataChartGrammarFixtures[0]!.resolvedSpec) as Record<string, unknown>;
    const data = invalid.data as { columns: Array<{ columnId: string; valueType: string }> };
    data.columns.find((column) => column.columnId === "revenue")!.valueType = "string";
    expect(() => resolvedDataChartSpecSchema.parse(invalid)).toThrow();
  });
});
