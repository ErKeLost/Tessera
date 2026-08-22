import type { ProtocolLimits } from "./schemas";
import { DEFAULT_PROTOCOL_LIMITS, FORBIDDEN_OBJECT_KEYS } from "./constants";
import { canonicalize } from "./canonical";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import {
  artifactValueSchema,
  jsonValueSchema,
  type ArtifactValue,
  type Diagnostic,
  type JsonValue,
  type PathSegment,
} from "./schemas";

export type ValueResolution =
  | { ok: true; value: JsonValue }
  | { ok: false; diagnostic: Diagnostic };

export type ValueResolutionContext = {
  state?: Readonly<Record<string, JsonValue>>;
  resources?: Readonly<Record<string, JsonValue>>;
  event?: { port: string; payload: JsonValue };
  context?: { locale: string; timezone: string };
};

export function lowerJsonValue(input: unknown): ArtifactValue {
  const parsed = jsonValueSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(diagnosticsFromZodError(parsed.error, "normalize").map((item) => item.message).join("; "));
  }
  return lowerParsedValue(parsed.data);
}

export function literalArtifactValue(value: JsonValue): ArtifactValue {
  return lowerParsedValue(value);
}

export function resolveArtifactValue(
  input: ArtifactValue,
  resolution: ValueResolutionContext,
): ValueResolution {
  const parsed = artifactValueSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostic: diagnosticsFromZodError(parsed.error)[0] ?? unresolved("value.invalid", "Invalid artifact value."),
    };
  }
  return resolveParsedValue(parsed.data, resolution);
}

export function evaluatePresentationCondition(
  input: ArtifactValue,
  resolution: ValueResolutionContext,
): { value: boolean; diagnostic?: Diagnostic } {
  const result = resolveArtifactValue(input, resolution);
  if (!result.ok) return { value: false, diagnostic: result.diagnostic };
  if (typeof result.value !== "boolean") {
    return {
      value: false,
      diagnostic: unresolved("condition.non-boolean-result", "Presentation condition did not resolve to a boolean."),
    };
  }
  return { value: result.value };
}

