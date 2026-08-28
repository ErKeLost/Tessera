import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss, { type Rule } from "postcss";
import { DEFAULT_OPEN_GENERATIVE_THEME_PRESET } from "../open-generative-theme-preset";
import { openGenerativeThemeFor } from "./open-generative-theme";

const themeStylesheet = postcss.parse(
  readFileSync(new URL("./theme.css", import.meta.url), "utf8"),
);

function topLevelTokensFor(selector: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();

  themeStylesheet.each((node) => {
    if (node.type !== "rule") return;
    const rule = node as Rule;
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(/^--/, (declaration) => {
      tokens.set(declaration.prop, declaration.value);
    });
  });

  return tokens;
}

const foundationTokens = topLevelTokensFor(":root");
const lightTokens = topLevelTokensFor(':root[data-theme="light"]');
const darkTokens = topLevelTokensFor(':root[data-theme="dark"]');

const themedSourceTokens = [
  "--ds-color-canvas",
  "--ds-color-ink",
  "--ds-color-body",
  "--ds-color-mute",
  "--ds-color-faint",
  "--ds-color-surface-raised",
  "--ds-color-surface-overlay",
  "--ds-color-surface-secondary",
  "--ds-color-surface-sunken",
  "--ds-color-surface-muted",
  "--ds-color-surface-hover",
  "--ds-color-surface-selected",
  "--ds-color-border",
  "--ds-color-border-strong",
  "--ds-color-on-primary",
  "--ds-color-focus",
  "--ds-color-link",
  "--ds-color-link-hover",
  "--ds-color-selection",
  "--ds-color-on-selection",
  "--ds-color-error",
  "--ds-color-on-error",
  "--ds-color-warning",
  "--ds-color-on-warning",
  "--ds-color-success",
  "--ds-color-on-success",
  "--ds-color-scrim",
  "--ds-color-media-scrim",
  "--ds-color-media-control",
  "--ds-color-media-control-hover",
  "--ds-color-media-foreground",
  "--ds-color-media-border",
  "--ds-chart-1",
  "--ds-chart-2",
  "--ds-chart-3",
  "--ds-chart-4",
  "--ds-chart-5",
  "--ds-shadow-whisper",
  "--ds-shadow-float",
  "--ds-shadow-overlay",
  "--ds-shadow-focus",
  "--ds-scrollbar-track",
  "--ds-scrollbar-thumb",
  "--ds-scrollbar-thumb-hover",
  "--ds-scrollbar-thumb-active",
  "--ds-scrollbar-thumb-border",
] as const;

const semanticAliases = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--input",
  "--ring",
  "--link",
  "--link-hover",
  "--destructive",
  "--destructive-foreground",
  "--warning",
  "--warning-foreground",
  "--success",
  "--success-foreground",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--surface-raised",
  "--surface-sunken",
  "--surface-hover",
  "--surface-selected",
  "--text-secondary",
  "--text-muted",
  "--text-faint",
  "--border-subtle",
  "--border-strong",
  "--selection-background",
  "--selection-foreground",
  "--overlay-scrim",
  "--media-scrim",
  "--media-control",
  "--media-control-hover",
  "--media-foreground",
  "--media-border",
] as const;

