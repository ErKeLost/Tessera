import { z } from "zod";
import { authoringSnapshotProposalSchema, proposalOperationEnvelopeSchema } from "../authoring";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
} from "../constants";
import {
  proposalMessageIdSchema,
  transactionIdSchema,
} from "../ids";
import { hashCanonical, sha256HashSchema, type HashProvider } from "../hash";

export const proposalStreamPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), proposal: authoringSnapshotProposalSchema }).strict(),
  z.object({ type: z.literal("entity-operation"), operation: proposalOperationEnvelopeSchema }).strict(),
  z.object({
    type: z.literal("finish"),
    finalOperationSequence: z.number().int().nonnegative(),
    proposalHash: sha256HashSchema,
  }).strict(),
  z.object({
    type: z.literal("abort"),
    reason: z.enum(["provider-abort", "decoder-failure", "timeout", "cancelled"]),
  }).strict(),
]);

export const proposalStreamEnvelopeSchema = z.object({
  protocol: z.literal(OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL),
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  transactionId: transactionIdSchema,
  catalogSliceHash: sha256HashSchema,
  sequence: z.number().int().positive(),
  messageId: proposalMessageIdSchema,
  payloadHash: sha256HashSchema,
  payload: proposalStreamPayloadSchema,
}).strict();

export type ProposalStreamPayload = z.infer<typeof proposalStreamPayloadSchema>;
export type ProposalStreamEnvelope = z.infer<typeof proposalStreamEnvelopeSchema>;

export async function verifyProposalStreamEnvelope(
  input: ProposalStreamEnvelope,
  provider?: HashProvider,
): Promise<boolean> {
  const envelope = proposalStreamEnvelopeSchema.parse(input);
  return await hashCanonical(HASH_DOMAINS.proposalStreamPayload, envelope.payload, provider) === envelope.payloadHash;
}
