import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const documents = [
  "mastra.mdx",
  "mastra.zh.mdx",
] as const;

describe("Mastra integration documentation", () => {
  for (const document of documents) {
    test(`${document} documents the high-level Processor and observability gate`, () => {
      const content = readFileSync(
        resolve(import.meta.dir, `../../content/docs/integrations/${document}`),
        "utf8",
      );

      expect(content).toContain("createOpenGenerativeHost");
      expect(content).toContain("createOpenGenerativeMastraProcessor");
      expect(content).toContain("MASTRA_PRESENT_UI_TRACING_OPTIONS");
      expect(content).toContain("host.prepareTurn");
      expect(content).toContain("inputProcessors: [openGenerative]");
      expect(content).toContain("data-openGenerativeSurface");
      expect(content).toContain("OpenGenerativeRenderer");
      expect(content).not.toContain("createMastraIncrementalPresentUi");
      expect(content).not.toContain("createIncrementalPresentUiCompilerSession");
      expect(content).toMatch(
        /agent\.stream\([\s\S]*?tracingOptions: MASTRA_PRESENT_UI_TRACING_OPTIONS[\s\S]*?\);/,
      );
    });
  }
});
