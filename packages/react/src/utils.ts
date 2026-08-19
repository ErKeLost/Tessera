export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function formatNumber(
  value: number,
  options: { format?: "number" | "compact" | "currency" | "percent"; currency?: string; locale?: string } = {},
) {
  const { format = "number", currency = "USD", locale = "en-US" } = options;
  return new Intl.NumberFormat(locale, {
    style: format === "currency" ? "currency" : format === "percent" ? "percent" : "decimal",
    currency,
    notation: format === "compact" ? "compact" : "standard",
    maximumFractionDigits: format === "percent" ? 1 : 2,
  }).format(format === "percent" ? value / 100 : value);
}

export function formatDataValue(value: unknown, locale = "en-US") {
  if (typeof value === "number") return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }
  return value == null ? "—" : String(value);
}
