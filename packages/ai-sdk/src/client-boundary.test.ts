import { describe, expect, test } from "bun:test";

const CLIENT_SOURCES = ["client.ts", "index.ts", "wire.ts"] as const;
const FORBIDDEN = [
  "@open-generative/compiler",
  "@open-generative/server",
  "@open-generative/resources",
  "@open-generative/capabilities",
] as const;

describe("AI SDK client boundary", () => {
  test("does not import server authorities or Node builtins", async () => {
    const sources = await Promise.all(CLIENT_SOURCES.map((file) => (
      Bun.file(new URL(file, import.meta.url)).text()
    )));
    for (const source of sources) {
      for (const forbidden of FORBIDDEN) expect(source).not.toContain(forbidden);
      expect(source).not.toMatch(/(?:from\s+|import\s*\()\s*["']node:/);
    }
  });

  test("keeps server and client APIs behind explicit subpaths", async () => {
    const root = await Bun.file(new URL("index.ts", import.meta.url)).text();
    expect(root).not.toContain('"./server"');
    expect(root).not.toContain('"./client"');
  });
});
