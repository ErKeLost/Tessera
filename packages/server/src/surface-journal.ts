import {
  canonicalStringify,
  correlationIdSchema,
  hostCommandEnvelopeSchema,
  isoTimestampSchema,
  sha256HashSchema,
  resourceResolutionIdentitySchema,
  surfaceEventPayloadSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  type CausationId,
  type CorrelationId,
  type HostCommandEnvelope,
  type ResumeCursor,
  type Sha256Hash,
  type SurfaceEventEnvelope,
  type SurfaceEventPayload,
  type SurfaceSessionId,
} from "@open-generative/protocol";
import {
  SurfaceEventFactory,
  type SurfaceResumeResult,
  type SurfaceResumeCursorCodec,
} from "./event-ledger";
import type {
  SurfaceCommandReceipt,
  SurfaceSessionRecord,
  VersionedSurfaceSession,
} from "./surface-store";

export type SurfaceEventDraft = Readonly<{
  correlationId: CorrelationId;
  causationId?: CausationId;
  payload: SurfaceEventPayload;
}>;

export type CreateSurfaceJournalResult =
  | Readonly<{ status: "created"; session: VersionedSurfaceSession; event: SurfaceEventEnvelope }>
  | Readonly<{ status: "exists"; session: VersionedSurfaceSession }>;

export type CommitSurfaceJournalResult =
  | Readonly<{ status: "committed"; session: VersionedSurfaceSession; events: readonly SurfaceEventEnvelope[] }>
  | Readonly<{ status: "conflict"; current: VersionedSurfaceSession }>
  | Readonly<{ status: "missing" }>;

export interface SurfaceSessionJournal {
  create(record: SurfaceSessionRecord, initialEvent: SurfaceEventDraft): Promise<CreateSurfaceJournalResult>;
  get(surfaceSessionId: SurfaceSessionId): Promise<VersionedSurfaceSession | undefined>;
  list(input: Readonly<{
    after?: SurfaceSessionId;
    limit: number;
  }>): Promise<VersionedSurfaceSession[]>;
  commit(input: Readonly<{
    surfaceSessionId: SurfaceSessionId;
    expectedVersion: number;
    next: SurfaceSessionRecord;
    events: readonly SurfaceEventDraft[];
    command?: HostCommandEnvelope;
  }>): Promise<CommitSurfaceJournalResult>;
  resume(input: Readonly<{
    cursor: ResumeCursor;
    surfaceSessionId: SurfaceSessionId;
    audienceBindingHash: Sha256Hash;
    now: Date;
  }>): Promise<SurfaceResumeResult>;
  eventsForCommand(command: HostCommandEnvelope): Promise<readonly SurfaceEventEnvelope[] | undefined>;
  acknowledge(command: HostCommandEnvelope): Promise<
    | Readonly<{ status: "acknowledged" | "replayed"; session: VersionedSurfaceSession }>
    | Readonly<{ status: "conflict" | "invalid" | "missing" }>
  >;
}

export class InMemorySurfaceSessionJournal implements SurfaceSessionJournal {
  readonly #sessions = new Map<SurfaceSessionId, VersionedSurfaceSession>();
  readonly #events = new Map<string, SurfaceEventEnvelope[]>();
  readonly #factory: SurfaceEventFactory;
  readonly #maxRetainedEvents: number;

