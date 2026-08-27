export const TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE =
  "TESSERA_OPEN_GENERATIVE_THEME";

export const OPEN_GENERATIVE_THEME_PRESET_IDS = ["b7VWPDLHc"] as const;

export type OpenGenerativeThemePresetId =
  (typeof OPEN_GENERATIVE_THEME_PRESET_IDS)[number];

export type OpenGenerativeShadcnPreset = Readonly<{
  style: "lyra";
  theme: "taupe";
  baseColor: "taupe";
  chartColor: "taupe";
  radius: "default";
  font: "inter";
  fontHeading: "inherit";
  iconLibrary: "lucide";
  menuColor: "default";
  menuAccent: "subtle";
}>;

/** Official shadcn preset metadata decoded from ui.shadcn.com. */
export const OPEN_GENERATIVE_SHADCN_PRESETS = {
  b7VWPDLHc: {
    style: "lyra",
    theme: "taupe",
    baseColor: "taupe",
    chartColor: "taupe",
    radius: "default",
    font: "inter",
    fontHeading: "inherit",
    iconLibrary: "lucide",
    menuColor: "default",
    menuAccent: "subtle",
  },
} as const satisfies Record<OpenGenerativeThemePresetId, OpenGenerativeShadcnPreset>;

export const DEFAULT_OPEN_GENERATIVE_THEME_PRESET: OpenGenerativeThemePresetId =
  "b7VWPDLHc";

const openGenerativeThemePresetIds: ReadonlySet<string> = new Set(
  OPEN_GENERATIVE_THEME_PRESET_IDS,
);

export function isOpenGenerativeThemePresetId(
  value: unknown,
): value is OpenGenerativeThemePresetId {
  return typeof value === "string" && openGenerativeThemePresetIds.has(value);
}

/** Resolves only locally compiled presets; arbitrary CSS and theme JSON are rejected. */
export function resolveOpenGenerativeThemePreset(
  value: unknown,
): OpenGenerativeThemePresetId {
  if (value === undefined) return DEFAULT_OPEN_GENERATIVE_THEME_PRESET;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (isOpenGenerativeThemePresetId(normalized)) return normalized;
  throw new TypeError(
    `${TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE} must contain a supported preset ID.`,
  );
}

export function resolveOpenGenerativeThemePresetFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): OpenGenerativeThemePresetId {
  return resolveOpenGenerativeThemePreset(
    environment[TESSERA_OPEN_GENERATIVE_THEME_ENVIRONMENT_VARIABLE],
  );
}
