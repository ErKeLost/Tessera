import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeErrorBoundary } from "./node-error-boundary";

describe("NodeErrorBoundary", () => {
  test("owns fallback, reporting, and snapshot-driven reset state per node", () => {
    const reports: unknown[] = [];
    const props = {
      children: <div>node</div>,
      fallback: (error: unknown) => <div>failed: {String(error)}</div>,
      onError: (error: unknown) => { reports.push(error); },
      resetKey: "node:revision:contract:1",
      resetToken: "renderer-a",
    };
    const boundary = new NodeErrorBoundary(props);
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toContain("node");

    const error = new Error("renderer failed");
    boundary.state = {
      ...boundary.state,
      ...NodeErrorBoundary.getDerivedStateFromError(error),
    };
    boundary.componentDidCatch(error, { componentStack: "\n at Renderer" });
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toContain(
      "failed: Error: renderer failed",
    );
    expect(reports).toEqual([error]);

    expect(NodeErrorBoundary.getDerivedStateFromProps(props, boundary.state)).toBeNull();
    expect(NodeErrorBoundary.getDerivedStateFromProps({
      ...props,
      resetKey: "node:revision:contract:2",
    }, boundary.state)).toEqual({
      failed: false,
      resetKey: "node:revision:contract:2",
      resetToken: "renderer-a",
    });
    expect(NodeErrorBoundary.getDerivedStateFromProps({
      ...props,
      resetToken: "renderer-b",
    }, boundary.state)).toEqual({
      failed: false,
      resetKey: "node:revision:contract:1",
      resetToken: "renderer-b",
    });
  });
});
