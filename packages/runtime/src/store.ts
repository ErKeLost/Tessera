import { canonicalize } from "./canonical";
import { STREAM_PROTOCOL } from "./constants";
import { durableStateKey } from "./durable-state";
import type { DurableStateStorePort } from "./durable-state";
import type {
  ArtifactDocument,
  ArtifactMeta,
  ArtifactNode,
  ArtifactSemanticContent,
  BranchHeadPrecondition,
  ClientActionInvocationSummary,
  ClientApprovalCheckpoint,
  ClientArtifactEvent,
  ClientArtifactEventPayload,
  ClientEffectSummary,
  ClientStateTransitionReceipt,
  Diagnostic,
  DocumentPolicy,
  DraftOperation,
  EvidenceReference,
  ProposalContext,
  ResourceReference,
  RuntimeSnapshot,
  StateDefinition,
  StateMigrationReceipt,
  StateRecord,
  ActionPlan,
  ClaimBinding,
  JsonValue,
} from "./schemas";

export type ArtifactDraftContent = {
  protocol: ArtifactSemanticContent["protocol"];
  protocolVersion: ArtifactSemanticContent["protocolVersion"];
  policy: DocumentPolicy;
  catalog: ArtifactSemanticContent["catalog"];
  renderMode: ArtifactSemanticContent["renderMode"];
  root?: string;
  nodes: Record<string, ArtifactNode>;
  state: Record<string, StateDefinition>;
  actions: Record<string, ActionPlan>;
  resources: Record<string, ResourceReference>;
  evidence: Record<string, EvidenceReference>;
  claims: Record<string, ClaimBinding>;
  meta: ArtifactMeta;
};

export type AppliedDraftOperation = {
  seq: number;
  opId: string;
  payloadHash: string;
  operation: DraftOperation;
};

export type StoredTransaction = {
  transactionId: string;
  status: "open" | "committed" | "aborted";
  version: number;
  context: ProposalContext;
  contextHash: string;
  draft: ArtifactDraftContent;
  acceptedThroughSeq: number;
  applied: AppliedDraftOperation[];
  buffered: Record<string, AppliedDraftOperation>;
  bufferedBytes: number;
  createdAt: string;
  updatedAt: string;
  committed?: {
    canonicalDraftHash: string;
    snapshot: RuntimeSnapshot;
    event?: ClientArtifactEvent;
  };
  aborted?: {
    reason?: string;
    lastGoodRevisionId?: string;
    diagnostics: Diagnostic[];
    event?: ClientArtifactEvent;
  };
};

export type TransactionCreateResult =
  | { status: "created"; transaction: StoredTransaction }
  | { status: "exists"; transaction: StoredTransaction };

export type TransactionUpdateResult =
  | { status: "updated"; transaction: StoredTransaction }
  | { status: "conflict"; transaction: StoredTransaction }
  | { status: "missing" };

export type BranchConflict = {
  expected: BranchHeadPrecondition | null;
  actual: BranchHeadPrecondition | null;
};

export type AtomicCommitRequest = {
  transactionId: string;
  expectedTransactionVersion: number;
  canonicalDraftHash: string;
  document: ArtifactDocument;
  expectedHeads: BranchHeadPrecondition[];
  requireTargetBranchAbsent: boolean;
  nextState: StateRecord[];
  stateMigrationReceipts?: StateMigrationReceipt[];
  stateTransitionReceipts?: ClientStateTransitionReceipt[];
  streamId?: string;
};

export type AtomicCommitResult =
  | { status: "committed"; transaction: StoredTransaction; snapshot: RuntimeSnapshot; event?: ClientArtifactEvent }
  | { status: "replayed"; transaction: StoredTransaction; snapshot: RuntimeSnapshot; event?: ClientArtifactEvent }
  | { status: "branch-conflict"; conflicts: BranchConflict[]; transaction: StoredTransaction }
  | { status: "state-conflict"; stateIds: string[]; transaction: StoredTransaction }
  | { status: "transaction-conflict"; transaction: StoredTransaction }
  | { status: "hash-conflict"; transaction: StoredTransaction }
  | { status: "too-late"; transaction: StoredTransaction }
  | { status: "missing" };

