import type { CSSProperties } from "react";

/**
 * Stable renderer tokens. Applications can provide these inline or through a
 * CSS class; generated chart documents never control them.
 */
export const dataChartThemeTokens = [
  "background",
  "foreground",
  "card",
  "border",
  "muted-foreground",
  "chart-grid",
  "chart-hover",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "radius-base",
] as const;

export type DataChartThemeToken = (typeof dataChartThemeTokens)[number];
export type DataChartTheme = Readonly<Partial<Record<DataChartThemeToken, string>>>;

export function dataChartThemeStyle(theme: DataChartTheme): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme).map(([token, value]) => [`--og-${token}`, value]),
  ) as CSSProperties;
}
