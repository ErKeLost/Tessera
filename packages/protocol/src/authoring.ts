import { z } from "zod";
import {
  claimIdSchema,
  entityRevisionIdSchema,
  eventPortSchema,
  nodeIdSchema,
  operationIdSchema,
  proposalLocalIdSchemas,
  resourceBindingIdSchema,
  sliceActionIdSchema,
  sliceComponentIdSchema,
  sliceEvidenceIdSchema,
  sliceResourceIdSchema,
  stateIdSchema,
  actionIdSchema,
  evidenceIdSchema,
  type ProposalEntityKind,
  type ProposalLocalId,
} from "./ids";
import { sha256HashSchema } from "./hash";
import {
  jsonPointerSchema,
  jsonScalarSchema,
  jsonSchemaSchema,
  jsonValueSchema,
  pathSchema,
  safeObjectKeySchema,
  type JSONSchema,
  type JsonScalar,
  type JsonValue,
  type PathSegment,
} from "./json";
import { sortSpecSchema } from "./resources";

export type AuthoringEntityRef<TKind extends ProposalEntityKind> =
  | { kind: TKind; localId: ProposalLocalId<TKind> }
  | { kind: TKind; canonicalId: CanonicalIdForKind<TKind> };

type CanonicalIdForKind<TKind extends ProposalEntityKind> =
  TKind extends "node" ? z.infer<typeof nodeIdSchema>
    : TKind extends "state" ? z.infer<typeof stateIdSchema>
      : TKind extends "action" ? z.infer<typeof actionIdSchema>
        : TKind extends "resource" ? z.infer<typeof resourceBindingIdSchema>
          : TKind extends "evidence" ? z.infer<typeof evidenceIdSchema>
            : z.infer<typeof claimIdSchema>;

function authoringEntityRefSchema<
  TKind extends ProposalEntityKind,
  TCanonicalSchema extends z.ZodType,
>(kind: TKind, canonicalIdSchema: TCanonicalSchema) {
  return z.union([
    z.object({ kind: z.literal(kind), localId: proposalLocalIdSchemas[kind] }).strict(),
    z.object({ kind: z.literal(kind), canonicalId: canonicalIdSchema }).strict(),
  ]);
}

export const authoringNodeRefSchema = authoringEntityRefSchema("node", nodeIdSchema);
export const authoringStateRefSchema = authoringEntityRefSchema("state", stateIdSchema);
export const authoringActionRefSchema = authoringEntityRefSchema("action", actionIdSchema);
export const authoringResourceRefSchema = authoringEntityRefSchema("resource", resourceBindingIdSchema);
export const authoringEvidenceRefSchema = authoringEntityRefSchema("evidence", evidenceIdSchema);
export const authoringClaimRefSchema = authoringEntityRefSchema("claim", claimIdSchema);

export type AuthoringValue =
  | JsonScalar
  | AuthoringValue[]
  | { object: Record<string, AuthoringValue> }
  | { ref: "state"; target: AuthoringEntityRef<"state">; path?: PathSegment[] }
  | { ref: "resource"; target: AuthoringEntityRef<"resource">; path?: PathSegment[] }
  | { ref: "event"; port: z.infer<typeof eventPortSchema>; path?: PathSegment[] }
  | { ref: "context"; key: "locale" | "timezone" }
  | { condition: { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not"; args: AuthoringValue[] } };

export const authoringValueSchema: z.ZodType<AuthoringValue> = z.lazy(() => z.union([
  jsonScalarSchema,
  z.array(authoringValueSchema),
  z.object({ object: z.record(safeObjectKeySchema, authoringValueSchema) }).strict(),
  z.object({ ref: z.literal("state"), target: authoringStateRefSchema, path: pathSchema.optional() }).strict(),
  z.object({ ref: z.literal("resource"), target: authoringResourceRefSchema, path: pathSchema.optional() }).strict(),
  z.object({ ref: z.literal("event"), port: eventPortSchema, path: pathSchema.optional() }).strict(),
  z.object({ ref: z.literal("context"), key: z.enum(["locale", "timezone"]) }).strict(),
  z.object({
    condition: z.object({
      op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"]),
      args: z.array(authoringValueSchema).max(16),
    }).strict().superRefine(validateAuthoringConditionArity),
  }).strict(),
]));

export const authoringStateDefinitionSchema = z.object({
  schema: jsonSchemaSchema,
  initial: jsonValueSchema,
}).strict();

export const authoringResourceSelectorSchema = z.object({
  projection: z.array(z.string().min(1).max(256)).max(256).optional(),
  filterState: authoringStateRefSchema.optional(),
  sort: z.array(sortSpecSchema).max(16).optional(),
  windowLimit: z.number().int().positive().max(10_000).optional(),
}).strict();

export const authoringResourceBindingSchema = z.object({
  source: sliceResourceIdSchema,
  selector: authoringResourceSelectorSchema.optional(),
}).strict();

export const authoringEvidenceBindingSchema = z.object({
  source: sliceEvidenceIdSchema,
}).strict();

export const authoringLocalTransitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.set"), state: authoringStateRefSchema, value: authoringValueSchema }).strict(),
  z.object({ type: z.literal("state.reset"), state: authoringStateRefSchema }).strict(),
  z.object({ type: z.literal("node.focus"), node: authoringNodeRefSchema }).strict(),
]);

