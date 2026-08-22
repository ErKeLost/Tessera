import { z } from "zod";
import {
  ARTIFACT_PROTOCOL,
  ARTIFACT_PROTOCOL_VERSION,
  BOOTSTRAP_PROTOCOL,
  FORBIDDEN_OBJECT_KEYS,
  RESOURCE_PROTOCOL,
  STREAM_PROTOCOL,
} from "./constants";

export type Scalar = null | boolean | string | number;
export type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type PathSegment = string | number;

export type ArtifactValue =
  | { kind: "literal"; value: Scalar }
  | { kind: "array"; items: ArtifactValue[] }
  | { kind: "object"; entries: Record<string, ArtifactValue> }
  | { kind: "state-ref"; stateId: string; path?: PathSegment[] }
  | { kind: "resource-ref"; resourceId: string; path?: PathSegment[] }
  | { kind: "event-ref"; port: string; path?: PathSegment[] }
  | { kind: "context-ref"; key: "locale" | "timezone" }
  | {
      kind: "condition";
      op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not";
      args: ArtifactValue[];
    };

const identifierSchema = z.string().min(1).max(512);
const hashSchema = z.string().min(1).max(512);
const versionStringSchema = z.string().min(1).max(128);
const finiteNumberSchema = z.number().refine(Number.isFinite, "Number must be finite.");
const safeObjectKeySchema = z.string().max(1_024).refine(
  (key) => !FORBIDDEN_OBJECT_KEYS.has(key),
  "Prototype-polluting object key is forbidden.",
);

export const scalarSchema: z.ZodType<Scalar> = z.union([
  z.null(),
  z.boolean(),
  z.string(),
  finiteNumberSchema,
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  scalarSchema,
  z.array(jsonValueSchema),
  z.record(safeObjectKeySchema, jsonValueSchema),
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  safeObjectKeySchema,
  jsonValueSchema,
);

export const pathSegmentSchema = z.union([
  safeObjectKeySchema,
  z.number().int().nonnegative(),
]);

const pathSchema = z.array(pathSegmentSchema).max(64).optional();

export const artifactValueSchema: z.ZodType<ArtifactValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: scalarSchema }).strict(),
    z.object({ kind: z.literal("array"), items: z.array(artifactValueSchema) }).strict(),
    z.object({
      kind: z.literal("object"),
      entries: z.record(safeObjectKeySchema, artifactValueSchema),
    }).strict(),
    z.object({ kind: z.literal("state-ref"), stateId: identifierSchema, path: pathSchema }).strict(),
    z.object({ kind: z.literal("resource-ref"), resourceId: identifierSchema, path: pathSchema }).strict(),
    z.object({ kind: z.literal("event-ref"), port: identifierSchema, path: pathSchema }).strict(),
    z.object({ kind: z.literal("context-ref"), key: z.enum(["locale", "timezone"]) }).strict(),
    z.object({
      kind: z.literal("condition"),
      op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"]),
      args: z.array(artifactValueSchema),
    }).strict(),
  ]),
);

export const artifactMetaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  locale: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).strict();

