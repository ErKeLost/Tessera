import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisView } from "./analysis-view";

const PROGRAM = [
  "root = Card([title, body, total])",
  'title = TextContent("Orders", "large-heavy")',
  'body = TextContent("Counted from the read-only query.")',
  'total = Badge("1,670 rows")',
].join("\n");

describe("AnalysisView", () => {
  test("renders a program that has a root with the shadcn library", () => {
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={PROGRAM} />);

    expect(html).toContain('data-slot="card"');
    expect(html).toContain("Orders");
    expect(html).toContain("Counted from the read-only query.");
  });

  test("marks the wrapper while the answer streams", () => {
    const html = renderToStaticMarkup(
      <AnalysisView isStreaming response={'root = Card([a])\na = TextContent("Counted")'} />,
    );

    expect(html).toContain('data-streaming="true"');
    expect(html).toContain("Counted");
  });

  test("shows a response with no root as prose instead of an error box", () => {
    const html = renderToStaticMarkup(
      <AnalysisView isStreaming={false} response={"I could not run that query."} />,
    );

    expect(html).toContain("I could not run that query.");
    expect(html).not.toContain("did not arrive");
    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("could not be rendered");
  });

  test("reports a program the library cannot draw instead of dumping its source", () => {
    // The vocabulary the Studio shipped before the shadcn/ui library: the
    // parser sees statements, produces no root, and the answer must not be
    // shown to the reader as openui-lang source.
    const legacy = [
      "root = Stack([heading, totalMetric])",
      'heading = Heading("用户对话统计", "邮箱 1256029807@qq.com")',
      'totalMetric = Metric("总对话数", "57", "用户名下全部会话。")',
    ].join("\n");
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={legacy} />);

    expect(html).toContain("could not be rendered");
    expect(html).not.toContain("root = Stack");
    expect(html).not.toContain("totalMetric");
  });

  test("renders a runtime entry (`root = $flag ? A : B`) instead of calling it unrenderable", () => {
    const html = renderToStaticMarkup(
      <AnalysisView
        isStreaming={false}
        response={'root = $flag ? Card([a]) : Card([b])\n$flag = true\na = TextContent("chosen")\nb = TextContent("fallback")'}
      />,
    );

    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain("could not be rendered");
  });

  test("renders a program that reads live data instead of the fallback", () => {
    const html = renderToStaticMarkup(
      <AnalysisView
        isStreaming={false}
        response={[
          "root = Card([t])",
          'data = Query("relation_preview", { schema: "public", table: "orders" }, { columns: [], rows: [] })',
          't = TextContent("Rows: " + @Count(data.rows))',
        ].join("\n")}
      />,
    );

    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain("could not be rendered");
  });

  test("keeps rendering partial programs while the answer streams", () => {
    const html = renderToStaticMarkup(
      <AnalysisView isStreaming response={'root = Card([a])\na = TextContent("Coun'} />,
    );

    expect(html).not.toContain("could not be rendered");
  });

  test("renders nothing for an empty response", () => {
    expect(renderToStaticMarkup(<AnalysisView isStreaming={false} response="  " />)).toBe("");
  });

  test("stays on the program after a prose response, without latching", () => {
    renderToStaticMarkup(<AnalysisView isStreaming={false} response={"no root here"} />);
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={PROGRAM} />);

    expect(html).toContain('data-slot="card"');
    expect(html).not.toContain("no root here");
  });
});
