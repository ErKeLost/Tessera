import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { shadcnChatLibrary } from "./index";

function render(program: string) {
  return renderToStaticMarkup(
    <Renderer library={shadcnChatLibrary} response={program} />,
  );
}

const PROGRAM = [
  "root = Card([header, alert, tbl, tags, followUps])",
  'header = CardHeader("Revenue by region", "Last quarter")',
  'alert = Alert("Coverage", "One region was excluded because the join returned no rows.", "warning")',
  "tbl = Table(cols, rows)",
  'cols = [Col("Region", "string"), Col("Revenue", "number")]',
  'rows = [["AMER", 440000], ["EMEA", 420000]]',
  'tags = TagBlock([Tag("Live data", "default"), Tag("USD", "secondary")])',
  "followUps = FollowUpBlock([fu1, fu2])",
  'fu1 = FollowUpItem("Tell me more about AMER")',
  'fu2 = FollowUpItem("Show me a chart")',
].join("\n");

describe("shadcnChatLibrary", () => {
  test("uses the shadcn Card as the root of every answer", () => {
    expect(shadcnChatLibrary.root).toBe("Card");
  });

  test("renders the streamed answer with shadcn/ui components", () => {
    const html = render(PROGRAM);

    expect(html).toContain('data-slot="card"');
    expect(html).toContain("Revenue by region");
    expect(html).toContain("Last quarter");
    expect(html).toContain('data-slot="table"');
    expect(html).toContain("AMER");
    expect(html).toContain('data-slot="alert"');
    expect(html).toContain("One region was excluded");
    expect(html).toContain('data-slot="badge"');
    expect(html).toContain("Live data");
  });

  test("renders follow-up choices as buttons instead of text", () => {
    const html = render(PROGRAM);

    expect(html).toContain("<button");
    expect(html).toContain("Tell me more about AMER");
    expect(html).toContain("Show me a chart");
  });

  test("renders nothing for a component the library does not declare", () => {
    const html = render([
      "root = Card([broken])",
      'broken = Metric("Rows", "1,670")',
    ].join("\n"));

    expect(html).not.toContain("1,670");
    expect(html).toContain('data-slot="card"');
  });
});
