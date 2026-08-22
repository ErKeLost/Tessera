import { z } from "zod";
import { brandedStringSchema, type BrandedString } from "./brand";
import { FORBIDDEN_OBJECT_KEYS } from "./constants";

const opaqueIdBaseSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, "ID must use portable ASCII identifier characters.")
  .refine((value) => !FORBIDDEN_OBJECT_KEYS.has(value), "Reserved object key cannot be used as an ID.");

const localIdBaseSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Proposal-local ID must not contain namespace separators.")
  .refine((value) => !FORBIDDEN_OBJECT_KEYS.has(value), "Reserved object key cannot be used as an ID.");

const slugBaseSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, "Expected a lowercase portable slug.");

const qualifiedTypeBaseSchema = z.string()
  .min(3)
  .max(192)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
    "Expected a dot-qualified lowercase type such as layout.stack.",
  );

function opaqueId<TName extends string>() {
  return brandedStringSchema<TName>(opaqueIdBaseSchema);
}

function proposalLocalId<TName extends string>() {
  return brandedStringSchema<TName>(localIdBaseSchema);
}

export type DocumentId = BrandedString<"DocumentId">;
export const documentIdSchema = opaqueId<"DocumentId">();
export type RevisionId = BrandedString<"RevisionId">;
export const revisionIdSchema = opaqueId<"RevisionId">();
export type BranchId = BrandedString<"BranchId">;
export const branchIdSchema = opaqueId<"BranchId">();
export type HeadToken = BrandedString<"HeadToken">;
export const headTokenSchema = opaqueId<"HeadToken">();

export type NodeId = BrandedString<"NodeId">;
export const nodeIdSchema = opaqueId<"NodeId">();
export type StateId = BrandedString<"StateId">;
export const stateIdSchema = opaqueId<"StateId">();
export type ActionId = BrandedString<"ActionId">;
export const actionIdSchema = opaqueId<"ActionId">();
export type ResourceBindingId = BrandedString<"ResourceBindingId">;
export const resourceBindingIdSchema = opaqueId<"ResourceBindingId">();
export type EvidenceId = BrandedString<"EvidenceId">;
export const evidenceIdSchema = opaqueId<"EvidenceId">();
export type ClaimId = BrandedString<"ClaimId">;
export const claimIdSchema = opaqueId<"ClaimId">();
export type EntityRevisionId = BrandedString<"EntityRevisionId">;
export const entityRevisionIdSchema = opaqueId<"EntityRevisionId">();

export type TransactionId = BrandedString<"TransactionId">;
export const transactionIdSchema = opaqueId<"TransactionId">();
export type OperationId = BrandedString<"OperationId">;
export const operationIdSchema = opaqueId<"OperationId">();
export type ProposalMessageId = BrandedString<"ProposalMessageId">;
export const proposalMessageIdSchema = opaqueId<"ProposalMessageId">();
export type SurfaceSessionId = BrandedString<"SurfaceSessionId">;
export const surfaceSessionIdSchema = opaqueId<"SurfaceSessionId">();
export type StreamId = BrandedString<"StreamId">;
export const streamIdSchema = opaqueId<"StreamId">();
export type EventId = BrandedString<"EventId">;
export const eventIdSchema = opaqueId<"EventId">();
export type ResumeCursor = BrandedString<"ResumeCursor">;
export const resumeCursorSchema = brandedStringSchema<"ResumeCursor">(
  z.string().min(16).max(4096).regex(/^[A-Za-z0-9._~-]+$/, "Resume cursor must be opaque URL-safe data."),
);
export type RequestId = BrandedString<"RequestId">;
export const requestIdSchema = opaqueId<"RequestId">();
export type IdempotencyKey = BrandedString<"IdempotencyKey">;
export const idempotencyKeySchema = brandedStringSchema<"IdempotencyKey">(
  z.string().min(16).max(512).regex(/^[A-Za-z0-9._:@~-]+$/, "Idempotency key must use portable ASCII characters."),
);
export type CorrelationId = BrandedString<"CorrelationId">;
export const correlationIdSchema = opaqueId<"CorrelationId">();
export type CausationId = BrandedString<"CausationId">;
export const causationIdSchema = opaqueId<"CausationId">();

