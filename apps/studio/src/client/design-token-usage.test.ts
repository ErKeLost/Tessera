import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import postcss from "postcss";

const clientDirectory = import.meta.dir;
const componentStylesheets = filesWithExtensionIn(clientDirectory, ".css")
  .filter((file) => file !== join(clientDirectory, "theme.css"));

const rawColor = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(|\b(?:black|white)\b/i;
const allowedFontWeights = new Set([400, 500, 600]);
const allowedLetterSpacing = new Set([
  "0",
  "var(--tracking-body)",
  "var(--tracking-display)",
]);

const forbiddenSourceUtility = /(?:bg|text|border|ring|outline|fill|stroke)-(?:black|white|red|green|blue|orange|amber|yellow|purple|violet|indigo|pink|slate|gray|zinc|neutral|stone)(?:[\s/\-'"`]|$)|\bshadow-(?:xs|sm|md|lg|xl|2xl)\b|\bz-\[\d+\]|#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/gi;

function filesWithExtensionIn(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesWithExtensionIn(path, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}

describe("Studio design token usage", () => {
  test("keeps foundation values out of component stylesheets", () => {
    const violations: string[] = [];

    for (const stylesheet of componentStylesheets) {
      const root = postcss.parse(readFileSync(stylesheet, "utf8"), { from: stylesheet });
      root.walkDecls((declaration) => {
        const location = `${basename(stylesheet)}:${declaration.source?.start?.line ?? 0}`;

        if (rawColor.test(declaration.value)) {
          violations.push(`${location} uses a raw color in ${declaration.prop}`);
        }

        if (declaration.prop === "font-weight" && /^\d+$/.test(declaration.value)) {
          const weight = Number(declaration.value);
          if (!allowedFontWeights.has(weight)) {
            violations.push(`${location} uses unsupported font weight ${weight}`);
          }
        }

        if (
          declaration.prop === "letter-spacing" &&
          !allowedLetterSpacing.has(declaration.value)
        ) {
          violations.push(`${location} bypasses the zero-tracking contract`);
        }

        if (declaration.prop === "z-index" && /^\d+$/.test(declaration.value)) {
          const layer = Number(declaration.value);
          if (layer >= 20) {
            violations.push(`${location} bypasses the semantic z-index scale`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });

  test("keeps raw palette and elevation utilities out of component source", () => {
    const violations = filesWithExtensionIn(clientDirectory, ".tsx").flatMap((sourceFile) => {
      const source = readFileSync(sourceFile, "utf8");
      return [...source.matchAll(forbiddenSourceUtility)].map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${sourceFile.slice(clientDirectory.length + 1)}:${line} uses ${match[0].trim()}`;
      });
    });

    expect(violations).toEqual([]);
  });
});
