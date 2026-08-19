import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "..");
const serverOnlyPackages = [
  "ai-sdk",
  "capability-broker",
  "compiler",
  "evals",
  "mastra",
  "release",
  "resources",
] as const;

describe("server-only package boundaries", () => {
  for (const packageName of serverOnlyPackages) {
    test(`${packageName} fails closed in browser builds`, async () => {
      const packageDirectory = join(root, "packages", packageName);
      const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
      expect(manifest.exports?.["."]?.browser).toBe("./dist/browser.mjs");
      expect(manifest.sideEffects).toContain("./dist/browser.mjs");

      const browserEntry = pathToFileURL(join(packageDirectory, "src", "browser.ts")).href;
      await expect(import(`${browserEntry}?boundary=${packageName}`)).rejects.toThrow();
    });
  }
});