export const informationFlowLabelSchema = z.object({
  scopeRef: identifierSchema,
  sensitivity: z.enum(["public", "private", "sensitive"]),
  persistence: z.enum(["none", "session", "host"]),
  allowedSinks: z.array(z.enum([
    "model-generation",
    "renderer",
    "model-repair",
    "export",
    "share",
    "telemetry",
  ])),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const documentPolicySchema = informationFlowLabelSchema.extend({
  policyId: identifierSchema,
  policyVersion: z.number().int().positive(),
  policyHash: hashSchema,
}).strict();

export const statePolicySchema = z.object({
  policyId: identifierSchema,
  policyVersion: z.number().int().positive(),
  policyHash: hashSchema,
  scope: z.enum(["document", "session", "user"]),
  persistence: z.enum(["none", "session", "host"]),
  sensitivity: z.enum(["public", "private", "sensitive"]),
  modelAccess: z.enum(["none", "read", "read-write"]),
  lifecycle: z.enum(["retain", "reset-on-commit", "prune-when-unreferenced"]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export const stateDefinitionSchema = z.object({
  schemaId: identifierSchema,
  schema: jsonObjectSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  initial: jsonValueSchema,
  policy: statePolicySchema,
}).strict();

export const stateRecordSchema = z.object({
  documentId: identifierSchema,
  branchId: identifierSchema,
  stateId: identifierSchema,
  stateRevision: identifierSchema,
  schemaId: identifierSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  policyHash: hashSchema,
  value: jsonValueSchema,
}).strict();

export const stateMigrationKeySchema = z.object({
  schemaId: identifierSchema,
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
}).strict();

export const stateMigrationReceiptSchema = z.object({
  receiptId: identifierSchema,
  documentId: identifierSchema,
  branchId: identifierSchema,
  stateId: identifierSchema,
  key: stateMigrationKeySchema,
  fromSchemaHash: hashSchema,
  toSchemaHash: hashSchema,
  inputHash: hashSchema,
  outputHash: hashSchema,
  migrationIds: z.array(identifierSchema),
  appliedAt: z.iso.datetime({ offset: true }),
}).strict();

export const stateTransitionReceiptSchema = z.object({
  receiptId: identifierSchema,
  operationKey: identifierSchema,
  invocationId: identifierSchema.optional(),
  stepId: identifierSchema.optional(),
  documentId: identifierSchema,
  branchId: identifierSchema,
  stateId: identifierSchema,
  transition: z.enum(["write", "reset", "prune", "migrate"]),
  fromStateRevision: identifierSchema,
  toStateRevision: identifierSchema.optional(),
  schemaHash: hashSchema,
  policyHash: hashSchema,
  migrationReceiptId: identifierSchema.optional(),
  recordedAt: z.iso.datetime({ offset: true }),
  auditRef: identifierSchema,
}).strict();

export const clientStateTransitionReceiptSchema = stateTransitionReceiptSchema.omit({ auditRef: true });

export const navigationTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("route"),
    capabilityId: identifierSchema,
    routeId: identifierSchema,
    params: z.record(safeObjectKeySchema, artifactValueSchema).optional(),
  }).strict(),
  z.object({
    kind: z.literal("resource"),
    capabilityId: identifierSchema,
    resourceId: identifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("external"),
    capabilityId: identifierSchema,
    input: z.record(safeObjectKeySchema, artifactValueSchema),
  }).strict(),
]);

export const actionStepSchema = z.discriminatedUnion("type", [
  z.object({ stepId: identifierSchema, type: z.literal("state.set"), stateId: identifierSchema, value: artifactValueSchema }).strict(),
  z.object({ stepId: identifierSchema, type: z.literal("state.reset"), stateIds: z.array(identifierSchema).min(1) }).strict(),
  z.object({ stepId: identifierSchema, type: z.literal("node.focus"), nodeId: identifierSchema }).strict(),
  z.object({
    stepId: identifierSchema,
    type: z.literal("agent.message"),
    templateGrantId: identifierSchema,
    values: z.record(safeObjectKeySchema, artifactValueSchema).optional(),
  }).strict(),
  z.object({
    stepId: identifierSchema,
    type: z.literal("capability.request"),
    capabilityId: identifierSchema,
    input: z.record(safeObjectKeySchema, artifactValueSchema),
  }).strict(),
  z.object({ stepId: identifierSchema, type: z.literal("navigation.request"), target: navigationTargetSchema }).strict(),
]);

export const actionPlanSchema = z.object({
  contractId: identifierSchema,
  contractVersion: z.number().int().positive(),
  steps: z.array(actionStepSchema).min(1),
  onError: z.enum(["halt", "continue"]),
}).strict().superRefine((plan, context) => {
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (seen.has(step.stepId)) {
      context.addIssue({ code: "custom", message: `Duplicate action step ID: ${step.stepId}` });
    }
    seen.add(step.stepId);
  }
});

export const artifactNodeSchema = z.object({
  type: identifierSchema,
  typeVersion: z.number().int().positive(),
  props: z.record(safeObjectKeySchema, artifactValueSchema),
  slots: z.record(safeObjectKeySchema, z.array(identifierSchema)).optional(),
  events: z.record(safeObjectKeySchema, identifierSchema).optional(),
  evidence: z.array(identifierSchema).optional(),
}).strict();

