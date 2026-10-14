import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningPanel } from "./reasoning-panel";

function renderPanel(streaming: boolean) {
  return renderToStaticMarkup(
    createElement(ReasoningPanel, {
      steps: [{ title: "Reasoning", body: "Considered the schema ".repeat(80) }],
      visibleSteps: 1,
      streaming,
      open: true,
      onOpenChange: () => undefined,
      restingLabel: "Reasoned for 3s",
      elapsed: "3s",
    }),
  );
}

describe("ReasoningPanel", () => {
  test("caps the reasoning body in a scroll region while streaming", () => {
    const markup = renderPanel(true);

    expect(markup).toContain('data-slot="reasoning-panel-scroll"');
    expect(markup).toContain("max-h-64");
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("Considered the schema");
  });

  test("keeps the same bounded body after the stream settles", () => {
    const markup = renderPanel(false);

    expect(markup).toContain('data-slot="reasoning-panel-scroll"');
    expect(markup).toContain("max-h-64");
    expect(markup).toContain("Reasoned for 3s");
  });
});
