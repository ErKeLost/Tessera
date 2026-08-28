import {
  createOpenGenerativeTheme,
  type OpenGenerativeTheme,
  type OpenGenerativeThemeMode,
} from "@open-generative/ui";
import {
  DEFAULT_OPEN_GENERATIVE_THEME_PRESET,
  OPEN_GENERATIVE_SHADCN_PRESETS,
  type OpenGenerativeThemePresetId,
} from "../open-generative-theme-preset";

const hostThemeTokens = {
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

const shadcnPreset = OPEN_GENERATIVE_SHADCN_PRESETS[DEFAULT_OPEN_GENERATIVE_THEME_PRESET];

function createHostShadcnTheme(mode: OpenGenerativeThemeMode): OpenGenerativeTheme {
  return createOpenGenerativeTheme({
    name: `shadcn-${shadcnPreset.style}-${shadcnPreset.theme}-${mode}`,
    mode,
    tokens: hostThemeTokens,
  });
}

const shadcnThemes = {
  light: createHostShadcnTheme("light"),
  dark: createHostShadcnTheme("dark"),
} satisfies Record<OpenGenerativeThemeMode, OpenGenerativeTheme>;

const themePresets = {
  [DEFAULT_OPEN_GENERATIVE_THEME_PRESET]: shadcnThemes,
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
