import type { HashProvider } from "./canonical";
import { canonicalHash, canonicalize, webCryptoSha256Provider } from "./canonical";
import { ARTIFACT_PROTOCOL, ARTIFACT_PROTOCOL_VERSION, DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import { JsonSchemaContractError, parseJsonWithSchema, prepareStateSchema } from "./json-schema";
import {
  artifactDocumentSchema,
  artifactSemanticContentSchema,
  type ActionStep,
  type ArtifactDocument,
  type ArtifactSemanticContent,
  type ArtifactValue,
  type Diagnostic,
  type ProtocolLimits,
} from "./schemas";
import { validateValueLimits } from "./values";

export type DocumentValidationOptions = {
  limits?: ProtocolLimits;
  expectedContractFingerprint?: string;
  verifyContentHash?: boolean;
  hashProvider?: HashProvider;
};

export function projectArtifactSemanticContent(document: ArtifactDocument): ArtifactSemanticContent {
  const state: ArtifactSemanticContent["state"] = {};
  for (const [stateId, definition] of Object.entries(document.state)) {
    const { expiresAt: _expiresAt, ...policy } = definition.policy;
    state[stateId] = { ...definition, policy };
  }

  const resources: ArtifactSemanticContent["resources"] = {};
  for (const [resourceId, reference] of Object.entries(document.resources)) {
    const { expiresAt: _expiresAt, ...semanticReference } = reference;
    resources[resourceId] = semanticReference;
  }

  const evidence: ArtifactSemanticContent["evidence"] = {};
  for (const [evidenceId, reference] of Object.entries(document.evidence)) {
    const {
      observedAt: _observedAt,
      recordedAt: _recordedAt,
      expiresAt: _expiresAt,
      ...semanticReference
    } = reference;
    evidence[evidenceId] = semanticReference;
  }

  const { expiresAt: _policyExpiry, ...policy } = document.policy;
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...meta } = document.meta;

  return artifactSemanticContentSchema.parse({
    protocol: ARTIFACT_PROTOCOL,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    policy,
    catalog: document.catalog,
    renderMode: document.renderMode,
    root: document.root,
    nodes: document.nodes,
    state,
    actions: document.actions,
    resources,
    evidence,
    claims: document.claims,
    meta,
  });
}

export async function hashArtifactSemanticContent(
  content: ArtifactSemanticContent,
  provider: HashProvider = webCryptoSha256Provider,
): Promise<string> {
  return canonicalHash(artifactSemanticContentSchema.parse(content), provider);
}

export async function validateArtifactDocument(
  input: unknown,
  options: DocumentValidationOptions = {},
): Promise<{ success: true; document: ArtifactDocument } | { success: false; diagnostics: Diagnostic[] }> {
  const parsed = artifactDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, diagnostics: diagnosticsFromZodError(parsed.error) };
  }

  const document = parsed.data;
  const diagnostics = inspectArtifactDocument(document, options.limits ?? DEFAULT_PROTOCOL_LIMITS);

  if (options.expectedContractFingerprint !== undefined) {
    if (document.catalog.contractFingerprint !== options.expectedContractFingerprint) {
      diagnostics.push(errorDiagnostic(
        "compatibility.catalog-fingerprint-mismatch",
        "Document catalog fingerprint does not match the selected manifest.",
      ));
    }
    if (document.revision.contractFingerprint !== options.expectedContractFingerprint) {
      diagnostics.push(errorDiagnostic(
        "compatibility.revision-fingerprint-mismatch",
        "Document revision fingerprint does not match the selected manifest.",
      ));
    }
  }

  if (options.verifyContentHash ?? true) {
    const actualHash = await hashArtifactSemanticContent(
      projectArtifactSemanticContent(document),
      options.hashProvider,
    );
    if (actualHash !== document.revision.contentHash) {
      diagnostics.push(errorDiagnostic(
        "revision.content-hash-mismatch",
        "Revision content hash does not match its semantic content.",
      ));
    }
  }

  for (const [stateId, definition] of Object.entries(document.state)) {
    try {
      const prepared = await prepareStateSchema(definition);
      parseJsonWithSchema(prepared.validator, definition.initial);
    } catch (error) {
      diagnostics.push(entityDiagnostic(
        error instanceof JsonSchemaContractError ? error.code : "state.schema-invalid",
        error instanceof Error ? error.message : "State schema validation failed.",
        "state",
        stateId,
      ));
    }
  }

  return diagnostics.length > 0
    ? { success: false, diagnostics }
    : { success: true, document };
}

