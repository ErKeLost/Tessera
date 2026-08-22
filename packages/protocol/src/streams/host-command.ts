import { z } from "zod";
import {
  actionTriggerRequestSchema,
  approvalDecisionSchema,
  cancelRequestSchema,
} from "../actions";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
} from "../constants";
import {
  causationIdSchema,
  correlationIdSchema,
  eventIdSchema,
  requestIdSchema,
  resumeCursorSchema,
  streamIdSchema,
  surfaceSessionIdSchema,
} from "../ids";
import { hashCanonical, sha256HashSchema, type HashProvider } from "../hash";
import { resourceWindowRequestSchema } from "../resources";
import { stateWriteRequestSchema } from "../state";

export const resumeRequestSchema = z.object({
  requestId: requestIdSchema,
  cursor: resumeCursorSchema,
  acknowledgedThrough: z.number().int().nonnegative(),
}).strict();

export const ackSchema = z.object({
  acknowledgedThrough: z.number().int().positive(),
  eventId: eventIdSchema,
  cursor: resumeCursorSchema,
}).strict();

export const hostCommandPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resume-request"), request: resumeRequestSchema }).strict(),
  z.object({ type: z.literal("state-write-request"), request: stateWriteRequestSchema }).strict(),
  z.object({ type: z.literal("resource-window-request"), request: resourceWindowRequestSchema }).strict(),
  z.object({ type: z.literal("action-trigger-request"), request: actionTriggerRequestSchema }).strict(),
  z.object({ type: z.literal("approval-decision"), decision: approvalDecisionSchema }).strict(),
  z.object({ type: z.literal("cancel-request"), request: cancelRequestSchema }).strict(),
  z.object({ type: z.literal("ack"), ack: ackSchema }).strict(),
]);

export const hostCommandEnvelopeSchema = z.object({
  protocol: z.literal(OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL),
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  surfaceSessionId: surfaceSessionIdSchema,
  streamId: streamIdSchema,
  epoch: z.number().int().nonnegative(),
  commandId: requestIdSchema,
  correlationId: correlationIdSchema,
  causationId: causationIdSchema.optional(),
  payloadHash: sha256HashSchema,
  payload: hostCommandPayloadSchema,
}).strict();

export type ResumeRequest = z.infer<typeof resumeRequestSchema>;
export type Ack = z.infer<typeof ackSchema>;
export type HostCommandPayload = z.infer<typeof hostCommandPayloadSchema>;
export type HostCommandEnvelope = z.infer<typeof hostCommandEnvelopeSchema>;

export async function verifyHostCommandEnvelope(
  input: HostCommandEnvelope,
  provider?: HashProvider,
): Promise<boolean> {
  const envelope = hostCommandEnvelopeSchema.parse(input);
  return await hashCanonical(HASH_DOMAINS.hostCommandPayload, envelope.payload, provider) === envelope.payloadHash;
}