  constructor(input: Readonly<{
    cursors: SurfaceResumeCursorCodec;
    maxRetainedEvents?: number;
    eventIdFactory?: () => string;
  }>) {
    this.#factory = new SurfaceEventFactory({
      cursors: input.cursors,
      eventIdFactory: input.eventIdFactory,
    });
    this.#maxRetainedEvents = input.maxRetainedEvents ?? 2_000;
    if (!Number.isInteger(this.#maxRetainedEvents) || this.#maxRetainedEvents < 1) {
      throw new TypeError("maxRetainedEvents must be positive.");
    }
  }

  async create(
    recordInput: SurfaceSessionRecord,
    initialEventInput: SurfaceEventDraft,
  ): Promise<CreateSurfaceJournalResult> {
    const record = validateRecord(recordInput);
    const existing = this.#sessions.get(record.surfaceSessionId);
    if (existing) return { status: "exists", session: cloneSession(existing) };
    const draft = parseDraft(initialEventInput);
    if (draft.payload.type !== "snapshot-published") {
      throw new TypeError("A Surface session must begin with snapshot-published.");
    }
    assertSnapshotMatchesRecord(record, draft.payload);
    const event = await this.#factory.create(eventInput(record, draft), 1);

    const raced = this.#sessions.get(record.surfaceSessionId);
    if (raced) return { status: "exists", session: cloneSession(raced) };
    const session = { version: 1, value: structuredClone(record) };
    this.#sessions.set(record.surfaceSessionId, session);
    this.#events.set(streamKey(record), [structuredClone(event)]);
    return { status: "created", session: cloneSession(session), event: structuredClone(event) };
  }

  async get(surfaceSessionIdInput: SurfaceSessionId) {
    const surfaceSessionId = surfaceSessionIdSchema.parse(surfaceSessionIdInput);
    const session = this.#sessions.get(surfaceSessionId);
    return session ? cloneSession(session) : undefined;
  }

  async list(input: Readonly<{ after?: SurfaceSessionId; limit: number }>) {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new TypeError("Surface session list limit must be a positive integer.");
    }
    const after = input.after === undefined ? undefined : surfaceSessionIdSchema.parse(input.after);
    return [...this.#sessions.entries()]
      .filter(([surfaceSessionId]) => after === undefined || compareIds(surfaceSessionId, after) > 0)
      .sort(([left], [right]) => compareIds(left, right))
      .slice(0, input.limit)
      .map(([, session]) => cloneSession(session));
  }

  async commit(input: Readonly<{
    surfaceSessionId: SurfaceSessionId;
    expectedVersion: number;
    next: SurfaceSessionRecord;
    events: readonly SurfaceEventDraft[];
    command?: HostCommandEnvelope;
  }>): Promise<CommitSurfaceJournalResult> {
    const surfaceSessionId = surfaceSessionIdSchema.parse(input.surfaceSessionId);
    const current = this.#sessions.get(surfaceSessionId);
    if (!current) return { status: "missing" };
    if (current.version !== input.expectedVersion) return { status: "conflict", current: cloneSession(current) };
    const next = validateRecord(input.next);
    const drafts = input.events.map(parseDraft);
    const command = input.command ? hostCommandEnvelopeSchema.parse(input.command) : undefined;
    const epochChanged = assertCommitSessionIdentity(current.value, next, drafts, command);
    const retained = this.#events.get(streamKey(next)) ?? [];
    if (epochChanged && retained.length > 0) {
      throw new TypeError("A replacement Surface epoch must begin with an empty event lineage.");
    }
    const firstSequence = (retained.at(-1)?.sequence ?? 0) + 1;
    const events = await Promise.all(drafts.map((draft, index) => (
      this.#factory.create(eventInput(next, draft), firstSequence + index)
    )));

    const latest = this.#sessions.get(surfaceSessionId);
    if (!latest) return { status: "missing" };
    if (latest.version !== input.expectedVersion) return { status: "conflict", current: cloneSession(latest) };
    const latestEvents = this.#events.get(streamKey(next)) ?? [];
    if ((latestEvents.at(-1)?.sequence ?? 0) !== firstSequence - 1) {
      return { status: "conflict", current: cloneSession(latest) };
    }

    const committedEvents = [...latestEvents, ...events.map((event) => structuredClone(event))];
    if (committedEvents.length > this.#maxRetainedEvents) {
      committedEvents.splice(0, committedEvents.length - this.#maxRetainedEvents);
    }
    const storedNext = structuredClone(next);
    if (command) {
      const commandRecord = epochChanged ? current.value : storedNext;
      if (
        command.surfaceSessionId !== commandRecord.surfaceSessionId
        || command.streamId !== commandRecord.streamId
        || command.epoch !== commandRecord.epoch
      ) throw new TypeError("Command identity does not match the committed Surface session.");
      const priorReceipt = storedNext.commandReceipts[command.commandId];
      if (priorReceipt && priorReceipt.payloadHash !== command.payloadHash) {
        throw new TypeError("Command ID was reused with a different payload hash.");
      }
      storedNext.commandReceipts[command.commandId] = commandReceipt(command, firstSequence, events.length);
    }
    const session = { version: latest.version + 1, value: storedNext };
    this.#sessions.set(surfaceSessionId, session);
    this.#events.set(streamKey(next), committedEvents);
    return {
      status: "committed",
      session: cloneSession(session),
      events: structuredClone(events),
    };
  }

  async resume(input: Readonly<{
    cursor: ResumeCursor;
    surfaceSessionId: SurfaceSessionId;
    audienceBindingHash: Sha256Hash;
    now: Date;
  }>): Promise<SurfaceResumeResult> {
    const surfaceSessionId = surfaceSessionIdSchema.parse(input.surfaceSessionId);
    const audienceBindingHash = sha256HashSchema.parse(input.audienceBindingHash);
    const session = this.#sessions.get(surfaceSessionId);
    if (!session) return { status: "snapshot-required", reason: "scope-mismatch" };
    let claims;
    try {
      claims = this.#factory.decodeCursor(input.cursor);
    } catch {
      return { status: "snapshot-required", reason: "invalid-cursor" };
    }
    if (Date.parse(claims.expiresAt) <= input.now.getTime()) {
      return { status: "snapshot-required", reason: "expired" };
    }
    if (claims.epoch !== session.value.epoch) {
      return { status: "snapshot-required", reason: "epoch-changed" };
    }
    if (
      claims.surfaceSessionId !== surfaceSessionId
      || claims.streamId !== session.value.streamId
      || claims.audienceBindingHash !== audienceBindingHash
      || audienceBindingHash !== session.value.audienceBindingHash
    ) return { status: "snapshot-required", reason: "scope-mismatch" };
    const events = this.#events.get(streamKey(session.value)) ?? [];
    const earliest = events.at(0)?.sequence;
    if (earliest !== undefined && claims.sequence < earliest - 1) {
      return { status: "snapshot-required", reason: "retention-gap" };
    }
    return {
      status: "events",
      events: structuredClone(events.filter((event) => event.sequence > claims.sequence)),
    };
  }

  async eventsForCommand(commandInput: HostCommandEnvelope) {
    const command = hostCommandEnvelopeSchema.parse(commandInput);
    const session = this.#sessions.get(command.surfaceSessionId);
    if (!session) return undefined;
    const receipt = session.value.commandReceipts[command.commandId];
    if (!receipt || receipt.payloadHash !== command.payloadHash) return undefined;
    const events = this.#events.get(streamKey(session.value)) ?? [];
    if (receipt.firstSequence === 0 && receipt.lastSequence === 0) return [];
    const replay = events.filter((event) => (
      event.sequence >= receipt.firstSequence && event.sequence <= receipt.lastSequence
    ));
    return replay.length === receipt.lastSequence - receipt.firstSequence + 1
      ? structuredClone(replay)
      : undefined;
  }

  async acknowledge(commandInput: HostCommandEnvelope): Promise<
    | Readonly<{ status: "acknowledged" | "replayed"; session: VersionedSurfaceSession }>
    | Readonly<{ status: "conflict" | "invalid" | "missing" }>
  > {
    const command = hostCommandEnvelopeSchema.parse(commandInput);
    if (command.payload.type !== "ack") return { status: "invalid" };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = this.#sessions.get(command.surfaceSessionId);
      if (!current) return { status: "missing" };
      if (
        command.streamId !== current.value.streamId
        || command.epoch !== current.value.epoch
      ) return { status: "invalid" };
      const prior = current.value.commandReceipts[command.commandId];
      if (prior) {
        return prior.payloadHash === command.payloadHash
          ? { status: "replayed", session: cloneSession(current) }
          : { status: "invalid" };
      }
      const ack = command.payload.ack;
      const events = this.#events.get(streamKey(current.value)) ?? [];
      const acknowledgedEvent = events.find((event) => event.sequence === ack.acknowledgedThrough);
      if (
        !acknowledgedEvent
        || acknowledgedEvent.eventId !== ack.eventId
        || acknowledgedEvent.cursor !== ack.cursor
      ) return { status: "invalid" };
      const next = structuredClone(current.value);
      next.acknowledgedThrough = Math.max(next.acknowledgedThrough, ack.acknowledgedThrough);
      next.commandReceipts[command.commandId] = commandReceipt(command, 0, 0);
      const latest = this.#sessions.get(command.surfaceSessionId);
      if (!latest) return { status: "missing" };
      if (latest.version !== current.version) continue;
      const session = { version: current.version + 1, value: next };
      this.#sessions.set(command.surfaceSessionId, session);
      return { status: "acknowledged", session: cloneSession(session) };
    }
    return { status: "conflict" };
  }
}

