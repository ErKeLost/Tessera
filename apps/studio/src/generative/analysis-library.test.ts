import { describe, expect, test } from "bun:test";
import { analysisBlockSpecs } from "./analysis-components";
import { ANALYSIS_ROOT, buildAnalysisPresentationPrompt } from "./analysis-library";

describe("buildAnalysisPresentationPrompt", () => {
  const prompt = buildAnalysisPresentationPrompt();

  test("wraps the generated contract in one agent-instruction section", () => {
    expect(prompt.startsWith("<analysis_view>")).toBe(true);
    expect(prompt.trimEnd().endsWith("</analysis_view>")).toBe(true);
    expect(ANALYSIS_ROOT).toBe("Stack");
  });

  test("teaches every component the renderer implements", () => {
    for (const spec of analysisBlockSpecs) {
      expect(prompt).toContain(`${spec.name}(`);
    }
    expect(prompt).toContain("Stack(children");
    expect(prompt).toContain("Grid(children");
    expect(prompt).toContain("Section(title");
  });

  test("is OpenUI's default prompt and nothing else", () => {
    // The default opener, unchanged.
    expect(prompt).toContain("Your ENTIRE response must be valid openui-lang code");
    expect(prompt).toContain("root = Stack(...)");
    expect(prompt).toContain("POSITIONAL");
    // No prompt options were passed, so none of their sections may appear.
    expect(prompt).not.toContain("You are in inline mode");
    expect(prompt).not.toContain("## Preamble");
    expect(prompt).not.toContain("## Additional Rules");
    expect(prompt).not.toContain("## Examples");
  });

  test("does not enable the tool or form workflows Tessera does not expose", () => {
    expect(prompt).not.toContain("Mutation(");
    expect(prompt).not.toContain("@Set(");
    expect(prompt).not.toContain("Query(");
  });

  test("is stable across calls so instructions do not churn per request", () => {
    expect(buildAnalysisPresentationPrompt()).toBe(prompt);
  });
});