const resourceReferenceBaseSchema = z.object({
  resourceId: identifierSchema,
  schemaId: identifierSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  codec: z.object({ id: identifierSchema, version: versionStringSchema }).strict(),
  mediaType: z.string().min(1).max(256),
  contentHash: hashSchema,
  scopeRef: identifierSchema,
  sensitivity: z.enum(["public", "private", "sensitive"]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  preview: jsonValueSchema.optional(),
  previewPersistence: z.literal("document").optional(),
}).strict();

function validateResourcePreview(
  resource: z.infer<typeof resourceReferenceBaseSchema>,
  context: z.core.$RefinementCtx<z.infer<typeof resourceReferenceBaseSchema>>,
): void {
  const hasPreview = resource.preview !== undefined || resource.previewPersistence !== undefined;
  if (hasPreview && (
    resource.preview === undefined
    || resource.previewPersistence !== "document"
    || resource.sensitivity !== "public"
    || resource.expiresAt !== undefined
  )) {
    context.addIssue({
      code: "custom",
      message: "Inline previews must be public, non-expiring, and document-persisted.",
    });
  }
}

export const resourceReferenceSchema = resourceReferenceBaseSchema.superRefine(validateResourcePreview);

export const evidenceSourceReferenceSchema = z.object({
  kind: z.enum(["resource", "dataset", "document", "service"]),
  id: identifierSchema,
  contentHash: hashSchema.optional(),
}).strict();

export const evidenceReferenceSchema = z.object({
  evidenceId: identifierSchema,
  schemaId: identifierSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  sourceRefs: z.array(evidenceSourceReferenceSchema).min(1),
  activityRefs: z.array(identifierSchema),
  contentHash: hashSchema,
  scopeRef: identifierSchema,
  observedAt: z.iso.datetime({ offset: true }).optional(),
  recordedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  validationIds: z.array(identifierSchema),
  sensitivity: z.enum(["public", "private", "sensitive"]),
}).strict();

export const claimBindingSchema = z.object({
  claimId: identifierSchema,
  nodeId: identifierSchema,
  fieldPath: z.array(pathSegmentSchema).max(64).optional(),
  evidenceIds: z.array(identifierSchema).min(1),
  qualifier: z.enum(["observed", "estimated", "correlational", "causal"]),
}).strict();

export const revisionIdentitySchema = z.object({
  revisionId: identifierSchema,
  parentRevisionIds: z.array(identifierSchema),
  branchId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  contentHash: hashSchema,
  contractFingerprint: hashSchema,
  migrationReceiptIds: z.array(identifierSchema),
  stateTransitionReceiptIds: z.array(identifierSchema),
}).strict();

const catalogIdentitySchema = z.object({
  id: identifierSchema,
  version: versionStringSchema,
  contractFingerprint: hashSchema,
}).strict();

export const artifactDocumentSchema = z.object({
  protocol: z.literal(ARTIFACT_PROTOCOL),
  protocolVersion: z.literal(ARTIFACT_PROTOCOL_VERSION),
  documentId: identifierSchema,
  revision: revisionIdentitySchema,
  policy: documentPolicySchema,
  catalog: catalogIdentitySchema,
  renderMode: z.enum(["strict", "progressive"]),
  root: identifierSchema,
  nodes: z.record(identifierSchema, artifactNodeSchema),
  state: z.record(identifierSchema, stateDefinitionSchema),
  actions: z.record(identifierSchema, actionPlanSchema),
  resources: z.record(identifierSchema, resourceReferenceSchema),
  evidence: z.record(identifierSchema, evidenceReferenceSchema),
  claims: z.record(identifierSchema, claimBindingSchema),
  meta: artifactMetaSchema.extend({
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

const semanticStatePolicySchema = statePolicySchema.omit({ expiresAt: true });
const semanticStateDefinitionSchema = stateDefinitionSchema.extend({ policy: semanticStatePolicySchema });
const semanticResourceReferenceSchema = resourceReferenceBaseSchema
  .omit({ expiresAt: true })
  .superRefine(validateResourcePreview);
const semanticEvidenceReferenceSchema = evidenceReferenceSchema.omit({
  observedAt: true,
  recordedAt: true,
  expiresAt: true,
});

export const artifactSemanticContentSchema = z.object({
  protocol: z.literal(ARTIFACT_PROTOCOL),
  protocolVersion: z.literal(ARTIFACT_PROTOCOL_VERSION),
  policy: documentPolicySchema.omit({ expiresAt: true }),
  catalog: catalogIdentitySchema,
  renderMode: z.enum(["strict", "progressive"]),
  root: identifierSchema,
  nodes: z.record(identifierSchema, artifactNodeSchema),
  state: z.record(identifierSchema, semanticStateDefinitionSchema),
  actions: z.record(identifierSchema, actionPlanSchema),
  resources: z.record(identifierSchema, semanticResourceReferenceSchema),
  evidence: z.record(identifierSchema, semanticEvidenceReferenceSchema),
  claims: z.record(identifierSchema, claimBindingSchema),
  meta: artifactMetaSchema,
}).strict();

export const branchHeadPreconditionSchema = z.object({
  branchId: identifierSchema,
  revisionId: identifierSchema,
  headToken: identifierSchema,
}).strict();

const createProposalTargetSchema = z.object({
  mode: z.literal("create"),
  documentId: identifierSchema,
  branchId: identifierSchema,
  parentRevisionIds: z.tuple([]),
}).strict();

const editProposalTargetSchema = z.object({
  mode: z.literal("edit"),
  documentId: identifierSchema,
  branchId: identifierSchema,
  parentRevisionIds: z.tuple([identifierSchema]),
  headPreconditions: z.array(branchHeadPreconditionSchema).min(1),
  statePreconditions: z.record(identifierSchema, identifierSchema),
}).strict();

const mergeProposalTargetSchema = z.object({
  mode: z.literal("merge"),
  documentId: identifierSchema,
  branchId: identifierSchema,
  parentRevisionIds: z.array(identifierSchema).min(2),
  headPreconditions: z.array(branchHeadPreconditionSchema).min(1),
  statePreconditions: z.record(identifierSchema, identifierSchema),
}).strict();

export const proposalTargetSchema = z.discriminatedUnion("mode", [
  createProposalTargetSchema,
  editProposalTargetSchema,
  mergeProposalTargetSchema,
]);

export const schemaProfileBindingSchema = z.object({
  profileId: z.literal("data-elements.schema-core"),
  profileVersion: z.number().int().positive(),
  profileHash: hashSchema,
}).strict();

export const proposalContextSchema = z.object({
  protocolVersion: z.literal(ARTIFACT_PROTOCOL_VERSION),
  contractFingerprint: hashSchema,
  promptBundleHash: hashSchema,
  schemaProfile: schemaProfileBindingSchema,
  documentPolicy: documentPolicySchema,
  generationTaintHash: hashSchema,
  renderMode: z.enum(["strict", "progressive"]),
  actionContractVersions: z.record(identifierSchema, z.number().int().positive()),
  resourceGrants: z.record(identifierSchema, resourceReferenceSchema),
  evidenceGrants: z.record(identifierSchema, evidenceReferenceSchema),
  capabilityGrantVersions: z.record(identifierSchema, z.number().int().positive()),
  messageTemplateGrantVersions: z.record(identifierSchema, z.number().int().positive()),
  grantSetVersion: z.number().int().nonnegative(),
  authorizationContextRef: identifierSchema,
  policyProfileHash: hashSchema,
  target: proposalTargetSchema,
}).strict();

export const draftOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put-node"), nodeId: identifierSchema, value: artifactNodeSchema }).strict(),
  z.object({ op: z.literal("remove-node"), nodeId: identifierSchema }).strict(),
  z.object({ op: z.literal("put-state"), stateId: identifierSchema, value: stateDefinitionSchema }).strict(),
  z.object({ op: z.literal("remove-state"), stateId: identifierSchema }).strict(),
  z.object({ op: z.literal("put-action"), actionId: identifierSchema, value: actionPlanSchema }).strict(),
  z.object({ op: z.literal("remove-action"), actionId: identifierSchema }).strict(),
  z.object({ op: z.literal("put-claim"), claimId: identifierSchema, value: claimBindingSchema }).strict(),
  z.object({ op: z.literal("remove-claim"), claimId: identifierSchema }).strict(),
  z.object({ op: z.literal("attach-resource"), resourceId: identifierSchema }).strict(),
  z.object({ op: z.literal("detach-resource"), resourceId: identifierSchema }).strict(),
  z.object({ op: z.literal("set-root"), nodeId: identifierSchema }).strict(),
  z.object({ op: z.literal("set-meta"), value: artifactMetaSchema }).strict(),
]);

export const commitCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("begin"), transactionId: identifierSchema, context: proposalContextSchema }).strict(),
  z.object({
    type: z.literal("apply"),
    transactionId: identifierSchema,
    seq: z.number().int().positive(),
    opId: identifierSchema,
    payloadHash: hashSchema,
    operation: draftOperationSchema,
  }).strict(),
  z.object({ type: z.literal("finalize"), transactionId: identifierSchema, canonicalDraftHash: hashSchema }).strict(),
  z.object({ type: z.literal("abort"), transactionId: identifierSchema, reason: z.string().optional() }).strict(),
]);

