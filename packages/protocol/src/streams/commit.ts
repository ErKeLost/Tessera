import { z } from "zod";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_COMMIT_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
} from "../constants";
import {
  actorAuditRefSchema,
  branchIdSchema,
  correlationIdSchema,
  documentIdSchema,
  headTokenSchema,
  requestIdSchema,
  revisionIdSchema,
  transactionIdSchema,
} from "../ids";
import { hashCanonical, sha256HashSchema, type HashProvider } from "../hash";
import { canonicalOperationEnvelopeSchema } from "../operations";

export const commitCommandPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("begin"),
    transactionId: transactionIdSchema,
    documentId: documentIdSchema,
    branchId: branchIdSchema,
    baseRevisionId: revisionIdSchema,
    expectedHeadToken: headTokenSchema,
    contractSetHash: sha256HashSchema,
    catalogSliceHash: sha256HashSchema,
    authorityContextHash: sha256HashSchema,
    writeScopeHash: sha256HashSchema,
    createdBy: actorAuditRefSchema,
  }).strict(),
  z.object({
    type: z.literal("apply"),
    operation: canonicalOperationEnvelopeSchema,
  }).strict(),
  z.object({
    type: z.literal("finalize"),
    transactionId: transactionIdSchema,
    finalOperationSequence: z.number().int().nonnegative(),
    expectedOverlayHash: sha256HashSchema.optional(),
    expectedContentHash: sha256HashSchema,
  }).strict(),
  z.object({
    type: z.literal("abort"),
    transactionId: transactionIdSchema,
    reason: z.enum(["rejected", "timeout", "cancelled", "conflict", "internal-error"]),
  }).strict(),
]);

export const commitCommandEnvelopeSchema = z.object({
  protocol: z.literal(OPEN_GENERATIVE_COMMIT_PROTOCOL),
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  commandId: requestIdSchema,
  correlationId: correlationIdSchema,
  payloadHash: sha256HashSchema,
  payload: commitCommandPayloadSchema,
}).strict();

export type CommitCommandPayload = z.infer<typeof commitCommandPayloadSchema>;
export type CommitCommandEnvelope = z.infer<typeof commitCommandEnvelopeSchema>;

export async function verifyCommitCommandEnvelope(
  input: CommitCommandEnvelope,
  provider?: HashProvider,
): Promise<boolean> {
  const envelope = commitCommandEnvelopeSchema.parse(input);
  return await hashCanonical(HASH_DOMAINS.commitCommandPayload, envelope.payload, provider) === envelope.payloadHash;
}
