import { describe, expect, test } from "bun:test";
import {
  buildAnswerContract,
  buildCorePolicy,
  buildDataCopilotInstructions,
  buildTaskPolicy,
} from "./prompt";

describe("Tessera prompt composition", () => {
  test("keeps the four prompt concerns in a stable order", () => {
    const prompt = buildDataCopilotInstructions();
    expect(prompt.indexOf("<core_policy>")).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf("<task_policy>")).toBeGreaterThan(prompt.indexOf("</core_policy>"));
    expect(prompt.indexOf("<answer_contract>")).toBeGreaterThan(prompt.indexOf("</task_policy>"));
    expect(prompt).not.toContain("<tool_use>");
  });

  test("keeps tool schemas as the source of truth", () => {
    expect(buildTaskPolicy()).toContain("tool descriptions and schemas are the source of truth");
    expect(buildTaskPolicy()).toContain("one primary query path");
    expect(buildTaskPolicy()).toContain("execute_sql with the returned analysisRef unchanged");
  });

  test("preserves evidence and authorization boundaries", () => {
    expect(buildCorePolicy()).toContain("Only verified execution output supports a business claim");
    expect(buildCorePolicy()).toContain("Mutations must use the governed mutation path");
    expect(buildAnswerContract()).toContain("never claim success before execution confirms it");
  });
});