export const diagnosticSchema = z.object({
  phase: z.enum(["decode", "normalize", "validate", "policy", "commit", "render", "effect", "transport"]),
  code: identifierSchema,
  severity: z.enum(["info", "warning", "error", "fatal"]),
  recoverable: z.boolean(),
  modelCorrectable: z.boolean(),
  message: z.string(),
  location: z.object({
    streamId: identifierSchema.optional(),
    transactionId: identifierSchema.optional(),
    seq: z.number().int().nonnegative().optional(),
    opId: identifierSchema.optional(),
    revisionId: identifierSchema.optional(),
    entity: z.object({
      kind: z.enum(["document", "node", "state", "action", "resource", "evidence", "claim", "effect", "migration"]),
      id: identifierSchema,
    }).strict().optional(),
    path: z.string().optional(),
  }).strict().optional(),
  expected: jsonValueSchema.optional(),
  actualSummary: z.string().optional(),
  hint: z.string().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();

export const migrationReceiptSchema = z.object({
  receiptId: identifierSchema,
  entity: z.enum(["document", "node", "state", "resource", "evidence"]),
  source: z.object({ version: versionStringSchema, contentHash: hashSchema }).strict(),
  target: z.object({ version: versionStringSchema, contentHash: hashSchema }).strict(),
  migrationIds: z.array(identifierSchema).min(1),
  warnings: z.array(z.string()),
  droppedPaths: z.array(z.string()),
  appliedAt: z.iso.datetime({ offset: true }),
}).strict();

export const protocolLimitsSchema = z.object({
  maxFrameBytes: z.number().int().positive(),
  maxDocumentBytes: z.number().int().positive(),
  maxNodes: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  maxStringBytes: z.number().int().positive(),
  maxCollectionItems: z.number().int().positive(),
  maxObjectKeys: z.number().int().positive(),
  maxTotalValues: z.number().int().positive(),
  maxResolvedResourceBytes: z.number().int().positive(),
  maxConcurrentResourceRequests: z.number().int().positive(),
  maxSnapshotReceipts: z.number().int().positive(),
  maxOperationsPerTransaction: z.number().int().positive(),
  maxBufferedGapFrames: z.number().int().nonnegative(),
  maxBufferedGapBytes: z.number().int().nonnegative(),
  maxBufferedGapMs: z.number().int().nonnegative(),
  transactionTimeoutMs: z.number().int().positive(),
}).strict();

export const catalogCompatibilityManifestSchema = z.object({
  catalogReleaseId: identifierSchema,
  catalogId: identifierSchema,
  catalogVersion: versionStringSchema,
  schemaProfile: schemaProfileBindingSchema,
  policyProfileHash: hashSchema,
  contractFingerprint: hashSchema,
  nodeVersions: z.record(identifierSchema, z.number().int().positive()),
  actionContractVersions: z.record(identifierSchema, z.number().int().positive()),
  runtimeApiRange: z.string().min(1),
  rendererApiRange: z.string().min(1),
  rendererBuildHash: hashSchema,
  rendererConformance: z.enum(["official", "custom-verified", "custom-unverified"]),
}).strict();

export const compatibilityOfferSchema = z.object({
  documentProtocolRanges: z.array(z.string().min(1)).min(1),
  streamProtocolRanges: z.array(z.string().min(1)).min(1),
  codecs: z.array(z.object({ id: identifierSchema, versions: z.array(versionStringSchema).min(1) }).strict()).min(1),
  runtimeApiRanges: z.array(z.string().min(1)).min(1),
  rendererApiRanges: z.array(z.string().min(1)).min(1),
  requiredFeatures: z.array(identifierSchema),
  optionalFeatures: z.array(identifierSchema),
  catalogManifests: z.array(catalogCompatibilityManifestSchema).min(1),
  limits: protocolLimitsSchema,
}).strict();

export const compatibilitySelectionSchema = z.object({
  documentProtocol: versionStringSchema,
  streamProtocol: versionStringSchema,
  codec: z.object({ id: identifierSchema, version: versionStringSchema }).strict(),
  runtimeApiVersion: versionStringSchema,
  rendererApiVersion: versionStringSchema,
  enabledFeatures: z.array(identifierSchema),
  catalogManifest: catalogCompatibilityManifestSchema,
  limits: protocolLimitsSchema,
}).strict();

export const bootstrapHelloSchema = z.object({
  bootstrapProtocol: z.literal(BOOTSTRAP_PROTOCOL),
  type: z.literal("hello"),
  requestId: identifierSchema,
  offer: compatibilityOfferSchema,
}).strict();

export const bootstrapResponseSchema = z.discriminatedUnion("type", [
  z.object({
    bootstrapProtocol: z.literal(BOOTSTRAP_PROTOCOL),
    type: z.literal("ready"),
    requestId: identifierSchema,
    streamId: identifierSchema,
    selection: compatibilitySelectionSchema,
  }).strict(),
  z.object({
    bootstrapProtocol: z.literal(BOOTSTRAP_PROTOCOL),
    type: z.literal("incompatible"),
    requestId: identifierSchema,
    reasons: z.array(z.object({ code: identifierSchema, message: z.string() }).strict()).min(1),
  }).strict(),
]);

export const actionInvocationStatusSchema = z.enum([
  "pending", "running", "awaiting-approval", "cancel-requested", "succeeded", "failed", "cancelled",
]);

export const clientActionInvocationSummarySchema = z.object({
  invocationId: identifierSchema,
  actionId: identifierSchema,
  status: actionInvocationStatusSchema,
  nextStepId: identifierSchema.optional(),
  completedStepIds: z.array(identifierSchema),
  pendingEffectRequestIds: z.array(identifierSchema),
}).strict();

export const effectStatusSchema = z.enum([
  "pending", "denied", "awaiting-approval", "approved", "running", "cancel-requested", "succeeded", "failed", "cancelled",
]);

export const clientEffectSummarySchema = z.object({
  requestId: identifierSchema,
  invocationId: identifierSchema,
  stepId: identifierSchema,
  actionId: identifierSchema,
  capabilityId: identifierSchema,
  status: effectStatusSchema,
  cancellable: z.boolean(),
}).strict();

export const clientApprovalCheckpointSchema = z.object({
  checkpointId: identifierSchema,
  effectRequestId: identifierSchema,
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]),
  capabilityId: identifierSchema,
  risk: z.enum(["low", "medium", "high", "critical"]),
  title: z.string(),
  summary: z.string().optional(),
  redactedInputSummary: jsonValueSchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const runtimeSnapshotSchema = z.object({
  document: artifactDocumentSchema,
  branchHead: branchHeadPreconditionSchema,
  state: z.array(stateRecordSchema),
  pendingActions: z.array(clientActionInvocationSummarySchema),
  pendingEffects: z.array(clientEffectSummarySchema),
  activeApprovals: z.array(clientApprovalCheckpointSchema),
  stateMigrationReceipts: z.array(stateMigrationReceiptSchema),
  stateTransitionReceipts: z.array(clientStateTransitionReceiptSchema),
}).strict();

export const actionCancellationReceiptSchema = z.object({
  cancellationId: identifierSchema,
  cancelRequestId: identifierSchema,
  invocationId: identifierSchema,
  outcome: z.enum(["cancel-requested", "cancelled", "too-late"]),
  actionStatus: actionInvocationStatusSchema,
  recordedAt: z.iso.datetime({ offset: true }),
}).strict();

export const effectCancellationReceiptSchema = z.object({
  cancellationId: identifierSchema,
  cancelRequestId: identifierSchema,
  effectRequestId: identifierSchema,
  outcome: z.enum(["cancel-requested", "cancelled", "too-late"]),
  effectStatus: effectStatusSchema,
  recordedAt: z.iso.datetime({ offset: true }),
}).strict();

export const clientEffectReceiptSchema = z.object({
  receiptId: identifierSchema,
  requestId: identifierSchema,
  status: effectStatusSchema,
  output: z.object({
    contentHash: hashSchema,
    mediaType: z.string(),
    sensitivity: z.enum(["public", "private", "sensitive"]),
    outputResourceId: identifierSchema.optional(),
    evidenceIds: z.array(identifierSchema),
  }).strict().optional(),
  publication: z.object({
    status: z.enum(["not-requested", "committed", "conflict"]),
    expectedHeadToken: identifierSchema,
    revisionId: identifierSchema.optional(),
  }).strict().optional(),
  diagnostic: diagnosticSchema.optional(),
}).strict();

export const clientResourceResolutionReceiptSchema = z.object({
  resolutionId: identifierSchema,
  requestId: identifierSchema,
  resourceId: identifierSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  contentHash: hashSchema,
  status: z.enum(["resolved", "expired", "denied", "invalid", "unavailable"]),
  evidenceIds: z.array(identifierSchema).optional(),
  diagnostic: diagnosticSchema.optional(),
}).strict();

export const clientArtifactEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: runtimeSnapshotSchema }).strict(),
  z.object({
    type: z.literal("draft-preview"),
    transactionId: identifierSchema,
    parentRevisionIds: z.array(identifierSchema),
    previewSeq: z.number().int().nonnegative(),
    operations: z.array(draftOperationSchema),
    unresolvedIds: z.array(identifierSchema),
  }).strict(),
  z.object({ type: z.literal("ack"), requestId: identifierSchema.optional(), transactionId: identifierSchema.optional(), acceptedThroughSeq: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("reject"), requestId: identifierSchema.optional(), transactionId: identifierSchema.optional(), rejectedOpId: identifierSchema.optional(), diagnostics: z.array(diagnosticSchema).min(1) }).strict(),
  z.object({ type: z.literal("transaction-aborted"), transactionId: identifierSchema, lastGoodRevisionId: identifierSchema.optional(), diagnostics: z.array(diagnosticSchema) }).strict(),
  z.object({ type: z.literal("committed"), transactionId: identifierSchema, snapshot: runtimeSnapshotSchema }).strict(),
  z.object({ type: z.literal("state-updated"), record: stateRecordSchema, receipt: clientStateTransitionReceiptSchema }).strict(),
  z.object({ type: z.literal("action-updated"), action: clientActionInvocationSummarySchema }).strict(),
  z.object({ type: z.literal("action-cancellation"), receipt: actionCancellationReceiptSchema }).strict(),
  z.object({ type: z.literal("effect-updated"), effect: clientEffectSummarySchema }).strict(),
  z.object({ type: z.literal("approval-checkpoint"), checkpoint: clientApprovalCheckpointSchema }).strict(),
  z.object({ type: z.literal("effect-receipt"), receipt: clientEffectReceiptSchema }).strict(),
  z.object({ type: z.literal("effect-cancellation"), receipt: effectCancellationReceiptSchema }).strict(),
  z.object({ type: z.literal("resource-receipt"), receipt: clientResourceResolutionReceiptSchema }).strict(),
]);

