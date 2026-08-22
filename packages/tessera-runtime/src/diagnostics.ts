import type { z } from "zod";
import type { Diagnostic, JsonValue } from "./schemas";

export type DiagnosticInput = Omit<Diagnostic, "recoverable" | "modelCorrectable"> & {
  recoverable?: boolean;
  modelCorrectable?: boolean;
};

export function createDiagnostic(input: DiagnosticInput): Diagnostic {
  return {
    ...input,
    recoverable: input.recoverable ?? input.severity !== "fatal",
    modelCorrectable: input.modelCorrectable ?? false,
  };
}

export function diagnosticsFromZodError(
  error: z.ZodError,
  phase: Diagnostic["phase"] = "validate",
): Diagnostic[] {
  return error.issues.map((issue) => createDiagnostic({
    phase,
    code: "schema.invalid",
    severity: "error",
    recoverable: true,
    modelCorrectable: phase === "normalize" || phase === "validate",
    message: issue.message,
    location: issue.path.length > 0 ? { path: toJsonPointer(issue.path) } : undefined,
  }));
}

export class ArtifactRuntimeError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: Diagnostic | readonly Diagnostic[]) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
    super(list.map((item) => item.message).join("; "));
    this.name = "ArtifactRuntimeError";
    this.diagnostics = list;
  }
}

export function throwDiagnostic(input: DiagnosticInput): never {
  throw new ArtifactRuntimeError(createDiagnostic(input));
}

export function summarizeActual(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") return `string(${new TextEncoder().encode(value).byteLength} bytes)`;
  return typeof value;
}

export function safeExpected(value: JsonValue): JsonValue {
  return value;
}

function toJsonPointer(path: PropertyKey[]): string {
  return `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}
