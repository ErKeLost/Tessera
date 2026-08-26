import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPEN_GENERATIVE_THEME_PRESET,
  TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE,
  isOpenGenerativeThemePresetId,
  resolveOpenGenerativeThemePreset,
  resolveOpenGenerativeThemePresetFromEnvironment,
} from "./open-generative-theme-preset";

describe("Open Generative theme preset configuration", () => {
  test("uses the compiled shadcn preset by default", () => {
    expect(resolveOpenGenerativeThemePreset(undefined)).toBe(
      DEFAULT_OPEN_GENERATIVE_THEME_PRESET,
    );
  });

  test("normalizes the allowlisted environment preset", () => {
    expect(resolveOpenGenerativeThemePresetFromEnvironment({
      [TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE]:
        `  ${DEFAULT_OPEN_GENERATIVE_THEME_PRESET}  `,
    })).toBe(DEFAULT_OPEN_GENERATIVE_THEME_PRESET);
    expect(isOpenGenerativeThemePresetId(DEFAULT_OPEN_GENERATIVE_THEME_PRESET)).toBe(true);
  });

  test("rejects unsupported values without reflecting them", () => {
    const suppliedValue = "private-theme-payload";
    let message = "";
    try {
      resolveOpenGenerativeThemePreset(suppliedValue);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      `${TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE} must contain a supported preset ID.`,
    );
    expect(message).not.toContain(suppliedValue);
  });
});
