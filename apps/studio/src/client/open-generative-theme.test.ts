import { describe, expect, test } from "bun:test";
import { DEFAULT_OPEN_GENERATIVE_THEME_PRESET } from "../open-generative-theme-preset";
import { openGenerativeThemeFor } from "./open-generative-theme";

describe("Open Generative theme registry", () => {
  test("resolves both modes from the configured shadcn preset", () => {
    const light = openGenerativeThemeFor("light", DEFAULT_OPEN_GENERATIVE_THEME_PRESET);
    const dark = openGenerativeThemeFor("dark", DEFAULT_OPEN_GENERATIVE_THEME_PRESET);

    expect(light.name).toBe("shadcn-lyra-taupe-light");
    expect(light.mode).toBe("light");
    expect(dark.name).toBe("shadcn-lyra-taupe-dark");
    expect(dark.mode).toBe("dark");
    expect(dark.tokens.popover).not.toBe(dark.tokens.popoverForeground);
  });
});
