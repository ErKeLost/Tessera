import { z } from "zod";
import {
  actionIdSchema,
  actionInvocationIdSchema,
  actionTypeSchema,
  effectReceiptIdSchema,
  eventPortSchema,
  idempotencyKeySchema,
  nodeIdSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  singleUseApprovalTokenSchema,
  stateIdSchema,
  stateRevisionIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
} from "./ids";
import { sha256HashSchema } from "./hash";
import { isoTimestampSchema, jsonValueSchema, safeObjectKeySchema } from "./json";
import { actionContractRefSchema } from "./refs";
import { valueExprSchema } from "./value-expr";

export const surfaceLocalTransitionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state.set"), stateId: stateIdSchema, value: valueExprSchema }).strict(),
  z.object({ type: z.literal("state.reset"), stateId: stateIdSchema }).strict(),
  z.object({ type: z.literal("node.focus"), nodeId: nodeIdSchema }).strict(),
]);

export const actionDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-transition"),
    transitions: z.array(surfaceLocalTransitionSchema).min(1).max(32),
  }).strict(),
  z.object({
    kind: z.literal("host-intent"),
    contract: actionContractRefSchema,
    input: z.record(safeObjectKeySchema, valueExprSchema),
  }).strict(),
]);

export const actionTriggerRequestSchema = z.object({
  requestId: requestIdSchema,
  idempotencyKey: idempotencyKeySchema,
  surfaceSessionId: surfaceSessionIdSchema,
  revisionId: revisionIdSchema,
  nodeId: nodeIdSchema,
  eventPort: eventPortSchema,
  eventPayload: jsonValueSchema,
  statePreconditions: z.record(stateIdSchema, stateRevisionIdSchema),
  resourcePreconditions: z.record(resourceBindingIdSchema, resourceVersionIdSchema),
}).strict();

export const approvalRequestedSchema = z.object({
  approvalToken: singleUseApprovalTokenSchema,
  expiresAt: isoTimestampSchema,
  actorBindingHash: sha256HashSchema,
  tenantBindingHash: sha256HashSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  actionContract: actionContractRefSchema,
  revisionId: revisionIdSchema,
  normalizedInputHash: sha256HashSchema,
  effectSummaryHash: sha256HashSchema,
  statePreconditions: z.record(stateIdSchema, stateRevisionIdSchema),
  resourcePreconditions: z.record(resourceBindingIdSchema, resourceVersionIdSchema),
}).strict();

export const approvalDecisionSchema = z.object({
  requestId: requestIdSchema,
  approvalToken: singleUseApprovalTokenSchema,
  decision: z.enum(["approve", "reject"]),
}).strict();

export const actionInvocationStatusSchema = z.enum([
  "accepted",
  "awaiting-approval",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cancellation-denied",
]);

export const actionAcceptedSchema = z.object({
  requestId: requestIdSchema,
  invocationId: actionInvocationIdSchema,
  actionId: actionIdSchema,
  actionContract: actionContractRefSchema,
  normalizedInputHash: sha256HashSchema,
  acceptedAt: isoTimestampSchema,
}).strict();

export const actionStatusSchema = z.object({
  invocationId: actionInvocationIdSchema,
  status: actionInvocationStatusSchema,
  updatedAt: isoTimestampSchema,
  code: z.string().min(1).max(192).optional(),
  retryable: z.boolean().optional(),
}).strict();

const effectOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    receipt: jsonValueSchema,
    result: jsonValueSchema.optional(),
    resultHash: sha256HashSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    errorCode: z.string().min(1).max(192),
    retryable: z.boolean(),
  }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);

export const effectReceiptSchema = z.object({
  receiptId: effectReceiptIdSchema,
  invocationId: actionInvocationIdSchema,
  actionContract: actionContractRefSchema,
  idempotencyKeyHash: sha256HashSchema,
  normalizedInputHash: sha256HashSchema,
  effectSummaryHash: sha256HashSchema,
  outcome: effectOutcomeSchema,
  resultingRevisionId: revisionIdSchema.optional(),
  resultingStateRevisions: z.record(stateIdSchema, stateRevisionIdSchema),
  resultingResourceVersions: z.record(resourceBindingIdSchema, resourceVersionIdSchema),
  startedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema,
}).strict();

export const cancelRequestSchema = z.object({
  requestId: requestIdSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("transaction"), transactionId: transactionIdSchema }).strict(),
    z.object({ kind: z.literal("action"), invocationId: actionInvocationIdSchema }).strict(),
  ]),
}).strict();

export const effectClassSchema = z.enum(["none", "read", "reversible-write", "irreversible-write"]);
export const actionRiskSchema = z.enum(["low", "medium", "high"]);
export const cancellableBoundarySchema = z.enum(["before-execution", "before-effect-commit", "never"]);
export const actionContractTargetSchema = z.object({
  actionType: actionTypeSchema,
}).strict();

export type SurfaceLocalTransition = z.infer<typeof surfaceLocalTransitionSchema>;
export type ActionDefinition = z.infer<typeof actionDefinitionSchema>;
export type ActionTriggerRequest = z.infer<typeof actionTriggerRequestSchema>;
export type ApprovalRequested = z.infer<typeof approvalRequestedSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ActionInvocationStatus = z.infer<typeof actionInvocationStatusSchema>;
export type ActionAccepted = z.infer<typeof actionAcceptedSchema>;
export type ActionStatus = z.infer<typeof actionStatusSchema>;
export type EffectReceipt = z.infer<typeof effectReceiptSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type EffectClass = z.infer<typeof effectClassSchema>;
export type ActionRisk = z.infer<typeof actionRiskSchema>;
export type CancellableBoundary = z.infer<typeof cancellableBoundarySchema>;
