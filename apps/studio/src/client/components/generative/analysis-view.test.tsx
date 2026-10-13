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
  test("renders the program and never the fallback while a message is intact", () => {
    const html = renderToStaticMarkup(<AnalysisView isStreaming={false} response={PROGRAM} />);

    expect(html).toContain("tessera-analysis");
    expect(html).toContain("1,670");
    // The first render happens before the parser reports, so it must not guess.
    expect(html).not.toContain("tessera-analysis-fallback");
  });

  test("marks the surface as streaming while the answer is still arriving", () => {
    const html = renderToStaticMarkup(<AnalysisView isStreaming response={"root = Stack([a])"} />);

    expect(html).toContain('data-streaming="true"');
  });
});