export type AtomicAbortRequest = {
  transactionId: string;
  expectedTransactionVersion: number;
  reason?: string;
  diagnostics: Diagnostic[];
  streamId?: string;
};

export type AtomicAbortResult =
  | { status: "aborted" | "replayed"; transaction: StoredTransaction; event?: ClientArtifactEvent }
  | { status: "transaction-conflict"; transaction: StoredTransaction }
  | { status: "too-late"; transaction: StoredTransaction }
  | { status: "missing" };

export type DetachedRevisionCommitRequest = {
  document: ArtifactDocument;
  expectedHeads: BranchHeadPrecondition[];
  requireTargetBranchAbsent: boolean;
  nextState?: StateRecord[];
};

export type DetachedRevisionCommitResult =
  | { status: "committed"; snapshot: RuntimeSnapshot }
  | { status: "branch-conflict"; conflicts: BranchConflict[] }
  | { status: "revision-conflict" };

export type ResumeResult =
  | { status: "events"; events: ClientArtifactEvent[] }
  | { status: "snapshot"; snapshot: RuntimeSnapshot; reason: "cursor-expired" }
  | { status: "invalid-cursor" | "stream-mismatch" | "fingerprint-mismatch" | "snapshot-unavailable" };

export type RequestIdentity = {
  tenant: string;
  actor: string;
  requestId: string;
};

export type RequestClaim =
  | { status: "claimed" }
  | { status: "pending" }
  | { status: "replayed"; response: JsonValue }
  | { status: "payload-conflict" };

export interface ArtifactRuntimeStorePort {
  getRevision(documentId: string, revisionId: string): Promise<ArtifactDocument | undefined>;
  listRevisions(documentId: string): Promise<ArtifactDocument[]>;
  getBranchHead(documentId: string, branchId: string): Promise<BranchHeadPrecondition | undefined>;
  readRuntimeSnapshot(documentId: string, branchId: string): Promise<RuntimeSnapshot | undefined>;
  commitDetachedRevision(request: DetachedRevisionCommitRequest): Promise<DetachedRevisionCommitResult>;

  getTransaction(transactionId: string): Promise<StoredTransaction | undefined>;
  createTransaction(transaction: StoredTransaction): Promise<TransactionCreateResult>;
  compareAndSwapTransaction(
    transactionId: string,
    expectedVersion: number,
    next: StoredTransaction,
  ): Promise<TransactionUpdateResult>;
  commitTransaction(request: AtomicCommitRequest): Promise<AtomicCommitResult>;
  abortTransaction(request: AtomicAbortRequest): Promise<AtomicAbortResult>;

  createStream(streamId: string, contractFingerprint: string): Promise<void>;
  appendEvent(streamId: string, payload: ClientArtifactEventPayload): Promise<ClientArtifactEvent>;
  resume(
    streamId: string,
    cursor: string,
    contractFingerprint: string,
    documentId: string,
    branchId: string,
  ): Promise<ResumeResult>;

  claimRequest(identity: RequestIdentity, payloadHash: string): Promise<RequestClaim>;
  completeRequest(identity: RequestIdentity, payloadHash: string, response: JsonValue): Promise<void>;
}

export type InMemoryRuntimeStoreOptions = {
  now?: () => string;
  headTokenFactory?: (documentId: string, branchId: string, revisionId: string, sequence: number) => string;
  eventIdFactory?: (streamId: string, sequence: number) => string;
  cursorFactory?: (streamId: string, sequence: number) => string;
  maxRetainedEvents?: number;
  initialState?: RuntimeStoreState;
};

type RuntimeAuxiliary = {
  state: StateRecord[];
  pendingActions: ClientActionInvocationSummary[];
  pendingEffects: ClientEffectSummary[];
  activeApprovals: ClientApprovalCheckpoint[];
  stateMigrationReceipts: StateMigrationReceipt[];
  stateTransitionReceipts: ClientStateTransitionReceipt[];
};

type StreamRecord = {
  contractFingerprint: string;
  nextSequence: number;
  events: ClientArtifactEvent[];
  expiredCursors: Set<string>;
};

type DeduplicationRecord = {
  payloadHash: string;
  status: "pending" | "completed";
  response?: JsonValue;
};