export const clientArtifactEventSchema = z.object({
  streamProtocol: z.literal(STREAM_PROTOCOL),
  streamId: identifierSchema,
  seq: z.number().int().nonnegative(),
  eventId: identifierSchema,
  cursor: identifierSchema,
  contractFingerprint: hashSchema,
  payload: clientArtifactEventPayloadSchema,
}).strict();

export const clientArtifactCommandPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resume"), requestId: identifierSchema, cursor: identifierSchema }).strict(),
  z.object({ type: z.literal("state-write"), requestId: identifierSchema, documentId: identifierSchema, branchId: identifierSchema, revisionId: identifierSchema, stateId: identifierSchema, expectedSchemaHash: hashSchema, expectedPolicyHash: hashSchema, expectedStateRevision: identifierSchema, value: jsonValueSchema }).strict(),
  z.object({ type: z.literal("action-trigger"), requestId: identifierSchema, documentId: identifierSchema, branchId: identifierSchema, revisionId: identifierSchema, headToken: identifierSchema, nodeId: identifierSchema, port: identifierSchema, payload: jsonValueSchema, statePreconditions: z.record(identifierSchema, identifierSchema) }).strict(),
  z.object({ type: z.literal("resource-resolve"), requestId: identifierSchema, documentId: identifierSchema, branchId: identifierSchema, revisionId: identifierSchema, resourceId: identifierSchema, expectedSchemaHash: hashSchema, expectedContentHash: hashSchema }).strict(),
  z.object({ type: z.literal("approval-response"), requestId: identifierSchema, checkpointId: identifierSchema, effectRequestId: identifierSchema, decision: z.enum(["approve", "reject"]) }).strict(),
  z.object({ type: z.literal("cancel-transaction"), requestId: identifierSchema, transactionId: identifierSchema }).strict(),
  z.object({ type: z.literal("cancel-action"), requestId: identifierSchema, invocationId: identifierSchema }).strict(),
  z.object({ type: z.literal("cancel-effect"), requestId: identifierSchema, effectRequestId: identifierSchema }).strict(),
]);

