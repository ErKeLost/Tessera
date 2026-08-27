const OPAQUE_IDENTIFIER_PATTERN = /\b(?:ent|fld|met|rel)_[a-z0-9]{16,64}\b/giu;
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const OPAQUE_PREFIXES = ["ent_", "fld_", "met_", "rel_"] as const;
const EMBEDDED_TEXT_KEYS = ["text", "parts", "content", "message", "body"] as const;
const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|authorization|credential)(?:$|[_-])/iu;
const MAX_STRUCTURED_DEPTH = 6;
const MAX_STRUCTURED_ITEMS = 64;

export type NormalizedResultValue = string | number | boolean | null;

/** Fail-closed fallback for model-facing tool diagnostics when a host supplies no mapper. */
export function defaultAgentErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "The operation failed.";
  if (containsSensitiveText(message)) return "The operation failed without a safe public diagnostic.";
  return truncateUtf8(message.trim() || "The operation failed.", 2_000);
}

/**
 * Detects credential-shaped content that must never cross an assistant-facing
 * boundary. This intentionally does not try to classify ordinary business
 * data; database rows are sanitized separately at their own boundary.
 */
export function containsSensitiveText(value: string): boolean {
  return /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/iu.test(value)
    || /\b(?:bearer|basic)\s+[a-z0-9._~+\-/]+=*/iu.test(value)
    || /\b(?:password|passwd|secret|token|api[_-]?key|authorization|credential)\s*[:=]/iu.test(value)
    // Connection location alone is private infrastructure context. Do not
    // require a password-shaped segment before withholding a DSN.
    || /\b(?:postgres(?:ql)?|mysql|libsql|turso|sqlite|mongodb(?:\+srv)?):\/\/\S+/iu.test(value)
    || /\bfile:[^\s<>"']+/iu.test(value)
    || /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/u.test(value);
}

/** A model-facing answer must not become a transport for raw database SQL. */
export function containsRawSqlStatement(value: string): boolean {
  return /\b(?:select\s+[\s\S]{1,1000}?\s+from|insert\s+into|update\s+[\w`".]+\s+set|delete\s+from|drop\s+(?:table|database)|alter\s+table)\b/iu.test(value);
}

export function isSafeAssistantTextFragment(value: string): boolean {
  return !containsSensitiveText(value) && !containsRawSqlStatement(value);
}

/** Reasoning may discuss SQL, but it must still never disclose credentials. */
export function isSafeAssistantReasoningFragment(value: string): boolean {
  return !containsSensitiveText(value);
}

export function redactOpaqueAssistantIdentifiers(value: string): string {
  return value.replace(OPAQUE_IDENTIFIER_PATTERN, "[internal identifier]");
}

/**
 * Returns the first suffix that could still become protected text after a
 * later provider delta. Callers hold this suffix back instead of detecting an
 * unsafe pattern only after its earlier portion was already streamed.
 */
export function assistantTextHoldbackStart(value: string): number | undefined {
  return protectedTextHoldbackStart(value, true);
}

/** Retains split credential and internal-id prefixes without suppressing SQL reasoning. */
export function assistantReasoningHoldbackStart(value: string): number | undefined {
  return protectedTextHoldbackStart(value, false);
}

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

function protectedTextHoldbackStart(value: string, includeSql: boolean): number | undefined {
  for (let index = 0; index < value.length; index += 1) {
    if (!isWordStart(value, index) && !value.startsWith("-", index)) continue;
    const suffix = value.slice(index);
    if (isPossiblePrivateKeyPrefix(suffix)
      || (includeSql && isPossibleSqlPrefix(suffix))
      || isPossibleSensitivePrefix(suffix)
      || isPossibleOpaqueIdentifierPrefix(suffix)) {
      return index;
    }
  }
  return undefined;
}

function isPossibleSqlPrefix(value: string): boolean {
  return isPossibleSqlSelect(value)
    || isPossibleSqlTwoWord(value, "insert", ["into"])
    || isPossibleSqlUpdate(value)
    || isPossibleSqlTwoWord(value, "delete", ["from"])
    || isPossibleSqlTwoWord(value, "drop", ["table", "database"])
    || isPossibleSqlTwoWord(value, "alter", ["table"]);
}

function isPossibleSqlSelect(value: string): boolean {
  const state = keywordState(value, "select");
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, "select".length)) return false;
  const rest = value.slice("select".length);
  // The complete SQL matcher permits at most one thousand characters between
  // SELECT and FROM. Until that window closes, retain the candidate.
  return rest.length === 0 || (/^\s/u.test(rest) && rest.length <= 1_024);
}

function isPossibleSqlTwoWord(value: string, first: string, targets: readonly string[]): boolean {
  const state = keywordState(value, first);
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, first.length)) return false;
  const rest = value.slice(first.length);
  if (rest.length === 0 || !/^\s/u.test(rest)) return rest.length === 0;
  const next = rest.trimStart().toLowerCase();
  return next.length === 0 || targets.some((target) => target.startsWith(next));
}

function isPossibleSqlUpdate(value: string): boolean {
  const state = keywordState(value, "update");
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, "update".length)) return false;
  const rest = value.slice("update".length);
  if (rest.length === 0 || !/^\s/u.test(rest)) return rest.length === 0;
  const afterWhitespace = rest.trimStart();
  if (afterWhitespace.length === 0) return true;
  const identifier = /^[\w`".]+/u.exec(afterWhitespace)?.[0];
  if (!identifier) return false;
  const afterIdentifier = afterWhitespace.slice(identifier.length);
  if (afterIdentifier.length === 0) return true;
  if (!/^\s/u.test(afterIdentifier)) return false;
  const next = afterIdentifier.trimStart().toLowerCase();
  return next.length === 0 || "set".startsWith(next);
}

function isPossibleSensitivePrefix(value: string): boolean {
  return isPossibleBearerPrefix(value, "bearer")
    || isPossibleBearerPrefix(value, "basic")
    || ["password", "passwd", "secret", "token", "api_key", "api-key", "authorization", "credential"]
      .some((keyword) => isPossibleAssignmentPrefix(value, keyword))
    || ["postgresql", "postgres", "mysql", "sqlite", "file", "libsql", "turso", "mongodb", "mongodb+srv"]
      .some((keyword) => isPossibleConnectionPrefix(value, keyword))
    || isPossibleJwtPrefix(value);
}

function isPossibleBearerPrefix(value: string, keyword: string): boolean {
  const state = keywordState(value, keyword);
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, keyword.length)) return false;
  const rest = value.slice(keyword.length);
  return rest.length === 0 || /^\s+$/u.test(rest);
}

function isPossibleAssignmentPrefix(value: string, keyword: string): boolean {
  const state = keywordState(value, keyword);
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, keyword.length)) return false;
  const rest = value.slice(keyword.length);
  return rest.length === 0 || /^\s+$/u.test(rest);
}

