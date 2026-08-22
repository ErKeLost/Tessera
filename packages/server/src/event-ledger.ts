import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  eventIdSchema,
  hashCanonical,
  resumeCursorSchema,
  streamIdSchema,
  surfaceEventEnvelopeSchema,
  surfaceEventPayloadSchema,
  surfaceSessionIdSchema,
  type CorrelationId,
  type HashProvider,
  type ResumeCursor,
  type RevisionId,
  type Sha256Hash,
  type StreamId,
  type SurfaceEventEnvelope,
  type SurfaceEventPayload,
  type SurfaceSessionId,
} from "@open-generative/protocol";
import { z } from "zod";

const surfaceResumeClaimsSchema = z.object({
  surfaceSessionId: surfaceSessionIdSchema,
  streamId: streamIdSchema,
  epoch: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  audienceBindingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export type SurfaceResumeClaims = z.infer<typeof surfaceResumeClaimsSchema>;

export interface SurfaceResumeCursorCodec {
  encode(claims: SurfaceResumeClaims): ResumeCursor;
  decode(cursor: ResumeCursor): SurfaceResumeClaims;
}

export class EncryptedSurfaceResumeCursorCodec implements SurfaceResumeCursorCodec {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new TypeError("Surface cursor encryption key must be 32 bytes.");
    this.#key = new Uint8Array(key);
  }

  encode(claimsInput: SurfaceResumeClaims): ResumeCursor {
    const claims = surfaceResumeClaimsSchema.parse(claimsInput);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from("open-generative.surface-resume.v1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(claims), "utf8")),
      cipher.final(),
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
    return resumeCursorSchema.parse(`v1.${payload}`);
  }

  decode(cursorInput: ResumeCursor): SurfaceResumeClaims {
    const cursor = resumeCursorSchema.parse(cursorInput);
    const [version, encoded, extra] = cursor.split(".");
    if (version !== "v1" || !encoded || extra !== undefined) throw new SurfaceResumeError("resume.invalid-cursor", "Resume cursor format is invalid.");
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.byteLength < 29) throw new Error("Cursor is truncated.");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from("open-generative.surface-resume.v1", "utf8"));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      return surfaceResumeClaimsSchema.parse(JSON.parse(plaintext.toString("utf8")));
    } catch {
      throw new SurfaceResumeError("resume.invalid-cursor", "Resume cursor authentication failed.");
    }
  }
}

export interface SurfaceEventStore {
  append(streamId: StreamId, expectedSequence: number, event: SurfaceEventEnvelope): Promise<"appended" | "conflict">;
  listAfter(streamId: StreamId, epoch: number, sequence: number): Promise<readonly SurfaceEventEnvelope[]>;
  earliestSequence(streamId: StreamId, epoch: number): Promise<number | undefined>;
  latestSequence(streamId: StreamId, epoch: number): Promise<number>;
}

export class InMemorySurfaceEventStore implements SurfaceEventStore {
  readonly #events = new Map<string, SurfaceEventEnvelope[]>();

  constructor(readonly maxRetainedEvents = 2_000) {
    if (!Number.isInteger(maxRetainedEvents) || maxRetainedEvents < 1) throw new TypeError("maxRetainedEvents must be positive.");
  }

  async append(streamId: StreamId, expectedSequence: number, event: SurfaceEventEnvelope) {
    const key = streamKey(streamId, event.epoch);
    const events = this.#events.get(key) ?? [];
    const latest = events.at(-1)?.sequence ?? 0;
    if (latest !== expectedSequence - 1 || event.sequence !== expectedSequence) return "conflict" as const;
    events.push(structuredClone(event));
    if (events.length > this.maxRetainedEvents) events.splice(0, events.length - this.maxRetainedEvents);
    this.#events.set(key, events);
    return "appended" as const;
  }

