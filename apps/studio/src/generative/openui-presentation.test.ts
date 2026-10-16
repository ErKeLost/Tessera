import { describe, expect, test } from "bun:test";
import { shadcnChatLibrary } from "../client/components/generative/shadcn-genui";
import { compileAnswerPrompts } from "./openui-answer-prompt";
import { ANALYSIS_ROOT, buildAnalysisPresentationPrompt } from "./openui-presentation";
import {
  OPENUI_ACTION_SYSTEM_PROMPT,
  OPENUI_SYSTEM_PROMPT,
} from "./openui-system-prompt.generated";

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

  test("teaches live reads to every Studio but never a write to a read-only one", () => {
    expect(OPENUI_SYSTEM_PROMPT).toContain("relation_preview");
    expect(OPENUI_SYSTEM_PROMPT).toContain("relation_metrics");
    expect(OPENUI_SYSTEM_PROMPT).toContain("Query(");
    expect(OPENUI_SYSTEM_PROMPT).toContain("This Studio is read-only");
    expect(OPENUI_SYSTEM_PROMPT).not.toContain("database_action");
  });

  test("teaches the governed action tool only when changes are available", () => {
    const readOnly = buildAnalysisPresentationPrompt({ databaseActions: false });
    const readWrite = buildAnalysisPresentationPrompt({ databaseActions: true });

    expect(readOnly).toBe(prompt);
    expect(readOnly).not.toContain("database_action");
    expect(readWrite).toContain("database_action");
    expect(readWrite).toContain("relation_preview");
    expect(readWrite).toContain("relation_metrics");
    expect(readWrite).toContain("Mutation(");
    expect(readWrite).toContain("@Run(");
    expect(readWrite).not.toContain("This Studio is read-only");
    expect(readWrite).toContain(OPENUI_ACTION_SYSTEM_PROMPT);
  });

  test("keeps both contracts in sync with the library and tool specs", () => {
    // Regenerating here catches a library or tool change that was not
    // recompiled, the same way the official example regenerates before dev/build.
    const regenerated = compileAnswerPrompts();

    expect(regenerated.base).toBe(OPENUI_SYSTEM_PROMPT);
    expect(regenerated.actions).toBe(OPENUI_ACTION_SYSTEM_PROMPT);
    expect(shadcnChatLibrary.root).toBe(ANALYSIS_ROOT);
  });
});
