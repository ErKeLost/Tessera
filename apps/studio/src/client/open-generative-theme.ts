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
  card: "var(--ds-color-surface-raised)",
  cardForeground: "var(--ds-color-ink)",
  popover: "var(--ds-color-surface-overlay)",
  popoverForeground: "var(--ds-color-ink)",
  primary: "var(--ds-color-ink)",
  primaryForeground: "var(--ds-color-on-primary)",
  secondary: "var(--ds-color-surface-secondary)",
  secondaryForeground: "var(--ds-color-ink)",
  muted: "var(--ds-color-surface-muted)",
  mutedForeground: "var(--ds-color-body)",
  accent: "var(--ds-color-surface-hover)",
  accentForeground: "var(--ds-color-ink)",
  destructive: "var(--ds-color-error)",
  border: "var(--ds-color-border)",
  input: "var(--ds-color-border-strong)",
  ring: "var(--ds-color-focus)",
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

const shadcnDesign = {
  style: shadcnPreset.style,
  density: 0.6432,
  radiusScale: 0.86,
  borderWidth: "var(--ds-border-width-hairline)",
  chartStrokeWidth: 1.5,
  surfaceShadow: "var(--ds-shadow-whisper)",
} as const;

function createHostShadcnTheme(mode: OpenGenerativeThemeMode): OpenGenerativeTheme {
  return createOpenGenerativeTheme({
    name: `shadcn-${shadcnPreset.style}-${shadcnPreset.theme}-${mode}`,
    mode,
    tokens: hostThemeTokens,
    design: shadcnDesign,
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
