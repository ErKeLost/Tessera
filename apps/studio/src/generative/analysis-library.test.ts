import { describe, expect, test } from "bun:test";
import { analysisLeafSpecs } from "./analysis-components";
import {
  analysisPresentationExamples,
  analysisPresentationRules,
  analysisViewSyntax,
  buildAnalysisPresentationPrompt,
} from "./analysis-library";

describe("buildAnalysisPresentationPrompt", () => {
  const prompt = buildAnalysisPresentationPrompt();

  test("wraps the generated contract in one agent-instruction section", () => {
    expect(prompt.startsWith("<analysis_view>")).toBe(true);
    expect(prompt.trimEnd().endsWith("</analysis_view>")).toBe(true);
    expect(analysisViewSyntax).toEqual({ fence: "openui-lang", root: "Stack" });
  });

  test("teaches every component that the renderer implements", () => {
    for (const spec of analysisLeafSpecs) {
      expect(prompt).toContain(`${spec.name}(`);
    }
    expect(prompt).toContain("Stack(children");
    expect(prompt).toContain("Grid(children");
    expect(prompt).toContain("Section(title");
  });

  test("states the positional-argument and root rules the parser enforces", () => {
    expect(prompt).toContain("root = Stack(...)");
    expect(prompt).toContain("POSITIONAL");
    expect(prompt).toContain("openui-lang");
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