/** JSON-safe snapshot used by durable runtime store adapters. */
export type RuntimeStoreState = {
  formatVersion: 1;
  revisions: Array<[string, ArtifactDocument]>;
  heads: Array<[string, BranchHeadPrecondition]>;
  transactions: Array<[string, StoredTransaction]>;
  auxiliary: Array<[string, RuntimeAuxiliary]>;
  streams: Array<[string, Omit<StreamRecord, "expiredCursors"> & { expiredCursors: string[] }]>;
  deduplication: Array<[string, DeduplicationRecord]>;
  headCounter: number;
};

export class InMemoryArtifactRuntimeStore implements ArtifactRuntimeStorePort {
  readonly #revisions = new Map<string, ArtifactDocument>();
  readonly #heads = new Map<string, BranchHeadPrecondition>();
  readonly #transactions = new Map<string, StoredTransaction>();
  readonly #auxiliary = new Map<string, RuntimeAuxiliary>();
  readonly #streams = new Map<string, StreamRecord>();
  readonly #deduplication = new Map<string, DeduplicationRecord>();
  readonly #now: () => string;
  readonly #headTokenFactory: NonNullable<InMemoryRuntimeStoreOptions["headTokenFactory"]>;
  readonly #eventIdFactory: NonNullable<InMemoryRuntimeStoreOptions["eventIdFactory"]>;
  readonly #cursorFactory: NonNullable<InMemoryRuntimeStoreOptions["cursorFactory"]>;
  readonly #maxRetainedEvents: number;
  #headCounter = 0;

  constructor(options: InMemoryRuntimeStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#headTokenFactory = options.headTokenFactory
      ?? ((documentId, branchId, revisionId, sequence) => `head:${documentId}:${branchId}:${revisionId}:${sequence}`);
    this.#eventIdFactory = options.eventIdFactory ?? ((streamId, sequence) => `event:${streamId}:${sequence}`);
    this.#cursorFactory = options.cursorFactory ?? ((streamId, sequence) => `cursor:${streamId}:${sequence}`);
    this.#maxRetainedEvents = options.maxRetainedEvents ?? 1_000;
    if (options.initialState) this.#restore(options.initialState);
  }

