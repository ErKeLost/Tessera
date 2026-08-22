import { z } from "zod";
import { actionDefinitionSchema } from "./actions";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
} from "./constants";
import {
  actionIdSchema,
  actorAuditRefSchema,
  branchIdSchema,
  claimIdSchema,
  documentIdSchema,
  evidenceIdSchema,
  headTokenSchema,
  migrationReceiptIdSchema,
  nodeIdSchema,
  opaqueHostEvidenceKeySchema,
  placementIdSchema,
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  stateIdSchema,
} from "./ids";
import {
  canonicalStringify,
  hashCanonical,
  hashProfileIdSchema,
  sha256HashSchema,
  type HashProvider,
  type Sha256Hash,
} from "./hash";
import {
  isoTimestampSchema,
  jsonPointerSchema,
  safeObjectKeySchema,
} from "./json";
import { dataClassificationSchema } from "./policy";
import { actionContractRefSchema, catalogManifestRefSchema, contractRefSchema } from "./refs";
import { resourceBindingDeclarationSchema } from "./resources";
import { stateDefinitionSchema } from "./state";
import { valueExprSchema, type ValueExpr } from "./value-expr";

export const semanticDocumentMetaSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  description: z.string().max(4_096).optional(),
  locale: z.string().min(2).max(64).optional(),
  tags: z.array(z.string().min(1).max(128)).max(64),
}).strict();

export const documentRequirementsSchema = z.object({
  dataClassifications: z.array(dataClassificationSchema).max(32),
  evidence: z.enum(["none", "claims", "all-data"]),
  placements: z.array(placementIdSchema).max(32),
  capabilities: z.array(actionContractRefSchema).max(128),
}).strict().superRefine((requirements, context) => {
  requireSortedUnique(requirements.dataClassifications, context, ["dataClassifications"]);
  requireSortedUnique(requirements.placements, context, ["placements"]);
  requireSortedUnique(requirements.capabilities.map(canonicalStringify), context, ["capabilities"]);
});

export const canonicalNodeSchema = z.object({
  contract: contractRefSchema,
  props: z.record(safeObjectKeySchema, valueExprSchema),
  slots: z.record(safeObjectKeySchema, z.array(nodeIdSchema).max(1_000)),
  events: z.record(safeObjectKeySchema, actionIdSchema),
  evidence: z.array(evidenceIdSchema).max(1_000),
}).strict();

const hostEvidenceSourceSchema = z.object({
  kind: z.literal("host-evidence"),
  evidenceKey: opaqueHostEvidenceKeySchema,
  contentHash: sha256HashSchema,
  sourceAuthorityHash: sha256HashSchema,
}).strict();

const resourceEvidenceSourceSchema = z.object({
  kind: z.literal("resource-snapshot"),
  bindingId: resourceBindingIdSchema,
  resourceVersionId: resourceVersionIdSchema,
  contentHash: sha256HashSchema,
}).strict();

export const evidenceBindingSchema = z.object({
  source: z.discriminatedUnion("kind", [hostEvidenceSourceSchema, resourceEvidenceSourceSchema]),
  schemaHash: sha256HashSchema.optional(),
}).strict();

export const claimBindingSchema = z.object({
  nodeId: nodeIdSchema,
  path: jsonPointerSchema,
  kind: z.enum(["value", "analysis", "recommendation"]),
  evidenceIds: z.array(evidenceIdSchema).min(1).max(128),
}).strict().superRefine((claim, context) => {
  requireSortedUnique(claim.evidenceIds, context, ["evidenceIds"]);
});

export const documentContractsLockSchema = z.object({
  manifestRefs: z.array(catalogManifestRefSchema).min(1).max(128),
  contractSetHash: sha256HashSchema,
}).strict().superRefine((lock, context) => {
  requireSortedUnique(lock.manifestRefs.map(canonicalStringify), context, ["manifestRefs"]);
});

const documentContentBaseSchema = z.object({
  protocol: z.literal(OPEN_GENERATIVE_DOCUMENT_PROTOCOL),
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  contracts: documentContractsLockSchema,
  requirements: documentRequirementsSchema,
  rootNodeId: nodeIdSchema,
  nodes: z.record(nodeIdSchema, canonicalNodeSchema),
  stateDefinitions: z.record(stateIdSchema, stateDefinitionSchema),
  actions: z.record(actionIdSchema, actionDefinitionSchema),
  resourceBindings: z.record(resourceBindingIdSchema, resourceBindingDeclarationSchema),
  evidenceBindings: z.record(evidenceIdSchema, evidenceBindingSchema),
  claims: z.record(claimIdSchema, claimBindingSchema),
  meta: semanticDocumentMetaSchema,
}).strict();

