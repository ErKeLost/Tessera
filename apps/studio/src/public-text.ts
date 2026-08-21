const OPAQUE_IDENTIFIER_PATTERN = /\b(?:ent|fld|met|rel)_[a-z0-9]{16,64}\b/giu;
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const OPAQUE_PREFIXES = ["ent_", "fld_", "met_", "rel_"] as const;

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

export function redactOpaqueAssistantIdentifiers(value: string): string {
  return value.replace(OPAQUE_IDENTIFIER_PATTERN, "[internal identifier]");
}

/**
 * Returns the first suffix that could still become protected text after a
 * later provider delta. Callers hold this suffix back instead of detecting an
 * unsafe pattern only after its earlier portion was already streamed.
 */
export function assistantTextHoldbackStart(value: string): number | undefined {
  for (let index = 0; index < value.length; index += 1) {
    if (!isWordStart(value, index) && !value.startsWith("-", index)) continue;
    const suffix = value.slice(index);
    if (isPossiblePrivateKeyPrefix(suffix)
      || isPossibleSqlPrefix(suffix)
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
    || ["postgresql", "postgres", "mysql", "sqlite", "file", "libsql", "turso", "mongodb", "mongodb+srv"].some((keyword) => isPossibleConnectionPrefix(value, keyword))
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