export function commandReceipt(
  command: HostCommandEnvelope,
  firstSequence: number,
  eventCount: number,
): SurfaceCommandReceipt {
  if (!Number.isInteger(firstSequence) || firstSequence < 0 || !Number.isInteger(eventCount) || eventCount < 0) {
    throw new TypeError("Command receipt sequences must be non-negative integers.");
  }
  return Object.freeze({
    payloadHash: command.payloadHash,
    correlationId: correlationIdSchema.parse(command.correlationId),
    firstSequence: eventCount === 0 ? 0 : firstSequence,
    lastSequence: eventCount === 0 ? 0 : firstSequence + eventCount - 1,
  });
}

function eventInput(record: SurfaceSessionRecord, draft: SurfaceEventDraft) {
  return {
    surfaceSessionId: record.surfaceSessionId,
    streamId: record.streamId,
    epoch: record.epoch,
    committedRevisionId: record.committedRevision.envelope.revisionId,
    audienceBindingHash: record.audienceBindingHash,
    contractSetHash: record.catalogSlice.contractSetHash,
    correlationId: draft.correlationId,
    ...(draft.causationId ? { causationId: draft.causationId } : {}),
    payload: draft.payload,
    cursorExpiresAt: record.streamPolicy.cursorExpiresAt,
  };
}