  /** Exposes a JSON-safe state image for a durable adapter, not for client transport. */
  exportState(): RuntimeStoreState {
    return cloneJson({
      formatVersion: 1,
      revisions: [...this.#revisions.entries()],
      heads: [...this.#heads.entries()],
      transactions: [...this.#transactions.entries()],
      auxiliary: [...this.#auxiliary.entries()],
      streams: [...this.#streams.entries()].map(([key, stream]) => [key, {
        contractFingerprint: stream.contractFingerprint,
        nextSequence: stream.nextSequence,
        events: stream.events,
        expiredCursors: [...stream.expiredCursors],
      }]),
      deduplication: [...this.#deduplication.entries()],
      headCounter: this.#headCounter,
    });
  }

  async getRevision(documentId: string, revisionId: string): Promise<ArtifactDocument | undefined> {
    return cloneOptional(this.#revisions.get(revisionKey(documentId, revisionId)));
  }

  async listRevisions(documentId: string): Promise<ArtifactDocument[]> {
    return [...this.#revisions.values()]
      .filter((document) => document.documentId === documentId)
      .sort((left, right) => left.revision.sequence - right.revision.sequence)
      .map(cloneJson);
  }

  async getBranchHead(documentId: string, branchId: string): Promise<BranchHeadPrecondition | undefined> {
    return cloneOptional(this.#heads.get(branchKey(documentId, branchId)));
  }

  async readRuntimeSnapshot(documentId: string, branchId: string): Promise<RuntimeSnapshot | undefined> {
    const head = this.#heads.get(branchKey(documentId, branchId));
    if (!head) return undefined;
    const document = this.#revisions.get(revisionKey(documentId, head.revisionId));
    if (!document) return undefined;
    return cloneJson(this.#makeSnapshot(document, head));
  }

  async commitDetachedRevision(request: DetachedRevisionCommitRequest): Promise<DetachedRevisionCommitResult> {
    const document = cloneJson(request.document);
    const existing = this.#revisions.get(revisionKey(document.documentId, document.revision.revisionId));
    if (existing) {
      if (canonicalize(existing) === canonicalize(document)) {
        const snapshot = this.#snapshotForRevision(existing);
        if (snapshot) return { status: "committed", snapshot: cloneJson(snapshot) };
      }
      return { status: "revision-conflict" };
    }

    const conflicts = this.#headConflicts(
      document.documentId,
      document.revision.branchId,
      request.expectedHeads,
      request.requireTargetBranchAbsent,
    );
    if (conflicts.length > 0) return { status: "branch-conflict", conflicts };
    if (!this.#parentsExist(document)) return { status: "revision-conflict" };

    const head = this.#commitRevision(document, request.nextState ?? []);
    return { status: "committed", snapshot: cloneJson(this.#makeSnapshot(document, head)) };
  }

  async getTransaction(transactionId: string): Promise<StoredTransaction | undefined> {
    return cloneOptional(this.#transactions.get(transactionId));
  }

  async createTransaction(transaction: StoredTransaction): Promise<TransactionCreateResult> {
    const existing = this.#transactions.get(transaction.transactionId);
    if (existing) return { status: "exists", transaction: cloneJson(existing) };
    const stored = cloneJson(transaction);
    this.#transactions.set(transaction.transactionId, stored);
    return { status: "created", transaction: cloneJson(stored) };
  }

  async compareAndSwapTransaction(
    transactionId: string,
    expectedVersion: number,
    next: StoredTransaction,
  ): Promise<TransactionUpdateResult> {
    const current = this.#transactions.get(transactionId);
    if (!current) return { status: "missing" };
    if (current.version !== expectedVersion || current.status !== "open") {
      return { status: "conflict", transaction: cloneJson(current) };
    }
    const stored = cloneJson(next);
    this.#transactions.set(transactionId, stored);
    return { status: "updated", transaction: cloneJson(stored) };
  }

  async commitTransaction(request: AtomicCommitRequest): Promise<AtomicCommitResult> {
    const current = this.#transactions.get(request.transactionId);
    if (!current) return { status: "missing" };
    if (current.status === "committed") {
      if (current.committed?.canonicalDraftHash !== request.canonicalDraftHash || !current.committed.snapshot) {
        return { status: "hash-conflict", transaction: cloneJson(current) };
      }
      return {
        status: "replayed",
        transaction: cloneJson(current),
        snapshot: cloneJson(current.committed.snapshot),
        event: cloneOptional(current.committed.event),
      };
    }
    if (current.status === "aborted") return { status: "too-late", transaction: cloneJson(current) };
    if (current.version !== request.expectedTransactionVersion) {
      return { status: "transaction-conflict", transaction: cloneJson(current) };
    }

    const document = cloneJson(request.document);
    const conflicts = this.#headConflicts(
      document.documentId,
      document.revision.branchId,
      request.expectedHeads,
      request.requireTargetBranchAbsent,
    );
    if (conflicts.length > 0) {
      return { status: "branch-conflict", conflicts, transaction: cloneJson(current) };
    }

    const stateConflicts = this.#stateConflicts(current.context, document.documentId, document.revision.branchId);
    if (stateConflicts.length > 0) {
      return { status: "state-conflict", stateIds: stateConflicts, transaction: cloneJson(current) };
    }
    if (!this.#parentsExist(document)) {
      return { status: "branch-conflict", conflicts: [], transaction: cloneJson(current) };
    }
    if (this.#revisions.has(revisionKey(document.documentId, document.revision.revisionId))) {
      return { status: "transaction-conflict", transaction: cloneJson(current) };
    }

    const head = this.#commitRevision(document, request.nextState, {
      stateMigrationReceipts: request.stateMigrationReceipts,
      stateTransitionReceipts: request.stateTransitionReceipts,
    });
    const snapshot = this.#makeSnapshot(document, head);
    const event = request.streamId
      ? this.#appendEventUnsafe(request.streamId, {
          type: "committed",
          transactionId: request.transactionId,
          snapshot,
        })
      : undefined;
    const committed: StoredTransaction = {
      ...current,
      status: "committed",
      version: current.version + 1,
      updatedAt: this.#now(),
      committed: {
        canonicalDraftHash: request.canonicalDraftHash,
        snapshot,
        ...(event ? { event } : {}),
      },
    };
    this.#transactions.set(request.transactionId, cloneJson(committed));
    return {
      status: "committed",
      transaction: cloneJson(committed),
      snapshot: cloneJson(snapshot),
      event: cloneOptional(event),
    };
  }

  async abortTransaction(request: AtomicAbortRequest): Promise<AtomicAbortResult> {
    const current = this.#transactions.get(request.transactionId);
    if (!current) return { status: "missing" };
    if (current.status === "committed") return { status: "too-late", transaction: cloneJson(current) };
    if (current.status === "aborted") {
      return { status: "replayed", transaction: cloneJson(current), event: cloneOptional(current.aborted?.event) };
    }
    if (current.version !== request.expectedTransactionVersion) {
      return { status: "transaction-conflict", transaction: cloneJson(current) };
    }

    const target = current.context.target;
    const head = this.#heads.get(branchKey(target.documentId, target.branchId));
    const payload: ClientArtifactEventPayload = {
      type: "transaction-aborted",
      transactionId: request.transactionId,
      ...(head ? { lastGoodRevisionId: head.revisionId } : {}),
      diagnostics: cloneJson(request.diagnostics),
    };
    const event = request.streamId ? this.#appendEventUnsafe(request.streamId, payload) : undefined;
    const aborted: StoredTransaction = {
      ...current,
      status: "aborted",
      version: current.version + 1,
      updatedAt: this.#now(),
      aborted: {
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(head ? { lastGoodRevisionId: head.revisionId } : {}),
        diagnostics: cloneJson(request.diagnostics),
        ...(event ? { event } : {}),
      },
    };
    this.#transactions.set(request.transactionId, cloneJson(aborted));
    return { status: "aborted", transaction: cloneJson(aborted), event: cloneOptional(event) };
  }

  async createStream(streamId: string, contractFingerprint: string): Promise<void> {
    const current = this.#streams.get(streamId);
    if (current) {
      if (current.contractFingerprint !== contractFingerprint) {
        throw new Error(`Stream ${streamId} already exists with another fingerprint.`);
      }
      return;
    }
    this.#streams.set(streamId, {
      contractFingerprint,
      nextSequence: 1,
      events: [],
      expiredCursors: new Set(),
    });
  }

  async appendEvent(streamId: string, payload: ClientArtifactEventPayload): Promise<ClientArtifactEvent> {
    return cloneJson(this.#appendEventUnsafe(streamId, payload));
  }

  async resume(
    streamId: string,
    cursor: string,
    contractFingerprint: string,
    documentId: string,
    branchId: string,
  ): Promise<ResumeResult> {
    const stream = this.#streams.get(streamId);
    if (!stream) return { status: "stream-mismatch" };
    if (stream.contractFingerprint !== contractFingerprint) return { status: "fingerprint-mismatch" };
    const initialCursor = this.#cursorFactory(streamId, 0);
    const eventIndex = stream.events.findIndex((event) => event.cursor === cursor);
    if (cursor === initialCursor) return { status: "events", events: cloneJson(stream.events) };
    if (eventIndex >= 0) return { status: "events", events: cloneJson(stream.events.slice(eventIndex + 1)) };
    if (!stream.expiredCursors.has(cursor)) return { status: "invalid-cursor" };
    const snapshot = await this.readRuntimeSnapshot(documentId, branchId);
    return snapshot
      ? { status: "snapshot", snapshot, reason: "cursor-expired" }
      : { status: "snapshot-unavailable" };
  }

  async claimRequest(identity: RequestIdentity, payloadHash: string): Promise<RequestClaim> {
    const key = requestKey(identity);
    const existing = this.#deduplication.get(key);
    if (!existing) {
      this.#deduplication.set(key, { payloadHash, status: "pending" });
      return { status: "claimed" };
    }
    if (existing.payloadHash !== payloadHash) return { status: "payload-conflict" };
    if (existing.status === "pending") return { status: "pending" };
    return { status: "replayed", response: cloneJson(existing.response ?? null) };
  }

  async completeRequest(identity: RequestIdentity, payloadHash: string, response: JsonValue): Promise<void> {
    const key = requestKey(identity);
    const existing = this.#deduplication.get(key);
    if (!existing || existing.payloadHash !== payloadHash) {
      throw new Error("Cannot complete an unclaimed or payload-conflicting request.");
    }
    if (existing.status === "completed" && canonicalize(existing.response) !== canonicalize(response)) {
      throw new Error("A completed request cannot be rewritten with a different response.");
    }
    this.#deduplication.set(key, { payloadHash, status: "completed", response: cloneJson(response) });
  }

  seedRuntimeAuxiliary(
    documentId: string,
    branchId: string,
    auxiliary: Partial<RuntimeAuxiliary>,
  ): void {
    const key = branchKey(documentId, branchId);
    const current = this.#auxiliary.get(key) ?? emptyAuxiliary();
    this.#auxiliary.set(key, cloneJson({ ...current, ...auxiliary }));
  }

  initialCursor(streamId: string): string {
    if (!this.#streams.has(streamId)) throw new Error(`Unknown stream ${streamId}.`);
    return this.#cursorFactory(streamId, 0);
  }

  #restore(input: RuntimeStoreState): void {
    const state = cloneJson(input);
    if (
      state.formatVersion !== 1
      || !Array.isArray(state.revisions)
      || !Array.isArray(state.heads)
      || !Array.isArray(state.transactions)
      || !Array.isArray(state.auxiliary)
      || !Array.isArray(state.streams)
      || !Array.isArray(state.deduplication)
      || !Number.isSafeInteger(state.headCounter)
      || state.headCounter < 0
    ) throw new TypeError("Unsupported durable runtime store state.");
    this.#revisions.clear();
    this.#heads.clear();
    this.#transactions.clear();
    this.#auxiliary.clear();
    this.#streams.clear();
    this.#deduplication.clear();
    for (const [key, value] of state.revisions) this.#revisions.set(key, cloneJson(value));
    for (const [key, value] of state.heads) this.#heads.set(key, cloneJson(value));
    for (const [key, value] of state.transactions) this.#transactions.set(key, cloneJson(value));
    for (const [key, value] of state.auxiliary) this.#auxiliary.set(key, cloneJson(value));
    for (const [key, value] of state.streams) {
      this.#streams.set(key, {
        contractFingerprint: value.contractFingerprint,
        nextSequence: value.nextSequence,
        events: cloneJson(value.events),
        expiredCursors: new Set(value.expiredCursors),
      });
    }
    for (const [key, value] of state.deduplication) this.#deduplication.set(key, cloneJson(value));
    this.#headCounter = state.headCounter;
  }

  #parentsExist(document: ArtifactDocument): boolean {
    if (document.revision.parentRevisionIds.length === 0) return true;
    return document.revision.parentRevisionIds.every((revisionId) =>
      this.#revisions.has(revisionKey(document.documentId, revisionId))
    );
  }

  #headConflicts(
    documentId: string,
    targetBranchId: string,
    expectedHeads: BranchHeadPrecondition[],
    requireTargetBranchAbsent: boolean,
  ): BranchConflict[] {
    const conflicts: BranchConflict[] = [];
    if (requireTargetBranchAbsent) {
      const current = this.#heads.get(branchKey(documentId, targetBranchId));
      if (current) conflicts.push({ expected: null, actual: cloneJson(current) });
    }
    for (const expected of expectedHeads) {
      const actual = this.#heads.get(branchKey(documentId, expected.branchId));
      if (!actual || actual.revisionId !== expected.revisionId || actual.headToken !== expected.headToken) {
        conflicts.push({ expected: cloneJson(expected), actual: cloneOptional(actual) ?? null });
      }
    }
    return conflicts;
  }

