import { z } from "zod";
import {
  actionAcceptedSchema,
  actionStatusSchema,
  approvalRequestedSchema,
  effectReceiptSchema,
} from "../actions";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
} from "../constants";
import { diagnosticSchema } from "../diagnostics";
import { committedRevisionSchema } from "../document";
import {
  actionInvocationIdSchema,
  causationIdSchema,
  correlationIdSchema,
  eventIdSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  resumeCursorSchema,
  revisionIdSchema,
  stateIdSchema,
  streamIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
} from "../ids";
import { hashCanonical, sha256HashSchema, type HashProvider } from "../hash";
import { validatedPreviewSchema } from "../preview";
import { resourceResolutionResultSchema } from "../resources";
import { stateValueSnapshotSchema, stateWriteReceiptSchema } from "../state";

export const streamPolicySchema = z.object({
  maxSequenceGap: z.number().int().nonnegative(),
  maxBufferedBytes: z.number().int().positive(),
  ackEveryEvents: z.number().int().positive(),
  backpressure: z.enum(["pause", "publish-snapshot", "disconnect"]),
  cursorExpiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const surfaceSnapshotSchema = z.object({
  revision: committedRevisionSchema,
  state: z.record(stateIdSchema, stateValueSnapshotSchema),
  resources: z.record(resourceBindingIdSchema, resourceResolutionResultSchema),
  actions: z.record(actionInvocationIdSchema, actionStatusSchema),
  approvals: z.array(approvalRequestedSchema).max(256),
}).strict().superRefine((snapshot, context) => {
  for (const [stateId, state] of Object.entries(snapshot.state)) {
    if (stateId !== state.stateId) context.addIssue({ code: "custom", path: ["state", stateId], message: "State map identity mismatch." });
  }
  for (const [bindingId, result] of Object.entries(snapshot.resources)) {
    const valueBindingId = result.status === "resolved" ? result.snapshot.bindingId : result.unavailable.bindingId;
    if (bindingId !== valueBindingId) context.addIssue({ code: "custom", path: ["resources", bindingId], message: "Resource map identity mismatch." });
  }
  for (const [invocationId, status] of Object.entries(snapshot.actions)) {
    if (invocationId !== status.invocationId) context.addIssue({ code: "custom", path: ["actions", invocationId], message: "Action map identity mismatch." });
  }
});

export const surfaceEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot-published"), snapshot: surfaceSnapshotSchema, streamPolicy: streamPolicySchema }).strict(),
  z.object({ type: z.literal("preview-applied"), preview: validatedPreviewSchema }).strict(),
  z.object({
    type: z.literal("preview-invalidated"),
    transactionId: transactionIdSchema,
    invalidatedOverlayHash: sha256HashSchema.optional(),
    reason: z.enum(["abort", "reject", "conflict", "epoch-change", "timeout"]),
  }).strict(),
  z.object({
    type: z.literal("revision-committed"),
    transactionId: transactionIdSchema,
    previousRevisionId: revisionIdSchema,
    consumedOverlayHash: sha256HashSchema.optional(),
    revision: committedRevisionSchema,
  }).strict(),
  z.object({ type: z.literal("state-changed"), state: stateValueSnapshotSchema, receipt: stateWriteReceiptSchema }).strict(),
  z.object({ type: z.literal("resource-resolved"), requestId: requestIdSchema, result: resourceResolutionResultSchema }).strict(),
  z.object({ type: z.literal("action-accepted"), action: actionAcceptedSchema }).strict(),
  z.object({ type: z.literal("approval-requested"), approval: approvalRequestedSchema }).strict(),
  z.object({ type: z.literal("action-status"), action: actionStatusSchema }).strict(),
  z.object({ type: z.literal("effect-receipt"), receipt: effectReceiptSchema }).strict(),
  z.object({
    type: z.literal("rejected"),
    requestId: requestIdSchema.optional(),
    transactionId: transactionIdSchema.optional(),
    diagnostics: z.array(diagnosticSchema).min(1).max(128),
  }).strict(),
]);

export const surfaceEventEnvelopeSchema = z.object({
  protocol: z.literal(OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL),
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  surfaceSessionId: surfaceSessionIdSchema,
  streamId: streamIdSchema,
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  eventId: eventIdSchema,
  cursor: resumeCursorSchema,
  committedRevisionId: revisionIdSchema,
  audienceBindingHash: sha256HashSchema,
  contractSetHash: sha256HashSchema,
  correlationId: correlationIdSchema,
  causationId: causationIdSchema.optional(),
  payloadHash: sha256HashSchema,
  payload: surfaceEventPayloadSchema,
}).strict();

export type StreamPolicy = z.infer<typeof streamPolicySchema>;
export type SurfaceSnapshot = z.infer<typeof surfaceSnapshotSchema>;
export type SurfaceEventPayload = z.infer<typeof surfaceEventPayloadSchema>;
type SurfaceEventEnvelopeBase = z.infer<typeof surfaceEventEnvelopeSchema>;
export type SurfaceEventEnvelope<TPayload extends SurfaceEventPayload = SurfaceEventPayload> =
  Omit<SurfaceEventEnvelopeBase, "payload"> & { payload: TPayload };

export async function verifySurfaceEventEnvelope(
  input: SurfaceEventEnvelope,
  provider?: HashProvider,
): Promise<boolean> {
  const envelope = surfaceEventEnvelopeSchema.parse(input);
  return await hashCanonical(HASH_DOMAINS.surfaceEventPayload, envelope.payload, provider) === envelope.payloadHash;
}
