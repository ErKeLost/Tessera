import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_COMMIT_PROTOCOL,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  commitCommandEnvelopeSchema,
  hashCanonical,
  hostCommandEnvelopeSchema,
  proposalStreamEnvelopeSchema,
  surfaceEventEnvelopeSchema,
  verifyCommitCommandEnvelope,
  verifyHostCommandEnvelope,
  verifyProposalStreamEnvelope,
  verifySurfaceEventEnvelope,
} from "./index";
import { testHash } from "./test-fixtures";

describe("directional wire protocols", () => {
  test("accepts and verifies each direction with its own hash domain", async () => {
    const proposalPayload = { type: "abort", reason: "cancelled" } as const;
    const proposal = proposalStreamEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      transactionId: "tx-1",
      catalogSliceHash: testHash("1"),
      sequence: 1,
      messageId: "message-1",
      payloadHash: await hashCanonical(HASH_DOMAINS.proposalStreamPayload, proposalPayload),
      payload: proposalPayload,
    });
    expect(await verifyProposalStreamEnvelope(proposal)).toBe(true);

    const commitPayload = { type: "abort", transactionId: "tx-1", reason: "cancelled" } as const;
    const commit = commitCommandEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_COMMIT_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      commandId: "command-1",
      correlationId: "correlation-1",
      payloadHash: await hashCanonical(HASH_DOMAINS.commitCommandPayload, commitPayload),
      payload: commitPayload,
    });
    expect(await verifyCommitCommandEnvelope(commit)).toBe(true);

    const hostPayload = {
      type: "ack",
      ack: {
        acknowledgedThrough: 1,
        eventId: "event-1",
        cursor: "cursor-opaque-0001",
      },
    } as const;
    const command = hostCommandEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-1",
      streamId: "stream-1",
      epoch: 1,
      commandId: "command-2",
      correlationId: "correlation-1",
      payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, hostPayload),
      payload: hostPayload,
    });
    expect(await verifyHostCommandEnvelope(command)).toBe(true);

    const surfacePayload = {
      type: "rejected",
      transactionId: "tx-1",
      diagnostics: [{
        phase: "validate",
        code: "validate.node-invalid",
        severity: "error",
        recoverable: true,
        modelCorrectable: true,
        message: "Node is invalid.",
      }],
    } as const;
    const event = surfaceEventEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-1",
      streamId: "stream-1",
      epoch: 1,
      sequence: 1,
      eventId: "event-1",
      cursor: "cursor-opaque-0001",
      committedRevisionId: "revision-1",
      audienceBindingHash: testHash("2"),
      contractSetHash: testHash("3"),
      correlationId: "correlation-1",
      payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, surfacePayload),
      payload: surfacePayload,
    });
    expect(await verifySurfaceEventEnvelope(event)).toBe(true);

    expect(surfaceEventEnvelopeSchema.safeParse(command).success).toBe(false);
    expect(hostCommandEnvelopeSchema.safeParse(event).success).toBe(false);
    expect(proposalStreamEnvelopeSchema.safeParse(commit).success).toBe(false);
    expect(commitCommandEnvelopeSchema.safeParse(proposal).success).toBe(false);
  });

  test("detects payload tampering without trusting the envelope", async () => {
    const payload = {
      type: "ack",
      ack: { acknowledgedThrough: 1, eventId: "event-1", cursor: "cursor-opaque-0001" },
    } as const;
    const command = hostCommandEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-1",
      streamId: "stream-1",
      epoch: 1,
      commandId: "command-1",
      correlationId: "correlation-1",
      payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, payload),
      payload,
    });
    const tampered = hostCommandEnvelopeSchema.parse({
      ...command,
      payload: { ...command.payload, ack: { ...payload.ack, acknowledgedThrough: 2 } },
    });
    expect(await verifyHostCommandEnvelope(tampered)).toBe(false);
  });

  test("requires complete entity events and complete atomic revision commits", () => {
    expect(surfaceEventEnvelopeSchema.safeParse({
      protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-1",
      streamId: "stream-1",
      epoch: 1,
      sequence: 1,
      eventId: "event-1",
      cursor: "cursor-opaque-0001",
      committedRevisionId: "revision-1",
      audienceBindingHash: testHash("2"),
      contractSetHash: testHash("3"),
      correlationId: "correlation-1",
      payloadHash: testHash("4"),
      payload: {
        type: "revision-committed",
        transactionId: "tx-1",
        previousRevisionId: "revision-1",
      },
    }).success).toBe(false);
  });
});