export const documentContentSchema = documentContentBaseSchema.superRefine((content, context) => {
  validateDocumentReferences(content, context);
});

export const revisionEnvelopeSchema = z.object({
  documentId: documentIdSchema,
  revisionId: revisionIdSchema,
  parentRevisionIds: z.array(revisionIdSchema).max(16),
  contentHash: sha256HashSchema,
  hashProfile: hashProfileIdSchema,
  migrationReceiptIds: z.array(migrationReceiptIdSchema).max(1_000),
  createdAt: isoTimestampSchema,
  createdBy: actorAuditRefSchema,
}).strict().superRefine((envelope, context) => {
  requireUnique(envelope.parentRevisionIds, context, ["parentRevisionIds"]);
  if (envelope.parentRevisionIds.includes(envelope.revisionId)) {
    context.addIssue({ code: "custom", path: ["parentRevisionIds"], message: "Revision cannot be its own parent." });
  }
  requireUnique(envelope.migrationReceiptIds, context, ["migrationReceiptIds"]);
});

export const committedRevisionSchema = z.object({
  envelope: revisionEnvelopeSchema,
  content: documentContentSchema,
}).strict();

export const branchHeadSchema = z.object({
  documentId: documentIdSchema,
  branchId: branchIdSchema,
  revisionId: revisionIdSchema,
  headToken: headTokenSchema,
}).strict();

export type SemanticDocumentMeta = z.infer<typeof semanticDocumentMetaSchema>;
export type DocumentRequirements = z.infer<typeof documentRequirementsSchema>;
export type CanonicalNode = z.infer<typeof canonicalNodeSchema>;
export type EvidenceBinding = z.infer<typeof evidenceBindingSchema>;
export type ClaimBinding = z.infer<typeof claimBindingSchema>;
export type DocumentContractsLock = z.infer<typeof documentContractsLockSchema>;
export type DocumentContent = z.infer<typeof documentContentSchema>;
export type RevisionEnvelope = z.infer<typeof revisionEnvelopeSchema>;
export type CommittedRevision = z.infer<typeof committedRevisionSchema>;
export type BranchHead = z.infer<typeof branchHeadSchema>;

export async function hashDocumentContent(
  input: DocumentContent,
  provider?: HashProvider,
): Promise<Sha256Hash> {
  const content = documentContentSchema.parse(input);
  return hashCanonical(HASH_DOMAINS.documentContent, content, provider);
}

export async function verifyCommittedRevision(
  input: CommittedRevision,
  provider?: HashProvider,
): Promise<boolean> {
  const revision = committedRevisionSchema.parse(input);
  if (revision.envelope.hashProfile !== OPEN_GENERATIVE_HASH_PROFILE_ID) return false;
  return await hashDocumentContent(revision.content, provider) === revision.envelope.contentHash;
}

type StructuralDocumentContent = z.infer<typeof documentContentBaseSchema>;

