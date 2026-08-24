import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenGenerativeRenderer } from "./open-generative-renderer";

describe("OpenGenerativeRenderer", () => {
  test("owns a stable loading boundary before the trusted event is consumed", () => {
    const html = renderToStaticMarkup(
      <OpenGenerativeRenderer
        className="host-surface"
        stream={{ surfaceSessionId: "surface-loading", events: [] } as never}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="host-surface"');
    expect(html).toContain('data-og-renderer="loading"');
  });
});