export const authoringActionDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-transition"),
    transitions: z.array(authoringLocalTransitionSchema).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("host-intent"),
    action: sliceActionIdSchema,
    input: z.record(safeObjectKeySchema, authoringValueSchema),
  }).strict(),
]);

export const authoringClaimBindingSchema = z.object({
  node: authoringNodeRefSchema,
  path: jsonPointerSchema,
  kind: z.enum(["value", "analysis", "recommendation"]),
  evidence: z.array(authoringEvidenceRefSchema).min(1).max(128),
}).strict();

export const authoringDocumentMetaSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  description: z.string().max(4_096).optional(),
  locale: z.string().min(2).max(64).optional(),
  tags: z.array(z.string().min(1).max(128)).max(64),
}).strict();

export type AuthoringSnapshotNode = {
  localId: ProposalLocalId<"node">;
  component: z.infer<typeof sliceComponentIdSchema>;
  props?: Record<string, AuthoringValue>;
  slots?: Record<string, Array<AuthoringSnapshotNode | AuthoringEntityRef<"node">>>;
  events?: Record<string, AuthoringEntityRef<"action">>;
  evidence?: AuthoringEntityRef<"evidence">[];
};

export const authoringSnapshotNodeSchema: z.ZodType<AuthoringSnapshotNode> = z.lazy(() => z.object({
  localId: proposalLocalIdSchemas.node,
  component: sliceComponentIdSchema,
  props: z.record(safeObjectKeySchema, authoringValueSchema).optional(),
  slots: z.record(
    safeObjectKeySchema,
    z.array(z.union([authoringSnapshotNodeSchema, authoringNodeRefSchema])).max(1_000),
  ).optional(),
  events: z.record(safeObjectKeySchema, authoringActionRefSchema).optional(),
  evidence: z.array(authoringEvidenceRefSchema).max(1_000).optional(),
}).strict());

const snapshotStateEntitySchema = z.object({
  localId: proposalLocalIdSchemas.state,
  value: authoringStateDefinitionSchema,
}).strict();
const snapshotActionEntitySchema = z.object({
  localId: proposalLocalIdSchemas.action,
  value: authoringActionDefinitionSchema,
}).strict();
const snapshotResourceEntitySchema = z.object({
  localId: proposalLocalIdSchemas.resource,
  value: authoringResourceBindingSchema,
}).strict();
const snapshotEvidenceEntitySchema = z.object({
  localId: proposalLocalIdSchemas.evidence,
  value: authoringEvidenceBindingSchema,
}).strict();
const snapshotClaimEntitySchema = z.object({
  localId: proposalLocalIdSchemas.claim,
  value: authoringClaimBindingSchema,
}).strict();

