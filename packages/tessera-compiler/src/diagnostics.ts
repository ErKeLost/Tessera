import type { Diagnostic, DiagnosticPhase, JsonValue } from "./types";

export class CompilerDiagnosticError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n"));
    this.name = "CompilerDiagnosticError";
    this.diagnostics = diagnostics;
  }
}

export function compilerDiagnostic(input: {
  phase: DiagnosticPhase;
  code: string;
  message: string;
  path?: string;
  severity?: Diagnostic["severity"];
  recoverable?: boolean;
  modelCorrectable?: boolean;
  expected?: JsonValue;
  actualSummary?: string;
  hint?: string;
}): Diagnostic {
  return {
    phase: input.phase,
    code: input.code,
    severity: input.severity ?? "error",
    recoverable: input.recoverable ?? true,
    modelCorrectable: input.modelCorrectable ?? true,
    message: input.message,
    ...(input.path ? { location: { path: input.path } } : {}),
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    ...(input.actualSummary ? { actualSummary: input.actualSummary } : {}),
    ...(input.hint ? { hint: input.hint } : {}),
  };
}

export function throwDiagnostic(input: Parameters<typeof compilerDiagnostic>[0]): never {
  throw new CompilerDiagnosticError([compilerDiagnostic(input)]);
}

export function diagnosticsFromUnknown(error: unknown): readonly Diagnostic[] {
  if (error instanceof CompilerDiagnosticError) return error.diagnostics;
  return [compilerDiagnostic({
    phase: "validate",
    code: "compiler.validation_failed",
    message: "The artifact did not satisfy the active contract.",
    severity: "error",
    recoverable: false,
    modelCorrectable: false,
    actualSummary: error instanceof Error ? error.name : typeof error,
  })];
}
