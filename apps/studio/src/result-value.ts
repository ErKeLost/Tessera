import { containsSensitiveText } from "./public-text";

export type NormalizedResultValue = string | number | boolean | null;

const EMBEDDED_TEXT_KEYS = ["text", "parts", "content", "message", "body"] as const;
const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|authorization|credential)(?:$|[_-])/iu;
const MAX_STRUCTURED_DEPTH = 6;
const MAX_STRUCTURED_ITEMS = 64;

/** Converts driver JSON values into bounded, readable public result cells. */
export function normalizeResultValue(value: unknown, maximumBytes: number): NormalizedResultValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return truncateUtf8(value.toString(), maximumBytes);
  if (value instanceof Date) return sanitizeText(value.toISOString(), maximumBytes);

  if (typeof value === "string") {
    const parsed = parseStructuredString(value);
    if (parsed !== undefined) return normalizeStructuredResult(parsed, maximumBytes);
    return sanitizeText(value, maximumBytes);
  }

  return normalizeStructuredResult(value, maximumBytes);
}

function normalizeStructuredResult(value: object, maximumBytes: number): string {
  const text = extractEmbeddedText(value);
  if (text !== undefined) return sanitizeText(text, maximumBytes);

  let serialized = "[structured value unavailable]";
  try {
    serialized = JSON.stringify(normalizeStructuredValue(value, new WeakSet(), 0)) ?? serialized;
  } catch {
    // Keep the bounded fallback rather than allowing an unserializable driver
    // value to break the complete analysis result.
  }
  return sanitizeText(serialized, maximumBytes);
}

function extractEmbeddedText(
  value: unknown,
  seen = new WeakSet<object>(),
  allowDirectString = true,
  depth = 0,
): string | undefined {
  if (value === null || value === undefined || depth > MAX_STRUCTURED_DEPTH) return undefined;
  if (typeof value === "string") {
    const parsed = parseStructuredString(value);
    if (parsed !== undefined) return extractEmbeddedText(parsed, seen, true, depth + 1);
    return allowDirectString && value.length > 0 ? value : undefined;
  }
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const parts = value
      .slice(0, MAX_STRUCTURED_ITEMS)
      .map((item) => extractEmbeddedText(item, seen, true, depth + 1))
      .filter((item): item is string => item !== undefined && item.length > 0);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of EMBEDDED_TEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const text = extractEmbeddedText(record[key], seen, true, depth + 1);
    if (text !== undefined && text.length > 0) return text;
  }

  // Message payloads are often wrapped in `data`, `payload`, or `metadata`.
  // Search nested objects for the known text keys without treating arbitrary
  // identifiers or labels as message text.
  let inspected = 0;
  for (const [key, nested] of Object.entries(record)) {
    if (inspected >= MAX_STRUCTURED_ITEMS || EMBEDDED_TEXT_KEYS.includes(key as typeof EMBEDDED_TEXT_KEYS[number])) break;
    inspected += 1;
    if (nested === null || typeof nested !== "object") continue;
    const text = extractEmbeddedText(nested, seen, false, depth + 1);
    if (text !== undefined && text.length > 0) return text;
  }
  return undefined;
}

function normalizeStructuredValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite number]";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return "[unsupported value]";
  if (depth >= MAX_STRUCTURED_DEPTH) return "[nested value omitted]";
  if (seen.has(value)) return "[circular value]";
  seen.add(value);

  if (Array.isArray(value)) {
    const normalized = value
      .slice(0, MAX_STRUCTURED_ITEMS)
      .map((item) => normalizeStructuredValue(item, seen, depth + 1));
    if (value.length > MAX_STRUCTURED_ITEMS) normalized.push("[truncated]");
    return normalized;
  }

  const normalized: Record<string, unknown> = {};
  let inspected = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (inspected >= MAX_STRUCTURED_ITEMS) {
      normalized["..."] = "[truncated]";
      break;
    }
    inspected += 1;
    normalized[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[redacted]"
      : normalizeStructuredValue(item, seen, depth + 1);
  }
  return normalized;
}

function parseStructuredString(value: string): object | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeText(value: string, maximumBytes: number): string {
  if (containsSensitiveText(value)) return "[redacted]";
  return truncateUtf8(value, maximumBytes);
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  const suffix = "...";
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && encoder.encode(`${value.slice(0, end)}${suffix}`).byteLength > maximumBytes) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}
