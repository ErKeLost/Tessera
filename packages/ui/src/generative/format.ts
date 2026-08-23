import type {
  DataChartCellValue,
  FormatToken,
} from "@open-generative/components";

export function formatValue(
  value: DataChartCellValue | undefined,
  format?: FormatToken,
  locale = "en-US",
): string {
  if (value === null || value === undefined) return "-";
  if (format === undefined) {
    if (typeof value === "number") {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
    }
    return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  }

  if (format.kind === "number") {
    if (typeof value !== "number") return String(value);
    const formatted = new Intl.NumberFormat(locale, {
      notation: format.notation,
      ...(format.minimumFractionDigits === undefined ? {} : { minimumFractionDigits: format.minimumFractionDigits }),
      ...(format.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: format.maximumFractionDigits }),
    }).format(value);
    return format.unit === undefined ? formatted : `${formatted} ${format.unit}`;
  }
  if (format.kind === "currency") {
    if (typeof value !== "number") return String(value);
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: format.currency,
      currencyDisplay: format.display === "narrow-symbol" ? "narrowSymbol" : format.display,
      ...(format.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: format.maximumFractionDigits }),
    }).format(value);
  }
  if (format.kind === "percent") {
    if (typeof value !== "number") return String(value);
    return new Intl.NumberFormat(locale, {
      style: "percent",
      ...(format.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: format.maximumFractionDigits }),
    }).format(value);
  }

  const date = new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  if (format.kind === "date") {
    return new Intl.DateTimeFormat(locale, { dateStyle: format.dateStyle }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: format.dateStyle,
    timeStyle: format.timeStyle,
  }).format(date);
}

export function asFiniteNumber(value: DataChartCellValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
