import { describe, expect, test } from "bun:test";
import { generateSystemPrompt } from "@openuidev/lang-core";
import { shadcnChatLibrary, shadcnPromptOptions } from "../client/components/generative/shadcn-genui";
import { ANALYSIS_ROOT, buildAnalysisPresentationPrompt } from "./openui-presentation";
import { OPENUI_SYSTEM_PROMPT } from "./openui-system-prompt.generated";

describe("buildAnalysisPresentationPrompt", () => {
  const prompt = buildAnalysisPresentationPrompt();

  test("wraps the generated contract in one agent-instruction section", () => {
    expect(prompt.startsWith("<analysis_view>")).toBe(true);
    expect(prompt.trimEnd().endsWith("</analysis_view>")).toBe(true);
    expect(ANALYSIS_ROOT).toBe("Card");
  });

  test("is the contract compiled from the library the browser renders with", () => {
    expect(prompt).toContain(OPENUI_SYSTEM_PROMPT);
    expect(prompt).toContain("root = Card(...)");
    // The vocabulary the browser implements, so every taught node is renderable.
    expect(prompt).toContain("FollowUpBlock(items");
    expect(prompt).toContain("CardHeader(title");
    expect(prompt).toContain("Table(columns");
  });

  test("does not enable the tool or form workflows Tessera does not expose", () => {
    expect(OPENUI_SYSTEM_PROMPT).not.toContain("Mutation(");
    expect(OPENUI_SYSTEM_PROMPT).not.toContain("@Set(");
    expect(OPENUI_SYSTEM_PROMPT).not.toContain("Query(");
  });

  test("stays in sync with the component library", () => {
    // Regenerating here catches a library change that was not recompiled, the
    // same way the official example regenerates its prompt before dev/build.
    const regenerated = generateSystemPrompt({
      library: shadcnChatLibrary.toSpec(),
      promptOptions: shadcnPromptOptions,
    });

    expect(regenerated).toBe(OPENUI_SYSTEM_PROMPT);
  });
});
