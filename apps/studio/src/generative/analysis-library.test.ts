import { describe, expect, test } from "bun:test";
import { analysisBlockSpecs, analysisContentSpecs } from "./analysis-components";
import {
  ANALYSIS_ROOT,
  ANALYSIS_TEXT_COMPONENTS,
  analysisPresentationExamples,
  analysisPresentationRules,
  buildAnalysisPresentationPrompt,
} from "./analysis-library";

describe("buildAnalysisPresentationPrompt", () => {
  const prompt = buildAnalysisPresentationPrompt();

  test("wraps the generated contract in one agent-instruction section", () => {
    expect(prompt.startsWith("<analysis_view>")).toBe(true);
    expect(prompt.trimEnd().endsWith("</analysis_view>")).toBe(true);
    expect(ANALYSIS_ROOT).toBe("Stack");
  });

  test("teaches every component that the renderer implements", () => {
    for (const spec of analysisBlockSpecs) {
      expect(prompt).toContain(`${spec.name}(`);
    }
    expect(prompt).toContain("Stack(children");
    expect(prompt).toContain("Grid(children");
    expect(prompt).toContain("Section(title");
  });

  test("makes the whole response a program rather than prose with a fence", () => {
    // The official OpenUI shape: the model's entire reply is openui-lang.
    expect(prompt).toContain("Your ENTIRE response must be valid openui-lang code");
    expect(prompt).not.toContain("You are in inline mode");
    expect(prompt).toContain("root = Stack(...)");
    expect(prompt).toContain("POSITIONAL");
  });

  test("always gives the model a way to write the answer itself", () => {
    expect(ANALYSIS_TEXT_COMPONENTS).toEqual(["Heading", "Text", "Bullets"]);
    for (const name of ANALYSIS_TEXT_COMPONENTS) {
      expect(analysisContentSpecs.some((spec) => spec.name === name)).toBe(true);
      expect(prompt).toContain(`${name}(`);
    }
  });

  test("keeps every Tessera presentation boundary", () => {
    for (const rule of analysisPresentationRules) {
      expect(prompt).toContain(rule);
    }
    for (const example of analysisPresentationExamples) {
      expect(prompt).toContain(example);
    }
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
