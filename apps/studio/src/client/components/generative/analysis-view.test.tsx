import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisView } from "./analysis-view";

const PROGRAM = [
  "root = Stack([title, body, total])",
  'title = Heading("Orders")',
  'body = Text("Counted from the read-only query.")',
  'total = Metric("Rows", "1,670")',
].join("\n");

describe("AnalysisView", () => {
  test("renders a program that has a root", () => {
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={PROGRAM} />);

    expect(html).toContain("1,670");
    expect(html).toContain("tessera-analysis-heading");
    expect(html).toContain("Counted from the read-only query.");
  });

  test("renders a program that has a root even while it streams", () => {
    const html = renderToStaticMarkup(
      <AnalysisView isStreaming response={'root = Stack([a])\na = Metric("Rows", "1,670")'} />,
    );

    expect(html).toContain('data-streaming="true"');
    expect(html).toContain("1,670");
  });

  test("shows a response with no root as prose instead of an error box", () => {
    const html = renderToStaticMarkup(
      <AnalysisView isStreaming={false} response={"I could not run that query."} />,
    );

    expect(html).toContain("I could not run that query.");
    expect(html).not.toContain("did not arrive");
    expect(html).not.toContain("tessera-analysis-fallback");
    expect(html).not.toContain("border-dashed");
  });

  test("renders nothing for an empty response", () => {
    expect(renderToStaticMarkup(<AnalysisView isStreaming={false} response="  " />)).toBe("");
  });

  test("stays on the program after a prose response, without latching", () => {
    renderToStaticMarkup(<AnalysisView isStreaming={false} response={"no root here"} />);
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={PROGRAM} />);

    expect(html).toContain("1,670");
    expect(html).not.toContain("no root here");
  });
});
