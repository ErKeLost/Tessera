import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  correlationIdSchema,
  hashCanonical,
  hostCommandEnvelopeSchema,
  hostCommandPayloadSchema,
  idempotencyKeySchema,
  requestIdSchema,
  type CausationId,
  type CorrelationId,
  type HashProvider,
  type HostCommandEnvelope,
  type HostCommandPayload,
  type IdempotencyKey,
  type RequestId,
  type StreamId,
  type SurfaceSessionId,
} from "@open-generative/protocol";

export interface HostCommandTransport {
  send(command: HostCommandEnvelope): void | Promise<void>;
}

export interface HostCommandIdentityFactory {
  requestId(): RequestId;
  correlationId(): CorrelationId;
  idempotencyKey(): IdempotencyKey;
}

export type HostCommandDispatchOptions = Readonly<{
  requestId?: RequestId;
  correlationId?: CorrelationId;
  causationId?: CausationId;
}>;

export type ActionCommandDispatchOptions = HostCommandDispatchOptions & Readonly<{
  idempotencyKey?: IdempotencyKey;
}>;

export async function createHostCommandEnvelope(input: Readonly<{
  surfaceSessionId: SurfaceSessionId;
  streamId: StreamId;
  epoch: number;
  commandId: RequestId;
  correlationId: CorrelationId;
  causationId?: CausationId;
  payload: HostCommandPayload;
  hashProvider?: HashProvider;
}>): Promise<HostCommandEnvelope> {
  const payload = hostCommandPayloadSchema.parse(input.payload);
  return hostCommandEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: input.surfaceSessionId,
    streamId: input.streamId,
    epoch: input.epoch,
    commandId: input.commandId,
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, payload, input.hashProvider),
    payload,
  });
}

export function createBrowserCommandIdentityFactory(prefix = "client"): HostCommandIdentityFactory {
  const normalizedPrefix = prefix.replace(/[^A-Za-z0-9._:@-]/g, "-") || "client";
  return Object.freeze({
    requestId: () => requestIdSchema.parse(`${normalizedPrefix}:request:${randomId()}`),
    correlationId: () => correlationIdSchema.parse(`${normalizedPrefix}:correlation:${randomId()}`),
    idempotencyKey: () => idempotencyKeySchema.parse(`${normalizedPrefix}:idempotency:${randomId()}`),
  });
}

function randomId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new TypeError("A cryptographic randomUUID implementation is required for command identities.");
  }
  return randomUUID.call(globalThis.crypto);
}