function isPossibleConnectionPrefix(value: string, keyword: string): boolean {
  const state = keywordState(value, keyword);
  if (state === "partial") return true;
  if (state !== "full" || followsWord(value, keyword.length)) return false;
  const rest = value.slice(keyword.length);
  return rest.length === 0 || "://".startsWith(rest) || rest.startsWith("://");
}

function isPossibleJwtPrefix(value: string): boolean {
  const state = keywordState(value, "eyj");
  if (state === "partial") return true;
  if (state !== "full") return false;
  const rest = value.slice(3);
  return /^[A-Za-z0-9_-]*$/u.test(rest);
}

function isPossibleOpaqueIdentifierPrefix(value: string): boolean {
  for (const prefix of OPAQUE_PREFIXES) {
    const state = keywordState(value, prefix);
    if (state === "partial") return true;
    if (state !== "full") continue;
    const rest = value.slice(prefix.length);
    const identifier = /^[a-z0-9]*/iu.exec(rest)?.[0] ?? "";
    if (identifier.length > 64) return false;
    if (identifier.length < 16) return rest.length === identifier.length;
    return rest.length === identifier.length;
  }
  return false;
}

function isPossiblePrivateKeyPrefix(value: string): boolean {
  const prefix = "-----begin";
  const normalized = value.toLowerCase();
  return prefix.startsWith(normalized) || normalized.startsWith(prefix);
}

function keywordState(value: string, keyword: string): "none" | "partial" | "full" {
  const normalized = value.toLowerCase();
  const head = normalized.slice(0, keyword.length);
  if (head === keyword) return "full";
  return keyword.startsWith(normalized) ? "partial" : "none";
}

function followsWord(value: string, length: number): boolean {
  const next = value[length];
  return next !== undefined && WORD_CHARACTER_PATTERN.test(next);
}

function isWordStart(value: string, index: number): boolean {
  const previous = value[index - 1];
  return previous === undefined || !WORD_CHARACTER_PATTERN.test(previous);
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
