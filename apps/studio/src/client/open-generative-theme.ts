import {
  createOpenGenerativeTheme,
  type OpenGenerativeTheme,
  type OpenGenerativeThemeMode,
} from "@open-generative/ui";
import {
  DEFAULT_OPEN_GENERATIVE_THEME_PRESET,
  type OpenGenerativeThemePresetId,
} from "../open-generative-theme-preset";

const chart = [
  "oklch(0.868 0.007 39.5)",
  "oklch(0.547 0.021 43.1)",
  "oklch(0.438 0.017 39.3)",
  "oklch(0.367 0.016 35.7)",
  "oklch(0.268 0.011 36.5)",
] as const;

const design = {
  style: "lyra",
  density: 0.6432,
  radiusScale: 0.86,
  borderWidth: "1px",
  chartStrokeWidth: 1.5,
  surfaceShadow: "none",
} as const;

const lyraTaupeThemes = {
  light: createOpenGenerativeTheme({
    name: "shadcn-lyra-taupe-light",
    mode: "light",
    tokens: {
      background: "oklch(1 0 0)",
      foreground: "oklch(0.147 0.004 49.3)",
      card: "oklch(1 0 0)",
      cardForeground: "oklch(0.147 0.004 49.3)",
      popover: "oklch(1 0 0)",
      popoverForeground: "oklch(0.147 0.004 49.3)",
      primary: "oklch(0.214 0.009 43.1)",
      primaryForeground: "oklch(0.986 0.002 67.8)",
      secondary: "oklch(0.96 0.002 17.2)",
      secondaryForeground: "oklch(0.214 0.009 43.1)",
      muted: "oklch(0.96 0.002 17.2)",
      mutedForeground: "oklch(0.547 0.021 43.1)",
      accent: "oklch(0.96 0.002 17.2)",
      accentForeground: "oklch(0.214 0.009 43.1)",
      destructive: "oklch(0.577 0.245 27.325)",
      border: "oklch(0.922 0.005 34.3)",
      input: "oklch(0.922 0.005 34.3)",
      ring: "oklch(0.714 0.014 41.2)",
      radius: "0.625rem",
      chart,
    },
    design,
  }),
  dark: createOpenGenerativeTheme({
    name: "shadcn-lyra-taupe-dark",
    mode: "dark",
    tokens: {
      background: "oklch(0.147 0.004 49.3)",
      foreground: "oklch(0.986 0.002 67.8)",
      card: "oklch(0.214 0.009 43.1)",
      cardForeground: "oklch(0.986 0.002 67.8)",
      popover: "oklch(0.214 0.009 43.1)",
      popoverForeground: "oklch(0.986 0.002 67.8)",
      primary: "oklch(0.922 0.005 34.3)",
      primaryForeground: "oklch(0.214 0.009 43.1)",
      secondary: "oklch(0.268 0.011 36.5)",
      secondaryForeground: "oklch(0.986 0.002 67.8)",
      muted: "oklch(0.268 0.011 36.5)",
      mutedForeground: "oklch(0.714 0.014 41.2)",
      accent: "oklch(0.268 0.011 36.5)",
      accentForeground: "oklch(0.986 0.002 67.8)",
      destructive: "oklch(0.704 0.191 22.216)",
      border: "oklch(1 0 0 / 10%)",
      input: "oklch(1 0 0 / 15%)",
      ring: "oklch(0.547 0.021 43.1)",
      radius: "0.625rem",
      chart,
    },
    design,
  }),
} satisfies Record<OpenGenerativeThemeMode, OpenGenerativeTheme>;

const themePresets = {
  [DEFAULT_OPEN_GENERATIVE_THEME_PRESET]: lyraTaupeThemes,
} satisfies Record<
  OpenGenerativeThemePresetId,
  Record<OpenGenerativeThemeMode, OpenGenerativeTheme>
>;

export function openGenerativeThemeFor(
  mode: OpenGenerativeThemeMode,
  preset: OpenGenerativeThemePresetId = DEFAULT_OPEN_GENERATIVE_THEME_PRESET,
): OpenGenerativeTheme {
  return themePresets[preset][mode];
}