  #stateConflicts(context: ProposalContext, documentId: string, branchId: string): string[] {
    if (context.target.mode === "create") return [];
    const actual = new Map(
      (this.#auxiliary.get(branchKey(documentId, branchId))?.state ?? [])
        .map((record) => [record.stateId, record.stateRevision]),
    );
    return Object.entries(context.target.statePreconditions)
      .filter(([stateId, expected]) => actual.get(stateId) !== expected)
      .map(([stateId]) => stateId);
  }

  #commitRevision(
    document: ArtifactDocument,
    nextState: StateRecord[],
    receipts: {
      stateMigrationReceipts?: StateMigrationReceipt[];
      stateTransitionReceipts?: ClientStateTransitionReceipt[];
    } = {},
  ): BranchHeadPrecondition {
    const revision = cloneJson(document);
    this.#revisions.set(revisionKey(document.documentId, document.revision.revisionId), revision);
    this.#headCounter += 1;
    const head: BranchHeadPrecondition = {
      branchId: document.revision.branchId,
      revisionId: document.revision.revisionId,
      headToken: this.#headTokenFactory(
        document.documentId,
        document.revision.branchId,
        document.revision.revisionId,
        this.#headCounter,
      ),
    };
    const key = branchKey(document.documentId, document.revision.branchId);
    this.#heads.set(key, head);
    const current = this.#auxiliary.get(key) ?? emptyAuxiliary();
    this.#auxiliary.set(key, {
      ...current,
      state: cloneJson(nextState),
      stateMigrationReceipts: cloneJson(receipts.stateMigrationReceipts ?? current.stateMigrationReceipts),
      stateTransitionReceipts: cloneJson(receipts.stateTransitionReceipts ?? current.stateTransitionReceipts),
    });
    return head;
  }

  #makeSnapshot(document: ArtifactDocument, head: BranchHeadPrecondition): RuntimeSnapshot {
    const auxiliary = this.#auxiliary.get(branchKey(document.documentId, head.branchId)) ?? emptyAuxiliary();
    return {
      document: cloneJson(document),
      branchHead: cloneJson(head),
      state: cloneJson(auxiliary.state),
      pendingActions: cloneJson(auxiliary.pendingActions),
      pendingEffects: cloneJson(auxiliary.pendingEffects),
      activeApprovals: cloneJson(auxiliary.activeApprovals),
      stateMigrationReceipts: cloneJson(auxiliary.stateMigrationReceipts),
      stateTransitionReceipts: cloneJson(auxiliary.stateTransitionReceipts),
    };
  }

  #snapshotForRevision(document: ArtifactDocument): RuntimeSnapshot | undefined {
    const head = this.#heads.get(branchKey(document.documentId, document.revision.branchId));
    if (!head || head.revisionId !== document.revision.revisionId) return undefined;
    return this.#makeSnapshot(document, head);
  }

  #appendEventUnsafe(streamId: string, payload: ClientArtifactEventPayload): ClientArtifactEvent {
    const stream = this.#streams.get(streamId);
    if (!stream) throw new Error(`Unknown stream ${streamId}.`);
    const sequence = stream.nextSequence;
    stream.nextSequence += 1;
    const event: ClientArtifactEvent = {
      streamProtocol: STREAM_PROTOCOL,
      streamId,
      seq: sequence,
      eventId: this.#eventIdFactory(streamId, sequence),
      cursor: this.#cursorFactory(streamId, sequence),
      contractFingerprint: stream.contractFingerprint,
      payload: cloneJson(payload),
    };
    stream.events.push(event);
    while (stream.events.length > this.#maxRetainedEvents) {
      const expired = stream.events.shift();
      if (expired) stream.expiredCursors.add(expired.cursor);
    }
    return cloneJson(event);
  }
}

