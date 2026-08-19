import type { HashProvider } from "./canonical";
import { DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import { validateArtifactDocument, type DocumentValidationOptions } from "./document";
import { JsonSchemaContractError, parseJsonWithSchema, prepareStateSchema } from "./json-schema";
import {
  runtimeSnapshotSchema,
  type Diagnostic,
  type RuntimeSnapshot,
} from "./schemas";

export type RuntimeSnapshotValidationOptions = Omit<DocumentValidationOptions, "hashProvider"> & {
  hashProvider?: HashProvider;
};

export async function validateRuntimeSnapshot(
  input: unknown,
  options: RuntimeSnapshotValidationOptions = {},
): Promise<{ success: true; snapshot: RuntimeSnapshot } | { success: false; diagnostics: Diagnostic[] }> {
  const parsed = runtimeSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, diagnostics: diagnosticsFromZodError(parsed.error, "transport") };
  }
  const snapshot = parsed.data;
  const { document } = snapshot;
  const validation = await validateArtifactDocument(document, options);
  const diagnostics = validation.success ? [] : [...validation.diagnostics];

  if (
    snapshot.branchHead.revisionId !== document.revision.revisionId
    || snapshot.branchHead.branchId !== document.revision.branchId
  ) {
    diagnostics.push(snapshotDiagnostic(
      "snapshot.head-mismatch",
      "Runtime snapshot branch head does not identify its document revision.",
    ));
  }

  const seenStateIds = new Set<string>();
  for (const record of snapshot.state) {
    if (seenStateIds.has(record.stateId)) {
      diagnostics.push(snapshotDiagnostic(
        "snapshot.duplicate-state",
        `Runtime snapshot contains more than one record for state ${record.stateId}.`,
        record.stateId,
      ));
      continue;
    }
    seenStateIds.add(record.stateId);
    const definition = document.state[record.stateId];
    if (!definition) {
      diagnostics.push(snapshotDiagnostic(
        "snapshot.unknown-state",
        `Runtime snapshot references undefined state ${record.stateId}.`,
        record.stateId,
      ));
      continue;
    }
    if (
      record.documentId !== document.documentId
      || record.branchId !== document.revision.branchId
      || record.schemaId !== definition.schemaId
      || record.schemaVersion !== definition.schemaVersion
      || record.schemaHash !== definition.schemaHash
      || record.policyHash !== definition.policy.policyHash
    ) {
      diagnostics.push(snapshotDiagnostic(
        "snapshot.state-identity-mismatch",
        `Runtime state ${record.stateId} does not match its document definition.`,
        record.stateId,
      ));
      continue;
    }
    try {
      const prepared = await prepareStateSchema(definition);
      parseJsonWithSchema(prepared.validator, record.value);
    } catch (error) {
      diagnostics.push(snapshotDiagnostic(
        error instanceof JsonSchemaContractError ? error.code : "snapshot.state-value-invalid",
        error instanceof Error ? error.message : `Runtime state ${record.stateId} failed schema validation.`,
        record.stateId,
      ));
    }
  }

  if (
    snapshot.stateMigrationReceipts.length + snapshot.stateTransitionReceipts.length
    > (options.limits ?? DEFAULT_PROTOCOL_LIMITS).maxSnapshotReceipts
  ) {
    diagnostics.push(snapshotDiagnostic(
      "snapshot.receipt-limit",
      `Runtime snapshot exceeds ${(options.limits ?? DEFAULT_PROTOCOL_LIMITS).maxSnapshotReceipts} state receipts.`,
    ));
  }

  return diagnostics.length > 0
    ? { success: false, diagnostics }
    : { success: true, snapshot };
}

function snapshotDiagnostic(code: string, message: string, stateId?: string): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
    ...(stateId ? { location: { entity: { kind: "state" as const, id: stateId } } } : {}),
  });
}