describe("Studio design token contract", () => {
  test("keeps complete, symmetric light and dark foundation palettes", () => {
    expect([...darkTokens.keys()].sort()).toEqual([...lightTokens.keys()].sort());

    for (const token of themedSourceTokens) {
      const lightValue = lightTokens.get(token);
      const darkValue = darkTokens.get(token);

      expect(lightValue, `${token} is missing from the light theme`).toBeDefined();
      expect(darkValue, `${token} is missing from the dark theme`).toBeDefined();
      expect(lightValue, `${token} must be an explicit light foundation value`).not.toContain(
        "var(",
      );
      expect(darkValue, `${token} must be an explicit dark foundation value`).not.toContain(
        "var(",
      );
    }

    expect(lightTokens.get("--ds-color-canvas")).toBe("#fafafa");
    expect(lightTokens.get("--ds-color-ink")).toBe("#171717");
    expect(lightTokens.get("--ds-color-border")).toBe("#ebebeb");
    expect(lightTokens.get("--ds-color-link")).toBe("#0070f3");
    expect(darkTokens.get("--ds-color-canvas")).toBe("#0a0a0a");
    expect(darkTokens.get("--ds-color-ink")).toBe("#ededed");
    expect(darkTokens.get("--ds-color-focus")).toBe("#3291ff");
  });

  test("defines the complete Geist geometry, type, layer, and motion scales", () => {
    expect(
      [1, 2, 3, 4, 6, 8, 10, 16, 24, 32].map((step) =>
        foundationTokens.get(`--ds-space-${step}`),
      ),
    ).toEqual([
      "0.25rem",
      "0.5rem",
      "0.75rem",
      "1rem",
      "1.5rem",
      "2rem",
      "2.5rem",
      "4rem",
      "6rem",
      "8rem",
    ]);
    expect([
      foundationTokens.get("--ds-control-height-sm"),
      foundationTokens.get("--ds-control-height-md"),
      foundationTokens.get("--ds-control-height-lg"),
    ]).toEqual(["1.875rem", "2.25rem", "2.75rem"]);
    expect([
      foundationTokens.get("--ds-radius-indicator"),
      foundationTokens.get("--ds-radius-compact"),
      foundationTokens.get("--ds-radius-control"),
      foundationTokens.get("--ds-radius-card"),
      foundationTokens.get("--ds-radius-overlay"),
      foundationTokens.get("--ds-radius-full"),
    ]).toEqual(["0.125rem", "0.25rem", "0.375rem", "0.75rem", "1rem", "9999px"]);

    for (const token of [
      "--ds-font-sans",
      "--ds-font-mono",
      "--ds-font-size-micro",
      "--ds-font-size-body",
      "--ds-font-size-display",
      "--ds-font-weight-regular",
      "--ds-font-weight-medium",
      "--ds-font-weight-semibold",
      "--ds-line-height-body",
      "--ds-letter-spacing-body",
      "--ds-duration-fast",
      "--ds-duration-base",
      "--ds-duration-slow",
      "--ds-ease-standard",
      "--ds-ease-enter",
      "--ds-ease-exit",
      "--ds-z-sticky",
      "--ds-z-dropdown",
      "--ds-z-popover",
      "--ds-z-dialog",
      "--ds-z-toast",
      "--ds-z-tooltip",
    ]) {
      expect(foundationTokens.get(token), `${token} is missing`).toBeDefined();
    }

    expect([
      foundationTokens.get("--ds-z-sticky"),
      foundationTokens.get("--ds-z-dropdown"),
      foundationTokens.get("--ds-z-dialog"),
      foundationTokens.get("--ds-z-popover"),
      foundationTokens.get("--ds-z-toast"),
      foundationTokens.get("--ds-z-tooltip"),
    ].map(Number)).toEqual([20, 80, 100, 110, 120, 140]);
  });

  test("keeps component aliases as one-hop references to canonical sources", () => {
    const availableSources = new Set([
      ...[...foundationTokens.keys()].filter((token) => token.startsWith("--ds-")),
      ...themedSourceTokens,
    ]);

    for (const alias of semanticAliases) {
      expect(foundationTokens.get(alias), `${alias} is missing`).toBeDefined();
    }

    for (const [alias, value] of foundationTokens) {
      if (alias.startsWith("--ds-")) {
        expect(value, `${alias} must be an explicit foundation value`).not.toContain("var(");
        continue;
      }
      expect(value, `${alias} is missing`).toMatch(/^var\((--ds-[a-z0-9-]+)\)$/);
      const source = value.match(/^var\((--ds-[a-z0-9-]+)\)$/)?.[1];
      expect(availableSources.has(source ?? ""), `${alias} references ${source}`).toBe(true);
    }
  });
});

describe("Open Generative theme registry", () => {
  test("resolves both modes from the fixed shadcn preset", () => {
    expect(DEFAULT_OPEN_GENERATIVE_THEME_PRESET).toBe("b7VWPDLHc");

    const light = openGenerativeThemeFor("light", DEFAULT_OPEN_GENERATIVE_THEME_PRESET);
    const dark = openGenerativeThemeFor("dark", DEFAULT_OPEN_GENERATIVE_THEME_PRESET);

    const expectedTokens = {
      background: "var(--ds-color-canvas)",
      foreground: "var(--ds-color-ink)",
      surface: "var(--ds-color-surface-raised)",
      mutedForeground: "var(--ds-color-body)",
      border: "var(--ds-color-border)",
      input: "var(--ds-color-border-strong)",
      primary: "var(--ds-color-ink)",
      ring: "var(--ds-color-focus)",
      card: "var(--ds-color-surface-raised)",
      cardForeground: "var(--ds-color-ink)",
      radius: "var(--ds-radius-card)",
      chart: [
        "var(--ds-chart-1)",
        "var(--ds-chart-2)",
        "var(--ds-chart-3)",
        "var(--ds-chart-4)",
        "var(--ds-chart-5)",
      ],
    } as const;
    expect(light.name).toBe("shadcn-lyra-taupe-light");
    expect(light.mode).toBe("light");
    expect(dark.name).toBe("shadcn-lyra-taupe-dark");
    expect(dark.mode).toBe("dark");
    expect(light.tokens).toEqual(expectedTokens);
    expect(dark.tokens).toEqual(expectedTokens);
    expect(light.tokens.surface).not.toBe(light.tokens.foreground);
    expect(dark.tokens.surface).not.toBe(dark.tokens.foreground);
  });
});