export const authoringSnapshotProposalSchema = z.object({
  kind: z.literal("snapshot"),
  root: authoringSnapshotNodeSchema,
  stateDefinitions: z.array(snapshotStateEntitySchema).max(256).default([]),
  actions: z.array(snapshotActionEntitySchema).max(256).default([]),
  resourceBindings: z.array(snapshotResourceEntitySchema).max(256).default([]),
  evidenceBindings: z.array(snapshotEvidenceEntitySchema).max(1_000).default([]),
  claims: z.array(snapshotClaimEntitySchema).max(1_000).default([]),
  meta: authoringDocumentMetaSchema,
}).strict().superRefine((proposal, context) => {
  const nodeIds: string[] = [];
  collectSnapshotNodeIds(proposal.root, nodeIds);
  requireUniqueLocalIds(nodeIds, "node", context, ["root"]);
  requireUniqueLocalIds(proposal.stateDefinitions.map((entity) => entity.localId), "state", context, ["stateDefinitions"]);
  requireUniqueLocalIds(proposal.actions.map((entity) => entity.localId), "action", context, ["actions"]);
  requireUniqueLocalIds(proposal.resourceBindings.map((entity) => entity.localId), "resource", context, ["resourceBindings"]);
  requireUniqueLocalIds(proposal.evidenceBindings.map((entity) => entity.localId), "evidence", context, ["evidenceBindings"]);
  requireUniqueLocalIds(proposal.claims.map((entity) => entity.localId), "claim", context, ["claims"]);
});

export const authoringOperationNodeBodySchema = z.object({
  component: sliceComponentIdSchema,
  props: z.record(safeObjectKeySchema, authoringValueSchema).default({}),
  slots: z.record(safeObjectKeySchema, z.array(authoringNodeRefSchema).max(1_000)).default({}),
  events: z.record(safeObjectKeySchema, authoringActionRefSchema).default({}),
  evidence: z.array(authoringEvidenceRefSchema).max(1_000).default([]),
}).strict();

function authoringCreateTargetSchema<TKind extends ProposalEntityKind>(kind: TKind) {
  return z.object({ kind: z.literal(kind), localId: proposalLocalIdSchemas[kind] }).strict();
}

function authoringUpdateTargetSchema<TKind extends ProposalEntityKind, TSchema extends z.ZodType>(
  kind: TKind,
  canonicalIdSchema: TSchema,
) {
  return z.object({
    kind: z.literal(kind),
    canonicalId: canonicalIdSchema,
    expectedEntityRevision: entityRevisionIdSchema,
  }).strict();
}

function authoringPutTargetSchema<TKind extends ProposalEntityKind, TSchema extends z.ZodType>(
  kind: TKind,
  canonicalIdSchema: TSchema,
) {
  return z.union([
    authoringCreateTargetSchema(kind),
    authoringUpdateTargetSchema(kind, canonicalIdSchema),
  ]);
}

const nodePutTargetSchema = authoringPutTargetSchema("node", nodeIdSchema);
const nodeUpdateTargetSchema = authoringUpdateTargetSchema("node", nodeIdSchema);
const statePutTargetSchema = authoringPutTargetSchema("state", stateIdSchema);
const stateUpdateTargetSchema = authoringUpdateTargetSchema("state", stateIdSchema);
const actionPutTargetSchema = authoringPutTargetSchema("action", actionIdSchema);
const actionUpdateTargetSchema = authoringUpdateTargetSchema("action", actionIdSchema);
const resourcePutTargetSchema = authoringPutTargetSchema("resource", resourceBindingIdSchema);
const resourceUpdateTargetSchema = authoringUpdateTargetSchema("resource", resourceBindingIdSchema);
const evidencePutTargetSchema = authoringPutTargetSchema("evidence", evidenceIdSchema);
const evidenceUpdateTargetSchema = authoringUpdateTargetSchema("evidence", evidenceIdSchema);
const claimPutTargetSchema = authoringPutTargetSchema("claim", claimIdSchema);
const claimUpdateTargetSchema = authoringUpdateTargetSchema("claim", claimIdSchema);