export type DurableArtifactRuntimeStoreOptions = Omit<InMemoryRuntimeStoreOptions, "initialState"> & {
  state: DurableStateStorePort;
  /** Use one isolated partition per tenant/document revision authority. */
  storageKey?: string;
};

/**
 * Durable implementation of ArtifactRuntimeStorePort. It reuses the proven
 * transaction semantics of the in-memory store inside one host-provided atomic
 * state transaction, so each ArtifactRuntimeStorePort operation either commits
 * its complete state image or none of it. Partition it by tenant and document
 * to avoid a global hot record; all operations for one revision graph must use
 * the same partition.
 */
export class DurableArtifactRuntimeStore implements ArtifactRuntimeStorePort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;
  readonly #memoryOptions: Omit<InMemoryRuntimeStoreOptions, "initialState">;

  constructor(options: DurableArtifactRuntimeStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("artifact-runtime");
    const { state: _state, storageKey: _storageKey, ...memoryOptions } = options;
    this.#memoryOptions = memoryOptions;
  }

  async getRevision(documentId: string, revisionId: string): Promise<ArtifactDocument | undefined> {
    return this.#withStore((store) => store.getRevision(documentId, revisionId));
  }

  async listRevisions(documentId: string): Promise<ArtifactDocument[]> {
    return this.#withStore((store) => store.listRevisions(documentId));
  }

  async getBranchHead(documentId: string, branchId: string): Promise<BranchHeadPrecondition | undefined> {
    return this.#withStore((store) => store.getBranchHead(documentId, branchId));
  }

  async readRuntimeSnapshot(documentId: string, branchId: string): Promise<RuntimeSnapshot | undefined> {
    return this.#withStore((store) => store.readRuntimeSnapshot(documentId, branchId));
  }

  async commitDetachedRevision(request: DetachedRevisionCommitRequest): Promise<DetachedRevisionCommitResult> {
    return this.#withStore((store) => store.commitDetachedRevision(request), true);
  }

  async getTransaction(transactionId: string): Promise<StoredTransaction | undefined> {
    return this.#withStore((store) => store.getTransaction(transactionId));
  }

  async createTransaction(transaction: StoredTransaction): Promise<TransactionCreateResult> {
    return this.#withStore((store) => store.createTransaction(transaction), true);
  }

  async compareAndSwapTransaction(
    transactionId: string,
    expectedVersion: number,
    next: StoredTransaction,
  ): Promise<TransactionUpdateResult> {
    return this.#withStore((store) => store.compareAndSwapTransaction(transactionId, expectedVersion, next), true);
  }

  async commitTransaction(request: AtomicCommitRequest): Promise<AtomicCommitResult> {
    return this.#withStore((store) => store.commitTransaction(request), true);
  }

  async abortTransaction(request: AtomicAbortRequest): Promise<AtomicAbortResult> {
    return this.#withStore((store) => store.abortTransaction(request), true);
  }

  async createStream(streamId: string, contractFingerprint: string): Promise<void> {
    return this.#withStore((store) => store.createStream(streamId, contractFingerprint), true);
  }

  async appendEvent(streamId: string, payload: ClientArtifactEventPayload): Promise<ClientArtifactEvent> {
    return this.#withStore((store) => store.appendEvent(streamId, payload), true);
  }

  async resume(
    streamId: string,
    cursor: string,
    contractFingerprint: string,
    documentId: string,
    branchId: string,
  ): Promise<ResumeResult> {
    return this.#withStore((store) => store.resume(streamId, cursor, contractFingerprint, documentId, branchId));
  }

  async claimRequest(identity: RequestIdentity, payloadHash: string): Promise<RequestClaim> {
    return this.#withStore((store) => store.claimRequest(identity, payloadHash), true);
  }

  async completeRequest(identity: RequestIdentity, payloadHash: string, response: JsonValue): Promise<void> {
    return this.#withStore((store) => store.completeRequest(identity, payloadHash, response), true);
  }

  async seedRuntimeAuxiliary(
    documentId: string,
    branchId: string,
    auxiliary: Partial<RuntimeAuxiliary>,
  ): Promise<void> {
    return this.#withStore(async (store) => {
      store.seedRuntimeAuxiliary(documentId, branchId, auxiliary);
    }, true);
  }

  async initialCursor(streamId: string): Promise<string> {
    return this.#withStore(async (store) => store.initialCursor(streamId));
  }

  async #withStore<T>(
    operation: (store: InMemoryArtifactRuntimeStore) => Promise<T>,
    persist = false,
  ): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<RuntimeStoreState>(this.#storageKey);
      const store = new InMemoryArtifactRuntimeStore({ ...this.#memoryOptions, ...(stored ? { initialState: stored } : {}) });
      return operation(store);
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<RuntimeStoreState>(this.#storageKey);
      const store = new InMemoryArtifactRuntimeStore({ ...this.#memoryOptions, ...(stored ? { initialState: stored } : {}) });
      const result = await operation(store);
      await transaction.set(this.#storageKey, store.exportState());
      return result;
    });
  }
}

function emptyAuxiliary(): RuntimeAuxiliary {
  return {
    state: [],
    pendingActions: [],
    pendingEffects: [],
    activeApprovals: [],
    stateMigrationReceipts: [],
    stateTransitionReceipts: [],
  };
}

function revisionKey(documentId: string, revisionId: string): string {
  return `${documentId}\u0000${revisionId}`;
}

function branchKey(documentId: string, branchId: string): string {
  return `${documentId}\u0000${branchId}`;
}

function requestKey(identity: RequestIdentity): string {
  return `${identity.tenant}\u0000${identity.actor}\u0000${identity.requestId}`;
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : cloneJson(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}
