import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  test("keeps its retry action as a non-wrapping shadcn control", () => {
    const markup = renderToStaticMarkup(createElement(ErrorState, {
      detail: "OpenRouter 403: This account or model is not authorized for the request.",
      onRetry: () => undefined,
      retrying: false,
      title: "Analysis interrupted",
    }));

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain('aria-label="Retry analysis"');
    expect(markup).toContain("whitespace-nowrap");
  });

  test("does not apply the destructive surface state while retrying", () => {
    const markup = renderToStaticMarkup(createElement(ErrorState, {
      detail: "The request failed.",
      onRetry: () => undefined,
      retrying: true,
      title: "Analysis interrupted",
    }));

    expect(markup).toContain('data-state="retrying"');
    expect(markup).not.toContain('data-state="error"');
  });
});