export const authoringProposalOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put-node"), target: nodePutTargetSchema, value: authoringOperationNodeBodySchema }).strict(),
  z.object({ op: z.literal("remove-node"), target: nodeUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("put-state"), target: statePutTargetSchema, value: authoringStateDefinitionSchema }).strict(),
  z.object({ op: z.literal("remove-state"), target: stateUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("put-action"), target: actionPutTargetSchema, value: authoringActionDefinitionSchema }).strict(),
  z.object({ op: z.literal("remove-action"), target: actionUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("put-resource-binding"), target: resourcePutTargetSchema, value: authoringResourceBindingSchema }).strict(),
  z.object({ op: z.literal("remove-resource-binding"), target: resourceUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("put-evidence"), target: evidencePutTargetSchema, value: authoringEvidenceBindingSchema }).strict(),
  z.object({ op: z.literal("remove-evidence"), target: evidenceUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("put-claim"), target: claimPutTargetSchema, value: authoringClaimBindingSchema }).strict(),
  z.object({ op: z.literal("remove-claim"), target: claimUpdateTargetSchema }).strict(),
  z.object({ op: z.literal("set-root"), node: authoringNodeRefSchema, expectedRootId: nodeIdSchema.optional() }).strict(),
  z.object({ op: z.literal("set-meta"), expectedMetaHash: sha256HashSchema.optional(), value: authoringDocumentMetaSchema }).strict(),
]);

export const proposalOperationEnvelopeSchema = z.object({
  operationId: operationIdSchema,
  sequence: z.number().int().positive(),
  dependsOn: z.array(operationIdSchema).max(64),
  payloadHash: sha256HashSchema,
  operation: authoringProposalOperationSchema,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.dependsOn).size !== envelope.dependsOn.length) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "Operation dependencies must be unique." });
  }
  if (envelope.dependsOn.includes(envelope.operationId)) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "Operation cannot depend on itself." });
  }
});

export type AuthoringStateDefinition = z.infer<typeof authoringStateDefinitionSchema>;
export type AuthoringResourceSelector = z.infer<typeof authoringResourceSelectorSchema>;
export type AuthoringResourceBinding = z.infer<typeof authoringResourceBindingSchema>;
export type AuthoringEvidenceBinding = z.infer<typeof authoringEvidenceBindingSchema>;
export type AuthoringLocalTransition = z.infer<typeof authoringLocalTransitionSchema>;
export type AuthoringActionDefinition = z.infer<typeof authoringActionDefinitionSchema>;
export type AuthoringClaimBinding = z.infer<typeof authoringClaimBindingSchema>;
export type AuthoringDocumentMeta = z.infer<typeof authoringDocumentMetaSchema>;
export type AuthoringSnapshotProposal = z.infer<typeof authoringSnapshotProposalSchema>;
export type AuthoringOperationNodeBody = z.infer<typeof authoringOperationNodeBodySchema>;
export type AuthoringProposalOperation = z.infer<typeof authoringProposalOperationSchema>;
export type ProposalOperationEnvelope = z.infer<typeof proposalOperationEnvelopeSchema>;

function validateAuthoringConditionArity(
  condition: { op: string; args: AuthoringValue[] },
  context: z.RefinementCtx,
): void {
  const expected = condition.op === "not" ? 1 : condition.op === "and" || condition.op === "or" ? undefined : 2;
  if (expected !== undefined && condition.args.length !== expected) {
    context.addIssue({ code: "custom", message: `${condition.op} requires exactly ${expected} arguments.` });
  }
  if ((condition.op === "and" || condition.op === "or") && condition.args.length < 2) {
    context.addIssue({ code: "custom", message: `${condition.op} requires at least two arguments.` });
  }
}

function collectSnapshotNodeIds(node: AuthoringSnapshotNode, output: string[]): void {
  output.push(node.localId);
  for (const children of Object.values(node.slots ?? {})) {
    for (const child of children) {
      if ("localId" in child && "component" in child) collectSnapshotNodeIds(child, output);
    }
  }
}

function requireUniqueLocalIds(
  ids: readonly string[],
  kind: ProposalEntityKind,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path, message: `Duplicate ${kind} proposal-local ID.` });
  }
}