function parseDraft(input: SurfaceEventDraft): SurfaceEventDraft {
  return Object.freeze({
    correlationId: correlationIdSchema.parse(input.correlationId),
    ...(input.causationId ? { causationId: input.causationId } : {}),
    payload: surfaceEventPayloadSchema.parse(input.payload),
  });
}

function validateRecord(input: SurfaceSessionRecord): SurfaceSessionRecord {
  const record = structuredClone(input);
  surfaceSessionIdSchema.parse(record.surfaceSessionId);
  sha256HashSchema.parse(record.audienceBindingHash);
  if (!Number.isInteger(record.epoch) || record.epoch < 0) throw new TypeError("Surface epoch must be non-negative.");
  if (Date.parse(record.createdAt) >= Date.parse(record.expiresAt)) throw new TypeError("Surface session expiry must follow creation.");
  if (record.streamPolicy.cursorExpiresAt !== record.expiresAt) {
    throw new TypeError("Surface cursor expiry must equal the session expiry.");
  }
  if (record.activeTransaction) {
    transactionIdSchema.parse(record.activeTransaction.transactionId);
    const startedAt = isoTimestampSchema.parse(record.activeTransaction.startedAt);
    const deadlineAt = isoTimestampSchema.parse(record.activeTransaction.deadlineAt);
    if (Date.parse(deadlineAt) <= Date.parse(startedAt)) {
      throw new TypeError("Active transaction deadline must follow its start time.");
    }
    if (Date.parse(deadlineAt) > Date.parse(record.expiresAt)) {
      throw new TypeError("Active transaction deadline cannot outlive its Surface session.");
    }
  }
  if (
    record.activePreview
    && record.activeTransaction?.transactionId !== record.activePreview.transactionId
  ) throw new TypeError("Active preview must belong to the active transaction.");
  if (
    record.pendingRevisionPublication
    && record.activeTransaction?.transactionId
      !== record.pendingRevisionPublication.finalize.transactionId
  ) throw new TypeError("Pending revision publication must belong to the active transaction.");
  for (const [bindingId, identityInput] of Object.entries(record.resourceResolutionIdentities)) {
    const identity = resourceResolutionIdentitySchema.parse(identityInput);
    if (bindingId !== identity.bindingId || !record.committedRevision.content.resourceBindings[identity.bindingId]) {
      throw new TypeError("Resource resolution identity does not match a committed binding.");
    }
  }
  for (const bindingId of Object.keys(record.resources)) {
    if (!record.resourceResolutionIdentities[bindingId as keyof typeof record.resourceResolutionIdentities]) {
      throw new TypeError("Resolved Surface resources require a resolution identity.");
    }
  }
  return record;
}