export type ResourceVersionId = BrandedString<"ResourceVersionId">;
export const resourceVersionIdSchema = opaqueId<"ResourceVersionId">();
export type ResourceGrantId = BrandedString<"ResourceGrantId">;
export const resourceGrantIdSchema = opaqueId<"ResourceGrantId">();
export type ResourceSnapshotId = BrandedString<"ResourceSnapshotId">;
export const resourceSnapshotIdSchema = opaqueId<"ResourceSnapshotId">();
export type ResourceSchemaId = BrandedString<"ResourceSchemaId">;
export const resourceSchemaIdSchema = opaqueId<"ResourceSchemaId">();
export type OpaqueHostResourceKey = BrandedString<"OpaqueHostResourceKey">;
export const opaqueHostResourceKeySchema = opaqueId<"OpaqueHostResourceKey">();
export type OpaqueHostEvidenceKey = BrandedString<"OpaqueHostEvidenceKey">;
export const opaqueHostEvidenceKeySchema = opaqueId<"OpaqueHostEvidenceKey">();
export type OpaqueServerCursor = BrandedString<"OpaqueServerCursor">;
export const opaqueServerCursorSchema = brandedStringSchema<"OpaqueServerCursor">(
  z.string().min(16).max(4096).regex(/^[A-Za-z0-9._~-]+$/, "Server cursor must be opaque URL-safe data."),
);
export type ColumnId = BrandedString<"ColumnId">;
export const columnIdSchema = opaqueId<"ColumnId">();
export type AssetId = BrandedString<"AssetId">;
export const assetIdSchema = opaqueId<"AssetId">();

export type ActionInvocationId = BrandedString<"ActionInvocationId">;
export const actionInvocationIdSchema = opaqueId<"ActionInvocationId">();
export type EffectReceiptId = BrandedString<"EffectReceiptId">;
export const effectReceiptIdSchema = opaqueId<"EffectReceiptId">();
export type StateRevisionId = BrandedString<"StateRevisionId">;
export const stateRevisionIdSchema = opaqueId<"StateRevisionId">();
export type SingleUseApprovalToken = BrandedString<"SingleUseApprovalToken">;
export const singleUseApprovalTokenSchema = brandedStringSchema<"SingleUseApprovalToken">(
  z.string().min(32).max(4096).regex(/^[A-Za-z0-9._~-]+$/, "Approval token must be opaque URL-safe data."),
);
export type MigrationReceiptId = BrandedString<"MigrationReceiptId">;
export const migrationReceiptIdSchema = opaqueId<"MigrationReceiptId">();
export type ActorAuditRef = BrandedString<"ActorAuditRef">;
export const actorAuditRefSchema = opaqueId<"ActorAuditRef">();

export type SliceComponentId = BrandedString<"SliceComponentId">;
export const sliceComponentIdSchema = proposalLocalId<"SliceComponentId">();
export type SliceActionId = BrandedString<"SliceActionId">;
export const sliceActionIdSchema = proposalLocalId<"SliceActionId">();
export type SliceResourceId = BrandedString<"SliceResourceId">;
export const sliceResourceIdSchema = proposalLocalId<"SliceResourceId">();
export type SliceEvidenceId = BrandedString<"SliceEvidenceId">;
export const sliceEvidenceIdSchema = proposalLocalId<"SliceEvidenceId">();
export type SignatureRef = BrandedString<"SignatureRef">;
export const signatureRefSchema = opaqueId<"SignatureRef">();
export type PublisherId = BrandedString<"PublisherId">;
export const publisherIdSchema = brandedStringSchema<"PublisherId">(slugBaseSchema);
export type CatalogId = BrandedString<"CatalogId">;
export const catalogIdSchema = brandedStringSchema<"CatalogId">(slugBaseSchema);
export type CatalogRevision = BrandedString<"CatalogRevision">;
export const catalogRevisionSchema = opaqueId<"CatalogRevision">();
export type ComponentType = BrandedString<"ComponentType">;
export const componentTypeSchema = brandedStringSchema<"ComponentType">(qualifiedTypeBaseSchema);
export type ActionType = BrandedString<"ActionType">;
export const actionTypeSchema = brandedStringSchema<"ActionType">(qualifiedTypeBaseSchema);
export type EventPort = BrandedString<"EventPort">;
export const eventPortSchema = brandedStringSchema<"EventPort">(
  z.string().min(1).max(128).regex(/^[a-z][a-zA-Z0-9]*$/, "Expected a lower-camel-case event port."),
);
export type PlacementId = BrandedString<"PlacementId">;
export const placementIdSchema = opaqueId<"PlacementId">();
export type CapabilityId = BrandedString<"CapabilityId">;
export const capabilityIdSchema = opaqueId<"CapabilityId">();
export type CompensationPolicyRef = BrandedString<"CompensationPolicyRef">;
export const compensationPolicyRefSchema = opaqueId<"CompensationPolicyRef">();

export const proposalEntityKinds = ["node", "state", "action", "resource", "evidence", "claim"] as const;
export const proposalEntityKindSchema = z.enum(proposalEntityKinds);
export type ProposalEntityKind = z.infer<typeof proposalEntityKindSchema>;

export type ProposalLocalId<TKind extends ProposalEntityKind> = BrandedString<`ProposalLocalId:${TKind}`>;

export const proposalLocalIdSchemas = Object.freeze({
  node: proposalLocalId<"ProposalLocalId:node">(),
  state: proposalLocalId<"ProposalLocalId:state">(),
  action: proposalLocalId<"ProposalLocalId:action">(),
  resource: proposalLocalId<"ProposalLocalId:resource">(),
  evidence: proposalLocalId<"ProposalLocalId:evidence">(),
  claim: proposalLocalId<"ProposalLocalId:claim">(),
});
