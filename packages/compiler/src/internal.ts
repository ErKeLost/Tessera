import {
  canonicalStringify,
  createDiagnostic,
  type Diagnostic,
  type DiagnosticPhase,
  type JsonValue,
} from "@open-generative/protocol";

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

export function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

export function refKey(ref: {
  publisher: string;
  catalogId: string;
  revision: number;
  contractHash: string;
  componentType?: string;
  actionType?: string;
}): string {
  const type = ref.componentType ?? ref.actionType;
  return `${ref.publisher}/${ref.catalogId}/${String(type)}@${ref.revision}#${ref.contractHash}`;
}

export function offerKey(ref: { bindingId?: string; evidenceId?: string; offerHash: string }): string {
  return `${ref.bindingId ?? ref.evidenceId}#${ref.offerHash}`;
}

export function jsonPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "";
  return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

export function diagnostic(input: {
  phase: DiagnosticPhase;
  code: string;
  message: string;
  path?: string;
  severity?: Diagnostic["severity"];
  recoverable?: boolean;
  modelCorrectable?: boolean;
  expected?: JsonValue;
  hint?: string;
}): Diagnostic {
  return createDiagnostic({
    phase: input.phase,
    code: input.code,
    severity: input.severity ?? "error",
    recoverable: input.recoverable ?? true,
    modelCorrectable: input.modelCorrectable ?? true,
    message: input.message,
    ...(input.path === undefined ? {} : { location: { path: input.path as never } }),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  });
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function compareCanonical(left: unknown, right: unknown): number {
  return canonicalStringify(left).localeCompare(canonicalStringify(right));
}

export function exhaustive(value: never): never {
  throw new TypeError(`Unexpected discriminant: ${String(value)}`);
}