function assertSnapshotMatchesRecord(
  record: SurfaceSessionRecord,
  payload: Extract<SurfaceEventPayload, { type: "snapshot-published" }>,
): void {
  const expected = {
    revision: record.committedRevision,
    state: record.state,
    resources: record.resources,
    resourceResolutionIdentities: record.resourceResolutionIdentities,
    actions: record.actions,
    approvals: record.approvals,
  };
  if (
    canonicalStringify(payload.snapshot) !== canonicalStringify(expected)
    || canonicalStringify(payload.streamPolicy) !== canonicalStringify(record.streamPolicy)
  ) throw new TypeError("Initial Surface snapshot must exactly match its session record.");
}

function assertCommitSessionIdentity(
  current: SurfaceSessionRecord,
  next: SurfaceSessionRecord,
  events: readonly SurfaceEventDraft[],
  command: HostCommandEnvelope | undefined,
): boolean {
  if (
    current.surfaceSessionId !== next.surfaceSessionId
    || current.streamId !== next.streamId
    || current.audienceBindingHash !== next.audienceBindingHash
    || canonicalStringify(current.authority) !== canonicalStringify(next.authority)
    || current.rendererCapabilityManifest.manifestHash !== next.rendererCapabilityManifest.manifestHash
    || current.catalogSlice.sliceHash !== next.catalogSlice.sliceHash
  ) throw new TypeError("A journal commit cannot change immutable Surface session identity or negotiated capabilities.");
  if (current.epoch === next.epoch) return false;
  if (
    next.epoch !== current.epoch + 1
    || command?.payload.type !== "resume-request"
    || events.length !== 1
    || events[0]?.payload.type !== "snapshot-published"
    || next.activeTransaction !== undefined
    || next.activePreview !== undefined
    || next.pendingRevisionPublication !== undefined
    || next.acknowledgedThrough !== 0
  ) {
    throw new TypeError("A Surface epoch can advance only through a resume snapshot replacement.");
  }
  assertSnapshotMatchesRecord(next, events[0].payload);
  return true;
}

function streamKey(record: Pick<SurfaceSessionRecord, "streamId" | "epoch">): string {
  return `${record.streamId}\0${record.epoch}`;
}

function cloneSession(session: VersionedSurfaceSession): VersionedSurfaceSession {
  return structuredClone(session);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
