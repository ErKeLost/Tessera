import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { baseOptions } from "./layout.shared";

const publicSections = ["agent", "components", "concepts", "integrations"] as const;

describe("Tessera documentation navigation", () => {
  for (const locale of ["en", "zh"] as const) {
    test(`${locale} navigation targets real landing pages`, () => {
      for (const section of publicSections) {
        const file = locale === "zh" ? "index.zh.mdx" : "index.mdx";
        const path = resolve(import.meta.dir, `../../content/docs/${section}/${file}`);

        expect(existsSync(path)).toBe(true);
      }
    });
  }

  test("publishes the branded navigation and three-state theme switch", () => {
    const options = baseOptions("zh");

    expect(options.nav?.title).toBeTruthy();
    expect(options.themeSwitch).toEqual({
      enabled: true,
      mode: "light-dark-system",
    });
    expect(options.links?.some((link) => "url" in link && link.url === "/background")).toBe(false);
  });
});