export const clientArtifactCommandSchema = z.object({
  streamProtocol: z.literal(STREAM_PROTOCOL),
  streamId: identifierSchema,
  contractFingerprint: hashSchema,
  payload: clientArtifactCommandPayloadSchema,
}).strict();

export const clientResourceBindingSchema = z.object({
  resolutionId: identifierSchema,
  requestId: identifierSchema,
  resourceId: identifierSchema,
  schemaVersion: z.number().int().positive(),
  schemaHash: hashSchema,
  codec: z.object({ id: identifierSchema, version: versionStringSchema }).strict(),
  mediaType: z.string(),
  contentHash: hashSchema,
  value: jsonValueSchema,
  byteLength: z.number().int().nonnegative(),
  sensitivity: z.enum(["public", "private", "sensitive"]),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

const clientResourceEnvelopeBase = {
  resourceProtocol: z.literal(RESOURCE_PROTOCOL),
  requestId: identifierSchema,
  contractFingerprint: hashSchema,
  documentId: identifierSchema,
  branchId: identifierSchema,
  revisionId: identifierSchema,
  resourceId: identifierSchema,
};

export const clientResourceDataEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...clientResourceEnvelopeBase, type: z.literal("resource-data"), binding: clientResourceBindingSchema }).strict(),
  z.object({
    ...clientResourceEnvelopeBase,
    type: z.literal("resource-unavailable"),
    resolutionId: identifierSchema.optional(),
    reason: z.enum(["expired", "denied", "unavailable"]),
    retryable: z.boolean(),
  }).strict(),
]);

