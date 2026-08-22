import { canonicalize, hashJson, utf8Bytes } from "./canonical";
import {
  compilerDiagnostic,
  CompilerDiagnosticError,
  diagnosticsFromUnknown,
} from "./diagnostics";
import type {
  Diagnostic,
  InformationFlowLabel,
  JsonValue,
  PromptBundle,
  RepairDiagnostic,
  RepairProvider,
  RepairRequest,
} from "./types";

const repairablePhases = new Set<Diagnostic["phase"]>(["decode", "normalize", "validate"]);

const safeRepairMessages: Readonly<Record<string, string>> = Object.freeze({
  "authoring.expected_object": "Replace this value with the required object shape.",
  "authoring.expected_string": "Provide the required non-empty string.",
  "authoring.unknown_field": "Remove the undeclared field.",
  "authoring.reserved_key": "Remove the unknown reserved key.",
  "catalog.node_not_in_slice": "Choose a node type from the active provider schema.",
  "catalog.node_version_mismatch": "Use the active node contract version.",
  "node.invalid_props": "Make the node props satisfy its generated closed schema.",
  "node.duplicate_id": "Give every node a unique stable id.",
  "slot.unknown": "Use only slots declared by the node contract.",
  "slot.expected_array": "Represent slot children as an array.",
  "slot.cardinality": "Adjust the number of children to the declared slot bounds.",
  "slot.child_not_allowed": "Use a child type accepted by this slot.",
  "condition.invalid_shape": "Use a supported condition operator and argument list.",
  "condition.invalid_arity": "Use the required number of condition arguments.",
  "action.duplicate_step_id": "Give every step in the action plan a unique id.",
});

export function sanitizeRepairDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly RepairDiagnostic[] {
  return diagnostics.filter((diagnostic) => (
    diagnostic.modelCorrectable
    && diagnostic.recoverable
    && repairablePhases.has(diagnostic.phase)
  )).map((diagnostic) => ({
    phase: diagnostic.phase,
    code: diagnostic.code.replaceAll(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120),
    severity: diagnostic.severity,
    message: safeRepairMessages[diagnostic.code] ?? "Correct this field using the active provider schema.",
    ...(diagnostic.location?.path ? { path: diagnostic.location.path.slice(0, 500) } : {}),
    ...(safeRepairMessages[diagnostic.code]
      ? { hint: safeRepairMessages[diagnostic.code] }
      : {}),
  }));
}

function repairFragment(value: unknown, maxBytes: number): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("not JSON");
    const parsed = redactRepairValue(JSON.parse(serialized) as JsonValue);
    const canonical = canonicalize(parsed);
    if (utf8Bytes(canonical) <= maxBytes) return parsed;
    return {
      omitted: true,
      reason: "fragment-too-large",
      contentHash: hashJson(parsed),
      byteLength: utf8Bytes(canonical),
    };
  } catch {
    return { omitted: true, reason: "fragment-not-json" };
  }
}

const secretKeyPattern = /(?:api[-_]?key|authorization|credential|password|secret|token|rawexception|hiddenpolicy|sql)/i;
const secretValuePattern = /(?:bearer\s+[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{12,}|\b(?:select|insert|update|delete|drop|alter)\s+.+\b(?:from|into|table|set)\b)/i;

function redactRepairValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return secretValuePattern.test(value) ? "[REDACTED]" : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactRepairValue);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    secretKeyPattern.test(key) ? "[REDACTED]" : redactRepairValue(child),
  ]));
}

function createRepairRequest(input: {
  attempt: number;
  bundle: PromptBundle;
  diagnostics: readonly RepairDiagnostic[];
  invalidValue: unknown;
  parentRevisionId?: string;
  headPreconditions?: Readonly<Record<string, string>>;
  statePreconditions?: Readonly<Record<string, string>>;
}): RepairRequest {
  const fragment = repairFragment(input.invalidValue, input.bundle.limits.maxRepairFragmentBytes);
  const requestWithoutPrompt = {
    attempt: input.attempt,
    maxAttempts: input.bundle.repair.maxAttempts,
    contractFingerprint: input.bundle.contractFingerprint,
    promptBundleHash: input.bundle.promptBundleHash,
    ...(input.parentRevisionId ? { parentRevisionId: input.parentRevisionId } : {}),
    ...(input.headPreconditions ? { headPreconditions: input.headPreconditions } : {}),
    ...(input.statePreconditions ? { statePreconditions: input.statePreconditions } : {}),
    allowedOperations: ["replace-snapshot"] as const,
    diagnostics: input.diagnostics,
    fragment,
  };
  const prompt = [
    "Repair the Artifact Authoring snapshot using only the active provider schema.",
    "Return one complete replacement snapshot. Do not add prose, patches, credentials, SQL, policy details, or executable content.",
    "Active authoring instructions:\n" + input.bundle.system,
    "Active provider JSON Schema:\n" + canonicalize(input.bundle.providerSchema),
    canonicalize(requestWithoutPrompt as unknown as JsonValue),
  ].join("\n\n");
  return {
    ...requestWithoutPrompt,
    system: input.bundle.system,
    providerSchema: input.bundle.providerSchema,
    prompt,
  };
}

export type BoundedRepairOptions<T> = {
  initialValue: unknown;
  bundle: PromptBundle;
  informationFlow: InformationFlowLabel;
  validate(value: unknown): T;
  provider?: RepairProvider;
  parentRevisionId?: string;
  headPreconditions?: Readonly<Record<string, string>>;
  statePreconditions?: Readonly<Record<string, string>>;
};

export async function runBoundedRepair<T>(
  options: BoundedRepairOptions<T>,
): Promise<T> {
  let value = options.initialValue;
  let lastDiagnostics: readonly Diagnostic[] = [];
  for (let attempt = 0; attempt <= options.bundle.repair.maxAttempts; attempt += 1) {
    try {
      return options.validate(value);
    } catch (error) {
      lastDiagnostics = diagnosticsFromUnknown(error);
    }

    const diagnostics = sanitizeRepairDiagnostics(lastDiagnostics);
    const canRepair = attempt < options.bundle.repair.maxAttempts
      && options.provider !== undefined
      && options.informationFlow.allowedSinks.includes("model-repair")
      && diagnostics.length > 0;
    if (!canRepair) throw new CompilerDiagnosticError(lastDiagnostics);

    const request = createRepairRequest({
      attempt: attempt + 1,
      bundle: options.bundle,
      diagnostics,
      invalidValue: value,
      parentRevisionId: options.parentRevisionId,
      headPreconditions: options.headPreconditions,
      statePreconditions: options.statePreconditions,
    });
    try {
      value = await options.provider!.repair(request);
    } catch {
      throw new CompilerDiagnosticError([compilerDiagnostic({
        phase: "transport",
        code: "repair.provider_failed",
        message: "The repair provider failed before returning a replacement snapshot.",
        recoverable: true,
        modelCorrectable: false,
      })]);
    }
  }
  throw new CompilerDiagnosticError(lastDiagnostics);
}
