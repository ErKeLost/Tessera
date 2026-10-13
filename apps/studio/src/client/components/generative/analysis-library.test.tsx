import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { tesseraAnalysisLibrary } from "./analysis-library";

function render(program: string) {
  return renderToStaticMarkup(
    <Renderer library={tesseraAnalysisLibrary} response={program} />,
  );
}

const PROGRAM = [
  "root = Stack([headline, grid, trend, breakdown, ranking, note])",
  'headline = Metric("Total revenue", "$1.24M", "+8.3% vs Q1", "Paid invoices only")',
  "grid = Grid([amer, emea], 2)",
  'amer = Metric("AMER revenue", "$440K", "+2.1% vs Q1", "Paid invoices only", "positive")',
  'emea = Metric("EMEA revenue", "$420K")',
  'trend = BarChart("Monthly revenue", ["Apr", "May"], [392000, 402000], "USD", "Sum of paid invoices")',
  'breakdown = Table("Revenue by region", ["Region", "Revenue"], [["AMER", "$440K"], ["EMEA", "$420K"]], "Three regions")',
  'ranking = Ranking("Top regions", ["AMER", "EMEA"], [440000, 420000], "USD")',
  'note = Callout("warning", "Coverage", "One region was excluded because the join returned no rows.")',
].join("\n");

describe("tesseraAnalysisLibrary", () => {
  test("renders every block of a committed program", () => {
    const html = render(PROGRAM);

    expect(html).toContain("Total revenue");
    expect(html).toContain("$1.24M");
    expect(html).toContain("+8.3% vs Q1");
    expect(html).toContain("tessera-analysis-grid");
    expect(html).toContain("Monthly revenue");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("Top regions");
    expect(html).toContain("One region was excluded");
    expect(html).toContain('data-tone="positive"');
    expect(html).toContain('data-tone="warning"');
  });

  test("does not render a chart whose parallel arrays disagree", () => {
    const html = render([
      "root = Stack([broken])",
      'broken = BarChart("Monthly revenue", ["Apr", "May"], [392000])',
    ].join("\n"));

    expect(html).toContain("tessera-analysis-invalid");
    expect(html).toContain("do not line up");
    expect(html).not.toContain("tessera-analysis-bar-column");
  });

  test("drops an incomplete program instead of showing partial numbers", () => {
    const html = render('root = Stack([headline])\nheadline = Metric("Total revenue"');

    expect(html).not.toContain("Total revenue");
    expect(html).not.toContain("tessera-analysis-metric-value");
  });

  test("renders nothing for a program with no root statement", () => {
    const html = render('orphan = Metric("Total revenue", "$1M")');

    expect(html).not.toContain("Total revenue");
  });

  test("treats an explicit null optional argument as absent", () => {
    const html = render([
      "root = Stack([a, b, c])",
      'a = Metric("Total rows", "1,670", null, "unfiltered")',
      'b = Insight("Finding", "Published dominates.", null, null)',
      'c = Table("Status", ["status", "rows"], [["published", "1,106"]], null)',
    ].join("\n"));

    expect(html).toContain("1,670");
    expect(html).toContain("Published dominates.");
    expect(html).toContain("<table");
    expect(html).not.toContain("null");
    expect(html).toContain('data-tone="neutral"');
  });

  test("rejects a component the library does not declare", () => {
    const html = render('root = Stack([x])\nx = Sankey("flows", [1, 2])');

    expect(html).not.toContain("Sankey");
  });
});