function validateDocumentReferences(content: StructuralDocumentContent, context: z.RefinementCtx): void {
  const nodeEntries = Object.entries(content.nodes);
  if (!content.nodes[content.rootNodeId]) {
    context.addIssue({ code: "custom", path: ["rootNodeId"], message: "Root node does not exist." });
  }

  const manifestIdentities = new Set(
    content.contracts.manifestRefs.map((ref) => `${ref.publisher}/${ref.catalogId}`),
  );
  for (const [nodeId, node] of nodeEntries) {
    if (!manifestIdentities.has(`${node.contract.publisher}/${node.contract.catalogId}`)) {
      context.addIssue({ code: "custom", path: ["nodes", nodeId, "contract"], message: "Node contract catalog is not locked by the document." });
    }
    for (const [slot, childIds] of Object.entries(node.slots)) {
      for (const [index, childId] of childIds.entries()) {
        if (!content.nodes[childId]) {
          context.addIssue({ code: "custom", path: ["nodes", nodeId, "slots", slot, index], message: "Slot references a missing node." });
        }
      }
    }
    for (const [port, actionId] of Object.entries(node.events)) {
      if (!content.actions[actionId]) {
        context.addIssue({ code: "custom", path: ["nodes", nodeId, "events", port], message: "Event references a missing action." });
      }
    }
    for (const [index, evidenceId] of node.evidence.entries()) {
      if (!content.evidenceBindings[evidenceId]) {
        context.addIssue({ code: "custom", path: ["nodes", nodeId, "evidence", index], message: "Node references missing evidence." });
      }
    }
    for (const [prop, expression] of Object.entries(node.props)) {
      validateValueReferences(expression, content, context, ["nodes", nodeId, "props", prop]);
    }
  }

  validateNodeGraph(content, context);

  for (const [actionId, action] of Object.entries(content.actions)) {
    if (action.kind === "local-transition") {
      for (const [index, transition] of action.transitions.entries()) {
        if (transition.type === "node.focus" && !content.nodes[transition.nodeId]) {
          context.addIssue({ code: "custom", path: ["actions", actionId, "transitions", index, "nodeId"], message: "Transition references a missing node." });
        }
        if ((transition.type === "state.set" || transition.type === "state.reset") && !content.stateDefinitions[transition.stateId]) {
          context.addIssue({ code: "custom", path: ["actions", actionId, "transitions", index, "stateId"], message: "Transition references missing state." });
        }
        if (transition.type === "state.set") {
          validateValueReferences(transition.value, content, context, ["actions", actionId, "transitions", index, "value"]);
        }
      }
    } else {
      for (const [key, expression] of Object.entries(action.input)) {
        validateValueReferences(expression, content, context, ["actions", actionId, "input", key]);
      }
    }
  }

  for (const [bindingId, binding] of Object.entries(content.resourceBindings)) {
    const stateId = binding.selector.filterStateRef;
    if (stateId && !content.stateDefinitions[stateId]) {
      context.addIssue({ code: "custom", path: ["resourceBindings", bindingId, "selector", "filterStateRef"], message: "Resource selector references missing state." });
    }
  }

  for (const [evidenceId, evidence] of Object.entries(content.evidenceBindings)) {
    if (evidence.source.kind === "resource-snapshot" && !content.resourceBindings[evidence.source.bindingId]) {
      context.addIssue({ code: "custom", path: ["evidenceBindings", evidenceId, "source", "bindingId"], message: "Evidence references a missing resource binding." });
    }
  }

  for (const [claimId, claim] of Object.entries(content.claims)) {
    if (!content.nodes[claim.nodeId]) {
      context.addIssue({ code: "custom", path: ["claims", claimId, "nodeId"], message: "Claim references a missing node." });
    }
    for (const [index, evidenceId] of claim.evidenceIds.entries()) {
      if (!content.evidenceBindings[evidenceId]) {
        context.addIssue({ code: "custom", path: ["claims", claimId, "evidenceIds", index], message: "Claim references missing evidence." });
      }
    }
  }
}

function validateValueReferences(
  expression: ValueExpr,
  content: StructuralDocumentContent,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (expression.kind === "state-ref" && !content.stateDefinitions[expression.stateId]) {
    context.addIssue({ code: "custom", path, message: "Value expression references missing state." });
  } else if (expression.kind === "resource-ref" && !content.resourceBindings[expression.bindingId]) {
    context.addIssue({ code: "custom", path, message: "Value expression references a missing resource binding." });
  } else if (expression.kind === "array") {
    expression.items.forEach((item, index) => validateValueReferences(item, content, context, [...path, "items", index]));
  } else if (expression.kind === "object") {
    Object.entries(expression.entries).forEach(([key, item]) => validateValueReferences(item, content, context, [...path, "entries", key]));
  } else if (expression.kind === "condition") {
    expression.args.forEach((item, index) => validateValueReferences(item, content, context, [...path, "args", index]));
  }
}

function validateNodeGraph(content: StructuralDocumentContent, context: z.RefinementCtx): void {
  const nodes = content.nodes as Record<string, CanonicalNode>;
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (nodeId: string): void => {
    if (active.has(nodeId)) {
      context.addIssue({ code: "custom", path: ["nodes", nodeId], message: "Node graph contains a cycle." });
      return;
    }
    if (visited.has(nodeId)) return;
    const node = nodes[nodeId];
    if (!node) return;
    visited.add(nodeId);
    active.add(nodeId);
    for (const children of Object.values(node.slots)) for (const childId of children) visit(childId);
    active.delete(nodeId);
  };
  visit(content.rootNodeId);
  for (const nodeId of Object.keys(nodes)) {
    if (!visited.has(nodeId)) {
      context.addIssue({ code: "custom", path: ["nodes", nodeId], message: "Node is unreachable from the root." });
    }
  }
}

function requireSortedUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  requireUnique(values, context, path);
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! > values[index]!) {
      context.addIssue({ code: "custom", path, message: "Set-like arrays must be sorted canonically." });
      return;
    }
  }
}

function requireUnique(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Set-like arrays must not contain duplicates." });
  }
}