export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;
export type InformationFlowLabel = z.infer<typeof informationFlowLabelSchema>;
export type DocumentPolicy = z.infer<typeof documentPolicySchema>;
export type StatePolicy = z.infer<typeof statePolicySchema>;
export type StateDefinition = z.infer<typeof stateDefinitionSchema>;
export type StateRecord = z.infer<typeof stateRecordSchema>;
export type StateMigrationReceipt = z.infer<typeof stateMigrationReceiptSchema>;
export type StateTransitionReceipt = z.infer<typeof stateTransitionReceiptSchema>;
export type ClientStateTransitionReceipt = z.infer<typeof clientStateTransitionReceiptSchema>;
export type ActionStep = z.infer<typeof actionStepSchema>;
export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type ArtifactNode = z.infer<typeof artifactNodeSchema>;
export type ResourceReference = z.infer<typeof resourceReferenceSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type ClaimBinding = z.infer<typeof claimBindingSchema>;
export type RevisionIdentity = z.infer<typeof revisionIdentitySchema>;
export type ArtifactDocument = z.infer<typeof artifactDocumentSchema>;
export type ArtifactSemanticContent = z.infer<typeof artifactSemanticContentSchema>;
export type BranchHeadPrecondition = z.infer<typeof branchHeadPreconditionSchema>;
export type ProposalTarget = z.infer<typeof proposalTargetSchema>;
export type ProposalContext = z.infer<typeof proposalContextSchema>;
export type DraftOperation = z.infer<typeof draftOperationSchema>;
export type CommitCommand = z.infer<typeof commitCommandSchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type MigrationReceipt = z.infer<typeof migrationReceiptSchema>;
export type ProtocolLimits = z.infer<typeof protocolLimitsSchema>;
export type CatalogCompatibilityManifest = z.infer<typeof catalogCompatibilityManifestSchema>;
export type CompatibilityOffer = z.infer<typeof compatibilityOfferSchema>;
export type CompatibilitySelection = z.infer<typeof compatibilitySelectionSchema>;
export type BootstrapHello = z.infer<typeof bootstrapHelloSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type ClientActionInvocationSummary = z.infer<typeof clientActionInvocationSummarySchema>;
export type ClientEffectSummary = z.infer<typeof clientEffectSummarySchema>;
export type ClientApprovalCheckpoint = z.infer<typeof clientApprovalCheckpointSchema>;
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;
export type ClientArtifactEventPayload = z.infer<typeof clientArtifactEventPayloadSchema>;
export type ClientArtifactEvent = z.infer<typeof clientArtifactEventSchema>;
export type ClientArtifactCommand = z.infer<typeof clientArtifactCommandSchema>;
export type ClientResourceBinding = z.infer<typeof clientResourceBindingSchema>;
export type ClientResourceResolutionReceipt = z.infer<typeof clientResourceResolutionReceiptSchema>;
export type ClientResourceDataEnvelope = z.infer<typeof clientResourceDataEnvelopeSchema>;
