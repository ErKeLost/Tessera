import { describe, expect, test } from "bun:test";

const BROWSER_SOURCES = [
  "generative-surface.tsx",
  "index.ts",
  "node-error-boundary.tsx",
  "renderer-registry.ts",
  "system-surfaces.tsx",
  "types.ts",
] as const;

const FORBIDDEN_IMPORTS = [
  "@open-generative/server",
  "@open-generative/compiler",
  "@open-generative/resources",
  "@open-generative/capabilities",
] as const;

describe("React browser boundary", () => {
  test("does not import server authorities or Node builtins", async () => {
    const sources = await Promise.all(BROWSER_SOURCES.map((file) => (
      Bun.file(new URL(file, import.meta.url)).text()
    )));
    for (const source of sources) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(source).not.toContain(forbidden);
      }
      expect(source).not.toMatch(/(?:from\s+|import\s*\()\s*["']node:/);
    }
  });

  test("marks the public React entry as a client boundary", async () => {
    const source = await Bun.file(new URL("index.ts", import.meta.url)).text();
    expect(source.trimStart().startsWith('"use client";')).toBe(true);
  });
});