export function validateValueLimits(
  input: unknown,
  limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const encoder = new TextEncoder();
  let totalValues = 0;

  const visit = (value: unknown, depth: number, path: string): void => {
    totalValues += 1;
    if (totalValues > limits.maxTotalValues) return;
    if (depth > limits.maxDepth) {
      diagnostics.push(limitDiagnostic("value.max-depth", `Value exceeds depth ${limits.maxDepth}.`, path));
      return;
    }
    if (typeof value === "string" && encoder.encode(value).byteLength > limits.maxStringBytes) {
      diagnostics.push(limitDiagnostic("value.max-string-bytes", `String exceeds ${limits.maxStringBytes} bytes.`, path));
      return;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      diagnostics.push(limitDiagnostic("value.non-finite-number", "Number must be finite.", path));
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxCollectionItems) {
        diagnostics.push(limitDiagnostic("value.max-collection-items", `Array exceeds ${limits.maxCollectionItems} items.`, path));
      }
      value.forEach((item, index) => visit(item, depth + 1, `${path}/${index}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length > limits.maxObjectKeys) {
        diagnostics.push(limitDiagnostic("value.max-object-keys", `Object exceeds ${limits.maxObjectKeys} keys.`, path));
      }
      for (const [key, child] of entries) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          diagnostics.push(limitDiagnostic("value.forbidden-key", `Forbidden object key: ${key}.`, `${path}/${escapePointer(key)}`));
        }
        if (encoder.encode(key).byteLength > limits.maxStringBytes) {
          diagnostics.push(limitDiagnostic("value.max-key-bytes", `Object key exceeds ${limits.maxStringBytes} bytes.`, path));
        }
        visit(child, depth + 1, `${path}/${escapePointer(key)}`);
      }
    }
  };

  visit(input, 0, "");
  if (totalValues > limits.maxTotalValues) {
    diagnostics.push(limitDiagnostic("value.max-total-values", `Value exceeds ${limits.maxTotalValues} total values.`, ""));
  }
  return diagnostics;
}

function lowerParsedValue(value: JsonValue): ArtifactValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map(lowerParsedValue) };
  }
  const entries: Record<string, ArtifactValue> = {};
  for (const [key, item] of Object.entries(value)) entries[key] = lowerParsedValue(item);
  return { kind: "object", entries };
}

function resolveParsedValue(value: ArtifactValue, resolution: ValueResolutionContext): ValueResolution {
  switch (value.kind) {
    case "literal":
      return { ok: true, value: value.value };
    case "array": {
      const output: JsonValue[] = [];
      for (const item of value.items) {
        const result = resolveParsedValue(item, resolution);
        if (!result.ok) return result;
        output.push(result.value);
      }
      return { ok: true, value: output };
    }
    case "object": {
      const output: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value.entries)) {
        const result = resolveParsedValue(item, resolution);
        if (!result.ok) return result;
        output[key] = result.value;
      }
      return { ok: true, value: output };
    }
    case "state-ref":
      return resolveReference("state", value.stateId, value.path, resolution.state);
    case "resource-ref":
      return resolveReference("resource", value.resourceId, value.path, resolution.resources);
    case "event-ref": {
      if (!resolution.event || resolution.event.port !== value.port) {
        return { ok: false, diagnostic: unresolved("value.unresolved-event", `Event port ${value.port} is unavailable.`) };
      }
      return resolvePath(resolution.event.payload, value.path, `event:${value.port}`);
    }
    case "context-ref": {
      const contextValue = resolution.context?.[value.key];
      if (contextValue === undefined) {
        return { ok: false, diagnostic: unresolved("value.unresolved-context", `Context ${value.key} is unavailable.`) };
      }
      return { ok: true, value: contextValue };
    }
    case "condition":
      return evaluateCondition(value.op, value.args, resolution);
  }
}

function resolveReference(
  kind: "state" | "resource",
  id: string,
  path: PathSegment[] | undefined,
  source: Readonly<Record<string, JsonValue>> | undefined,
): ValueResolution {
  if (!source || !Object.prototype.hasOwnProperty.call(source, id)) {
    return { ok: false, diagnostic: unresolved(`value.unresolved-${kind}`, `${kind} ${id} is unavailable.`) };
  }
  return resolvePath(source[id]!, path, `${kind}:${id}`);
}

function resolvePath(root: JsonValue, path: PathSegment[] | undefined, label: string): ValueResolution {
  let current: JsonValue = root;
  for (const segment of path ?? []) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return { ok: false, diagnostic: unresolved("value.invalid-path", `Path on ${label} is unavailable.`) };
      }
      current = current[segment]!;
    } else {
      if (
        current === null
        || Array.isArray(current)
        || typeof current !== "object"
        || !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return { ok: false, diagnostic: unresolved("value.invalid-path", `Path on ${label} is unavailable.`) };
      }
      current = current[segment]!;
    }
  }
  return { ok: true, value: current };
}

function evaluateCondition(
  operator: Extract<ArtifactValue, { kind: "condition" }>["op"],
  args: ArtifactValue[],
  resolution: ValueResolutionContext,
): ValueResolution {
  const values: JsonValue[] = [];
  for (const arg of args) {
    const result = resolveParsedValue(arg, resolution);
    if (!result.ok) return result;
    values.push(result.value);
  }

  if (operator === "eq" || operator === "neq") {
    if (values.length !== 2) return conditionArity(operator, "exactly two");
    const equal = canonicalize(values[0]) === canonicalize(values[1]);
    return { ok: true, value: operator === "eq" ? equal : !equal };
  }
  if (operator === "not") {
    if (values.length !== 1 || typeof values[0] !== "boolean") return conditionType(operator, "one boolean");
    return { ok: true, value: !values[0] };
  }
  if (operator === "and" || operator === "or") {
    if (values.length < 2 || values.some((value) => typeof value !== "boolean")) {
      return conditionType(operator, "at least two booleans");
    }
    return { ok: true, value: operator === "and" ? values.every(Boolean) : values.some(Boolean) };
  }
  if (values.length !== 2 || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    return conditionType(operator, "exactly two finite numbers");
  }
  const left = values[0] as number;
  const right = values[1] as number;
  if (operator === "lt") return { ok: true, value: left < right };
  if (operator === "lte") return { ok: true, value: left <= right };
  if (operator === "gt") return { ok: true, value: left > right };
  return { ok: true, value: left >= right };
}

function conditionArity(operator: string, expected: string): ValueResolution {
  return { ok: false, diagnostic: unresolved("condition.invalid-arity", `${operator} requires ${expected} values.`) };
}

function conditionType(operator: string, expected: string): ValueResolution {
  return { ok: false, diagnostic: unresolved("condition.invalid-operands", `${operator} requires ${expected}.`) };
}

function unresolved(code: string, message: string): Diagnostic {
  return createDiagnostic({
    phase: "validate",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
  });
}

function limitDiagnostic(code: string, message: string, path: string): Diagnostic {
  return createDiagnostic({
    phase: "validate",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: true,
    message,
    location: path ? { path } : undefined,
  });
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