export function inspectArtifactDocument(
  document: ArtifactDocument,
  limits: ProtocolLimits = DEFAULT_PROTOCOL_LIMITS,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const nodeIds = Object.keys(document.nodes);

  if (new TextEncoder().encode(canonicalize(document)).byteLength > limits.maxDocumentBytes) {
    diagnostics.push(errorDiagnostic("document.max-bytes", `Document exceeds ${limits.maxDocumentBytes} bytes.`));
  }
  if (nodeIds.length > limits.maxNodes) {
    diagnostics.push(errorDiagnostic("document.max-nodes", `Document exceeds ${limits.maxNodes} nodes.`));
  }
  if (document.catalog.contractFingerprint !== document.revision.contractFingerprint) {
    diagnostics.push(errorDiagnostic(
      "compatibility.document-fingerprint-mismatch",
      "Catalog and revision contract fingerprints differ.",
    ));
  }
  if (document.revision.parentRevisionIds.includes(document.revision.revisionId)) {
    diagnostics.push(errorDiagnostic("revision.self-parent", "A revision cannot be its own parent."));
  }
  if (new Set(document.revision.parentRevisionIds).size !== document.revision.parentRevisionIds.length) {
    diagnostics.push(errorDiagnostic("revision.duplicate-parent", "Revision parents must be unique."));
  }

  if (!Object.prototype.hasOwnProperty.call(document.nodes, document.root)) {
    diagnostics.push(entityDiagnostic("document.missing-root", `Root node ${document.root} does not exist.`, "document", document.documentId));
  }

  for (const [resourceId, reference] of Object.entries(document.resources)) {
    if (resourceId !== reference.resourceId) {
      diagnostics.push(entityDiagnostic("resource.identity-mismatch", "Resource map key and resourceId differ.", "resource", resourceId));
    }
  }
  for (const [evidenceId, reference] of Object.entries(document.evidence)) {
    if (evidenceId !== reference.evidenceId) {
      diagnostics.push(entityDiagnostic("evidence.identity-mismatch", "Evidence map key and evidenceId differ.", "evidence", evidenceId));
    }
  }
  for (const [claimId, claim] of Object.entries(document.claims)) {
    if (claimId !== claim.claimId) {
      diagnostics.push(entityDiagnostic("claim.identity-mismatch", "Claim map key and claimId differ.", "claim", claimId));
    }
    if (!document.nodes[claim.nodeId]) {
      diagnostics.push(entityDiagnostic("claim.missing-node", `Claim references missing node ${claim.nodeId}.`, "claim", claimId));
    }
    for (const evidenceId of claim.evidenceIds) {
      if (!document.evidence[evidenceId]) {
        diagnostics.push(entityDiagnostic("claim.missing-evidence", `Claim references missing evidence ${evidenceId}.`, "claim", claimId));
      }
    }
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const visitNode = (nodeId: string, depth: number): void => {
    if (depth > limits.maxDepth) {
      diagnostics.push(entityDiagnostic("document.max-depth", `Node graph exceeds depth ${limits.maxDepth}.`, "node", nodeId));
      return;
    }
    if (active.has(nodeId)) {
      diagnostics.push(entityDiagnostic("document.node-cycle", `Node graph contains a cycle at ${nodeId}.`, "node", nodeId));
      return;
    }
    if (visited.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) return;
    visited.add(nodeId);
    active.add(nodeId);

    for (const [prop, value] of Object.entries(node.props)) {
      diagnostics.push(...validateValueLimits(value, limits));
      inspectValueReferences(value, document, diagnostics, nodeId, `/props/${escapePointer(prop)}`, false);
    }
    for (const actionId of Object.values(node.events ?? {})) {
      if (!document.actions[actionId]) {
        diagnostics.push(entityDiagnostic("node.missing-action", `Node event references missing action ${actionId}.`, "node", nodeId));
      }
    }
    for (const evidenceId of node.evidence ?? []) {
      if (!document.evidence[evidenceId]) {
        diagnostics.push(entityDiagnostic("node.missing-evidence", `Node references missing evidence ${evidenceId}.`, "node", nodeId));
      }
    }
    for (const children of Object.values(node.slots ?? {})) {
      for (const childId of children) {
        if (!document.nodes[childId]) {
          diagnostics.push(entityDiagnostic("node.missing-child", `Node slot references missing node ${childId}.`, "node", nodeId));
          continue;
        }
        visitNode(childId, depth + 1);
      }
    }
    active.delete(nodeId);
  };

  visitNode(document.root, 1);
  for (const nodeId of nodeIds) {
    if (!visited.has(nodeId)) {
      diagnostics.push(entityDiagnostic("document.unreachable-node", `Node ${nodeId} is unreachable from the root.`, "node", nodeId));
    }
  }

  for (const [actionId, action] of Object.entries(document.actions)) {
    for (const step of action.steps) inspectActionStep(step, document, diagnostics, actionId, limits);
  }

  for (const [stateId, definition] of Object.entries(document.state)) {
    diagnostics.push(...validateValueLimits(definition.initial, limits));
    if (definition.policy.persistence === "host" && definition.policy.scope === "session") {
      diagnostics.push(entityDiagnostic(
        "state.invalid-retention",
        "Session-scoped state cannot request host persistence.",
        "state",
        stateId,
      ));
    }
  }

  return dedupeDiagnostics(diagnostics);
}

function inspectActionStep(
  step: ActionStep,
  document: ArtifactDocument,
  diagnostics: Diagnostic[],
  actionId: string,
  limits: ProtocolLimits,
): void {
  const inspect = (value: ArtifactValue, path: string): void => {
    diagnostics.push(...validateValueLimits(value, limits));
    inspectValueReferences(value, document, diagnostics, actionId, path, true);
  };

  if (step.type === "state.set") {
    if (!document.state[step.stateId]) {
      diagnostics.push(entityDiagnostic("action.missing-state", `Action references missing state ${step.stateId}.`, "action", actionId));
    }
    inspect(step.value, `/actions/${escapePointer(actionId)}/steps/${escapePointer(step.stepId)}/value`);
  } else if (step.type === "state.reset") {
    for (const stateId of step.stateIds) {
      if (!document.state[stateId]) diagnostics.push(entityDiagnostic("action.missing-state", `Action references missing state ${stateId}.`, "action", actionId));
    }
  } else if (step.type === "node.focus") {
    if (!document.nodes[step.nodeId]) diagnostics.push(entityDiagnostic("action.missing-node", `Action references missing node ${step.nodeId}.`, "action", actionId));
  } else if (step.type === "agent.message") {
    for (const [key, value] of Object.entries(step.values ?? {})) inspect(value, `/actions/${escapePointer(actionId)}/values/${escapePointer(key)}`);
  } else if (step.type === "capability.request") {
    for (const [key, value] of Object.entries(step.input)) inspect(value, `/actions/${escapePointer(actionId)}/input/${escapePointer(key)}`);
  } else if (step.type === "navigation.request") {
    if (step.target.kind === "route") {
      for (const [key, value] of Object.entries(step.target.params ?? {})) inspect(value, `/actions/${escapePointer(actionId)}/params/${escapePointer(key)}`);
    } else if (step.target.kind === "resource" && !document.resources[step.target.resourceId]) {
      diagnostics.push(entityDiagnostic("action.missing-resource", `Navigation references missing resource ${step.target.resourceId}.`, "action", actionId));
    } else if (step.target.kind === "external") {
      for (const [key, value] of Object.entries(step.target.input)) inspect(value, `/actions/${escapePointer(actionId)}/input/${escapePointer(key)}`);
    }
  }
}

function inspectValueReferences(
  value: ArtifactValue,
  document: ArtifactDocument,
  diagnostics: Diagnostic[],
  entityId: string,
  path: string,
  allowEvent: boolean,
): void {
  if (value.kind === "state-ref" && !document.state[value.stateId]) {
    diagnostics.push(entityDiagnostic("value.missing-state", `Value references missing state ${value.stateId}.`, "node", entityId, path));
  } else if (value.kind === "resource-ref" && !document.resources[value.resourceId]) {
    diagnostics.push(entityDiagnostic("value.missing-resource", `Value references missing resource ${value.resourceId}.`, "node", entityId, path));
  } else if (value.kind === "event-ref" && !allowEvent) {
    diagnostics.push(entityDiagnostic("value.event-ref-outside-action", "event-ref is legal only inside an action plan.", "node", entityId, path));
  } else if (value.kind === "array") {
    value.items.forEach((item, index) => inspectValueReferences(item, document, diagnostics, entityId, `${path}/${index}`, allowEvent));
  } else if (value.kind === "object") {
    for (const [key, item] of Object.entries(value.entries)) {
      inspectValueReferences(item, document, diagnostics, entityId, `${path}/${escapePointer(key)}`, allowEvent);
    }
  } else if (value.kind === "condition") {
    value.args.forEach((item, index) => inspectValueReferences(item, document, diagnostics, entityId, `${path}/args/${index}`, allowEvent));
  }
}

function errorDiagnostic(code: string, message: string): Diagnostic {
  return createDiagnostic({ phase: "validate", code, severity: "error", recoverable: true, modelCorrectable: true, message });
}

function entityDiagnostic(
  code: string,
  message: string,
  kind: NonNullable<NonNullable<Diagnostic["location"]>["entity"]>["kind"],
  id: string,
  path?: string,
): Diagnostic {
  return createDiagnostic({
    phase: "validate",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: true,
    message,
    location: { entity: { kind, id }, path },
  });
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.location?.entity?.kind ?? ""}:${diagnostic.location?.entity?.id ?? ""}:${diagnostic.location?.path ?? ""}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
