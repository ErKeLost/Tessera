import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readIntegration(document: string): string {
  return readFileSync(
    resolve(import.meta.dir, `../../content/docs/integrations/${document}`),
    "utf8",
  );
}

describe("Tessera runtime documentation", () => {
  for (const document of ["mastra.mdx", "mastra.zh.mdx"] as const) {
    test(`${document} documents native Mastra step persistence`, () => {
      const content = readIntegration(document);

      expect(content).toContain("savePerStep");
      expect(content).toContain("observationalMemory: false");
      expect(content).toContain("workingMemory: tesseraWorkingMemoryOptions");
      expect(content).toContain('scope: "resource"');
      expect(content).toContain("agentManaged: true");
      expect(content).not.toContain("workingMemory: { enabled: false }");
      expect(content).not.toContain("@open-generative/mastra");
      expect(content).not.toContain("OpenGenerativeRenderer");
    });
  }

  for (const document of ["ai-sdk.mdx", "ai-sdk.zh.mdx"] as const) {
    test(`${document} documents native AI SDK UI message assembly`, () => {
      const content = readIntegration(document);

      expect(content).toContain("createUIMessageStream");
      expect(content).toContain("onStepEnd");
      expect(content).toContain("onEnd");
      expect(content).not.toContain("OpenGenerativeRenderer");
    });
  }
});
