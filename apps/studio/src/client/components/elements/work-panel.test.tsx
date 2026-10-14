import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkPanel } from "./work-panel";

function render(props: { streaming: boolean; elapsed?: string }) {
  return renderToStaticMarkup(
    createElement(WorkPanel, {
      ...props,
      open: true,
      onOpenChange: () => undefined,
      children: createElement("span", null, "list_database"),
    }),
  );
}

describe("WorkPanel", () => {
  test("labels the wrapped trace as working while it streams", () => {
    const markup = render({ streaming: true, elapsed: "2m 35s" });

    expect(markup).toContain('data-slot="work-panel"');
    expect(markup).toContain("Working");
    expect(markup).toContain("for 2m 35s");
    // Only the streaming layer shimmers; the resting layer is inert.
    expect(markup).toContain("shimmer");
    expect(markup).toContain("list_database");
  });

  test("drives open state and motion off the Radix data-state contract", () => {
    const markup = render({ streaming: true });

    // Radix emits `data-state`; the Base UI `data-open` / `data-ending-style`
    // variants compile to nothing and leave the chevron and panel frozen.
    expect(markup).toContain("group-data-[state=open]/trigger:rotate-90");
    expect(markup).toContain("data-[state=open]:animate-collapsible-down");
    expect(markup).toContain("data-[state=closed]:animate-collapsible-up");
    expect(markup).not.toContain("data-ending-style");
    expect(markup).toContain("work-panel-body");
  });

  test("settles to a worked label with the finished duration", () => {
    const markup = render({ streaming: false, elapsed: "2m 35s" });

    expect(markup).toContain("Worked for 2m 35s");
    expect(markup).not.toContain("shimmer");
  });

  test("drops the duration before the first tick", () => {
    const markup = render({ streaming: false });

    expect(markup).toContain("Worked");
    expect(markup).not.toContain("Worked for");
  });
});
