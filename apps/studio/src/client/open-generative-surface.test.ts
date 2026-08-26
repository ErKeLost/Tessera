import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OpenGenerativeFallbackDataRenderer,
  openGenerativeFallbackErrorMessage,
  openGenerativeSurfaceErrorMessage,
} from "./open-generative-surface";

describe("Open Generative Surface errors", () => {
  test("shows the renderer diagnostic instead of replacing it with a generic catalog error", () => {
    expect(openGenerativeSurfaceErrorMessage(
      new TypeError("The Surface snapshot Catalog lock does not match the trusted browser Catalog."),
    )).toBe("The Surface snapshot Catalog lock does not match the trusted browser Catalog.");
  });

  test("uses a bounded fallback for unknown errors", () => {
    expect(openGenerativeSurfaceErrorMessage(undefined)).toBe(
      "The generated surface could not be validated by the installed component catalog.",
    );
    expect(openGenerativeSurfaceErrorMessage("x".repeat(2_100))).toHaveLength(2_000);
  });

  test("renders the public compile diagnostic carried by a valid fallback", () => {
    const data = {
      state: "discarded",
      reason: "invalid-presentation",
      diagnostic: "OGL output did not resolve a root component.",
    };

    expect(openGenerativeFallbackErrorMessage(data)).toBe(data.diagnostic);
    expect(renderToStaticMarkup(createElement(OpenGenerativeFallbackDataRenderer, { data }))).toContain(
      data.diagnostic,
    );
  });

  test("uses an OGL compile default when an older valid fallback has no diagnostic", () => {
    expect(openGenerativeFallbackErrorMessage({
      state: "discarded",
      reason: "invalid-presentation",
    })).toBe("The generated Open Generative Language could not be compiled.");
  });

  test("rejects fallback diagnostics outside the public protocol boundary", () => {
    expect(openGenerativeFallbackErrorMessage({
      state: "discarded",
      reason: "invalid-presentation",
      diagnostic: "first line\n    at internal/file.ts:1:1",
    })).toBeUndefined();
  });
});
