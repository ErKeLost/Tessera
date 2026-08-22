import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const documents = [
  "mastra.mdx",
  "mastra.zh.mdx",
] as const;

describe("Mastra integration documentation", () => {
  for (const document of documents) {
    test(`${document} keeps the incremental and observability gates`, () => {
      const content = readFileSync(
        resolve(import.meta.dir, `../../content/docs/integrations/${document}`),
        "utf8",
      );

      expect(content).toContain("createMastraIncrementalPresentUi");
      expect(content).toContain("createIncrementalPresentUiCompilerSession");
      expect(content).toContain("MASTRA_PRESENT_UI_TRACING_OPTIONS");
      expect(content).toContain("maxAttempts: 3");
      expect(content).not.toContain("createMastraPresentUi({");
      expect(content.match(/tracingOptions: presentUi\.tracingOptions/g)?.length ?? 0)
        .toBeGreaterThanOrEqual(2);
      expect(content).toMatch(
        /agent\.generate\([\s\S]*?tracingOptions: presentUi\.tracingOptions[\s\S]*?\);/,
      );
      expect(content).toMatch(
        /agent\.stream\([\s\S]*?tracingOptions: presentUi\.tracingOptions[\s\S]*?\);/,
      );
      expect(content).toContain("...presentUi.tracingOptions");
    });
  }
});
