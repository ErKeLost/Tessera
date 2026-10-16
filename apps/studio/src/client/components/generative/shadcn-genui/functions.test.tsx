import { describe, expect, test } from "bun:test";
import { Renderer } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { shadcnChatLibrary } from "./index";

function render(program: string) {
  return renderToStaticMarkup(<Renderer library={shadcnChatLibrary} response={program} />);
}

/** One TextContent holding a single computed value. */
function renderValue(expression: string) {
  return render(`root = Card([t])\nt = TextContent(${expression})`);
}

describe("answer functions", () => {
  test("Percent formats a share of a total", () => {
    expect(renderValue("@Percent(3, 4)")).toContain("75%");
  });

  test("Percent degrades to n/a on a zero total instead of throwing", () => {
    const html = renderValue("@Percent(3, 0)");

    expect(html).toContain("n/a");
    expect(html).toContain('data-slot="card"');
  });

  test("Delta formats a signed period-over-period change", () => {
    expect(renderValue("@Delta(112, 100)")).toContain("+12%");
    expect(renderValue("@Delta(88, 100)")).toContain("-12%");
  });

  test("Delta degrades to n/a when the earlier value is zero", () => {
    expect(renderValue("@Delta(5, 0)")).toContain("n/a");
  });

  test("FormatNumber groups thousands and honours decimals", () => {
    expect(renderValue("@FormatNumber(1670)")).toContain("1,670");
    expect(renderValue("@FormatNumber(1670.5, 1)")).toContain("1,670.5");
  });

  test("a function call works as a table cell value", () => {
    const html = render(
      [
        "root = Card([tbl])",
        "tbl = Table(cols, rows)",
        'cols = [Col("Region", "string"), Col("Share", "string")]',
        'rows = [["AMER", @Percent(440000, 1000000)], ["EMEA", @Percent(320000, 1000000)]]',
      ].join("\n"),
    );

    expect(html).toContain('data-slot="table"');
    expect(html).toContain("44%");
    expect(html).toContain("32%");
  });
});
