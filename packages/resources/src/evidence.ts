import {
  claimBindingSchema,
  createDiagnostic,
  evidenceReferenceSchema,
  resourceReferenceSchema,
  type Diagnostic,
} from "@data-elements/runtime";
import type { EvidenceValidationInput, EvidenceValidationResult, Sensitivity } from "./types";

export function validateEvidenceAndClaims(input: EvidenceValidationInput): EvidenceValidationResult {
  const diagnostics: Diagnostic[] = [];
  const now = Date.parse(input.now ?? new Date().toISOString());
  const granted = input.grantedEvidenceIds ? new Set(input.grantedEvidenceIds) : undefined;
  const causal = new Set(input.causalValidationIds ?? []);

  for (const [resourceId, value] of Object.entries(input.resources)) {
    const parsed = resourceReferenceSchema.safeParse(value);
    if (!parsed.success) diagnostics.push(problem("evidence.resource-invalid", `Resource ${resourceId} is invalid.`));
    else if (parsed.data.resourceId !== resourceId) diagnostics.push(problem("evidence.resource-key", `Resource key ${resourceId} does not match its identity.`));
  }

  for (const [evidenceId, value] of Object.entries(input.evidence)) {
    const parsed = evidenceReferenceSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push(problem("evidence.invalid", `Evidence ${evidenceId} is invalid.`));
      continue;
    }
    const record = parsed.data;
    if (record.evidenceId !== evidenceId) diagnostics.push(problem("evidence.key", `Evidence key ${evidenceId} does not match its identity.`));
    if (granted && !granted.has(evidenceId)) diagnostics.push(problem("evidence.not-granted", `Evidence ${evidenceId} was not host-granted.`));
    if (record.activityRefs.length === 0) diagnostics.push(problem("evidence.activity-missing", `Evidence ${evidenceId} lacks producing activity.`));
    if (record.validationIds.length === 0) diagnostics.push(problem("evidence.validation-missing", `Evidence ${evidenceId} lacks validation provenance.`));
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) diagnostics.push(problem("evidence.expired", `Evidence ${evidenceId} expired.`));
    if (input.actor) {
      if (!input.actor.allowedScopeRefs.includes(record.scopeRef)) diagnostics.push(problem("evidence.scope-denied", `Evidence ${evidenceId} is outside actor scope.`));
      if (!input.actor.allowedSensitivity.includes(record.sensitivity)) diagnostics.push(problem("evidence.sensitivity-denied", `Evidence ${evidenceId} sensitivity is denied.`));
    }
    for (const source of record.sourceRefs) {
      if (source.kind !== "resource") continue;
      const resource = input.resources[source.id];
      if (!resource) {
        diagnostics.push(problem("evidence.source-missing", `Evidence ${evidenceId} cites missing resource ${source.id}.`));
        continue;
      }
      if (source.contentHash !== undefined && source.contentHash !== resource.contentHash) diagnostics.push(problem("evidence.source-hash", `Evidence ${evidenceId} source hash does not match.`));
      if (record.scopeRef !== resource.scopeRef) diagnostics.push(problem("evidence.scope-broadened", `Evidence ${evidenceId} changed resource scope.`));
      if (rank(record.sensitivity) < rank(resource.sensitivity)) diagnostics.push(problem("evidence.sensitivity-lowered", `Evidence ${evidenceId} lowered source sensitivity.`));
      if (resource.expiresAt && (!record.expiresAt || Date.parse(record.expiresAt) > Date.parse(resource.expiresAt))) {
        diagnostics.push(problem("evidence.expiry-broadened", `Evidence ${evidenceId} outlives its source resource.`));
      }
    }
  }

  for (const [nodeId, node] of Object.entries(input.nodes)) {
    for (const evidenceId of node.evidence ?? []) {
      if (!input.evidence[evidenceId]) diagnostics.push(problem("evidence.node-reference", `Node ${nodeId} cites missing evidence ${evidenceId}.`));
    }
  }

  for (const [claimId, value] of Object.entries(input.claims)) {
    const parsed = claimBindingSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push(problem("claim.invalid", `Claim ${claimId} is invalid.`));
      continue;
    }
    const claim = parsed.data;
    if (claim.claimId !== claimId) diagnostics.push(problem("claim.key", `Claim key ${claimId} does not match its identity.`));
    if (!input.nodes[claim.nodeId]) diagnostics.push(problem("claim.node-missing", `Claim ${claimId} cites missing node ${claim.nodeId}.`));
    const records = claim.evidenceIds.map((id) => input.evidence[id]);
    if (records.some((record) => !record)) diagnostics.push(problem("claim.evidence-missing", `Claim ${claimId} cites missing evidence.`));
    if (claim.qualifier === "causal" && !records.some((record) => record?.validationIds.some((id) => causal.has(id)))) {
      diagnostics.push(problem("claim.causal-unsubstantiated", `Causal claim ${claimId} lacks a recognized causal validation.`));
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

export function assertEvidenceAndClaims(input: EvidenceValidationInput): void {
  const result = validateEvidenceAndClaims(input);
  if (!result.valid) throw new EvidenceValidationError(result.diagnostics);
}

export class EvidenceValidationError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; "));
    this.name = "EvidenceValidationError";
    this.diagnostics = diagnostics;
  }
}

function problem(code: string, message: string): Diagnostic {
  return createDiagnostic({ phase: "validate", code, severity: "error", recoverable: false, modelCorrectable: false, message });
}

function rank(value: Sensitivity): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}