  async listAfter(streamId: StreamId, epoch: number, sequence: number) {
    return structuredClone((this.#events.get(streamKey(streamId, epoch)) ?? []).filter((event) => event.sequence > sequence));
  }

  async earliestSequence(streamId: StreamId, epoch: number) {
    return this.#events.get(streamKey(streamId, epoch))?.at(0)?.sequence;
  }

  async latestSequence(streamId: StreamId, epoch: number) {
    return this.#events.get(streamKey(streamId, epoch))?.at(-1)?.sequence ?? 0;
  }
}

export type AppendSurfaceEventInput = Readonly<{
  surfaceSessionId: SurfaceSessionId;
  streamId: StreamId;
  epoch: number;
  committedRevisionId: RevisionId;
  audienceBindingHash: Sha256Hash;
  contractSetHash: Sha256Hash;
  correlationId: CorrelationId;
  causationId?: string;
  payload: SurfaceEventPayload;
  cursorExpiresAt: string;
}>;

export type SurfaceResumeResult =
  | Readonly<{ status: "events"; events: readonly SurfaceEventEnvelope[] }>
  | Readonly<{ status: "snapshot-required"; reason: "invalid-cursor" | "expired" | "scope-mismatch" | "epoch-changed" | "retention-gap" }>;

export class SurfaceEventLedger {
  readonly #store: SurfaceEventStore;
  readonly #factory: SurfaceEventFactory;

  constructor(input: Readonly<{
    store: SurfaceEventStore;
    cursors: SurfaceResumeCursorCodec;
    hashProvider?: HashProvider;
    eventIdFactory?: () => string;
  }>) {
    this.#store = input.store;
    this.#factory = new SurfaceEventFactory(input);
  }

  async append(input: AppendSurfaceEventInput): Promise<SurfaceEventEnvelope> {
    const payload = surfaceEventPayloadSchema.parse(input.payload);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sequence = (await this.#store.latestSequence(input.streamId, input.epoch)) + 1;
      const envelope = await this.#factory.create({ ...input, payload }, sequence);
      if (await this.#store.append(input.streamId, sequence, envelope) === "appended") return envelope;
    }
    throw new Error("Surface event append contention exceeded the retry budget.");
  }

  async resume(input: Readonly<{
    cursor: ResumeCursor;
    surfaceSessionId: SurfaceSessionId;
    streamId: StreamId;
    epoch: number;
    audienceBindingHash: Sha256Hash;
    now: Date;
  }>): Promise<SurfaceResumeResult> {
    let claims: SurfaceResumeClaims;
    try {
      claims = this.#factory.decodeCursor(input.cursor);
    } catch {
      return { status: "snapshot-required", reason: "invalid-cursor" };
    }
    if (Date.parse(claims.expiresAt) <= input.now.getTime()) return { status: "snapshot-required", reason: "expired" };
    if (claims.epoch !== input.epoch) return { status: "snapshot-required", reason: "epoch-changed" };
    if (
      claims.surfaceSessionId !== input.surfaceSessionId
      || claims.streamId !== input.streamId
      || claims.audienceBindingHash !== input.audienceBindingHash
    ) return { status: "snapshot-required", reason: "scope-mismatch" };
    const earliest = await this.#store.earliestSequence(input.streamId, input.epoch);
    if (earliest !== undefined && claims.sequence < earliest - 1) {
      return { status: "snapshot-required", reason: "retention-gap" };
    }
    return { status: "events", events: await this.#store.listAfter(input.streamId, input.epoch, claims.sequence) };
  }
}

export class SurfaceEventFactory {
  readonly #cursors: SurfaceResumeCursorCodec;
  readonly #hashProvider?: HashProvider;
  readonly #eventIdFactory: () => string;

  constructor(input: Readonly<{
    cursors: SurfaceResumeCursorCodec;
    hashProvider?: HashProvider;
    eventIdFactory?: () => string;
  }>) {
    this.#cursors = input.cursors;
    this.#hashProvider = input.hashProvider;
    this.#eventIdFactory = input.eventIdFactory ?? (() => `event:${randomUUID()}`);
  }

  async create(input: AppendSurfaceEventInput, sequence: number): Promise<SurfaceEventEnvelope> {
    const payload = surfaceEventPayloadSchema.parse(input.payload);
    const cursor = this.#cursors.encode({
      surfaceSessionId: input.surfaceSessionId,
      streamId: input.streamId,
      epoch: input.epoch,
      sequence,
      audienceBindingHash: input.audienceBindingHash,
      expiresAt: input.cursorExpiresAt,
    });
    return surfaceEventEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: input.surfaceSessionId,
      streamId: input.streamId,
      epoch: input.epoch,
      sequence,
      eventId: eventIdSchema.parse(this.#eventIdFactory()),
      cursor,
      committedRevisionId: input.committedRevisionId,
      audienceBindingHash: input.audienceBindingHash,
      contractSetHash: input.contractSetHash,
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload, this.#hashProvider),
      payload,
    });
  }

  decodeCursor(cursor: ResumeCursor): SurfaceResumeClaims {
    return this.#cursors.decode(cursor);
  }
}

export class SurfaceResumeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SurfaceResumeError";
  }
}

function streamKey(streamId: StreamId, epoch: number): string {
  return `${streamId}\0${epoch}`;
}
