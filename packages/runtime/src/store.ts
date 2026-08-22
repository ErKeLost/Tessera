import {
  canonicalStringify,
  type BranchId,
  type BranchHead,
  type CanonicalEntityRef,
  type CommittedRevision,
  type DocumentId,
  type RevisionId,
  type TransactionId,
  type TransactionIdentityMapDelta,
} from "@open-generative/protocol";
import type { EntityRevisionIndex } from "./document-operations";
import { immutableClone } from "./utils";

export type StoredRevision = {
  revision: CommittedRevision;
  entityRevisions: EntityRevisionIndex;
};

export type Versioned<T> = {
  version: number;
  value: T;
};

export type AtomicTransactionCommitRequest<TRecord> = {
  transactionId: TransactionId;
  expectedTransactionVersion: number;
  transaction: TRecord;
  expectedHead: BranchHead;
  nextHead: BranchHead;
  revision: StoredRevision;
};

export type AtomicTransactionCommitResult =
  | { status: "committed" }
  | { status: "transaction-conflict" }
  | { status: "head-conflict"; current?: BranchHead }
  | { status: "revision-conflict" };

export interface RevisionBranchStorePort {
  getRevision(documentId: DocumentId, revisionId: RevisionId): Promise<StoredRevision | undefined>;
  getBranchHead(documentId: DocumentId, branchId: BranchId): Promise<BranchHead | undefined>;
  listDocumentRevisions(documentId: DocumentId): Promise<StoredRevision[]>;
}

export interface TransactionStorePort<TRecord> {
  createTransaction(transactionId: TransactionId, value: TRecord): Promise<"created" | "exists">;
  getTransaction(transactionId: TransactionId): Promise<Versioned<TRecord> | undefined>;
  compareAndSetTransaction(
    transactionId: TransactionId,
    expectedVersion: number,
    value: TRecord,
  ): Promise<"updated" | "conflict" | "missing">;
  claimIdentityMapDelta(
    transactionId: TransactionId,
    delta: TransactionIdentityMapDelta,
  ): Promise<"claimed" | "conflict">;
}

export interface RuntimeStorePort<TRecord> extends RevisionBranchStorePort, TransactionStorePort<TRecord> {
  commitTransactionRevision(
    request: AtomicTransactionCommitRequest<TRecord>,
  ): Promise<AtomicTransactionCommitResult>;
}

export class InMemoryRuntimeStore<TRecord> implements RuntimeStorePort<TRecord> {
  readonly #revisions = new Map<string, StoredRevision>();
  readonly #branches = new Map<string, BranchHead>();
  readonly #transactions = new Map<TransactionId, Versioned<TRecord>>();
  readonly #canonicalIdentityOwners = new Map<string, TransactionId>();
  readonly #localIdentityAssignments = new Map<string, CanonicalEntityRef>();

  seedRevision(input: StoredRevision, branchHead?: BranchHead): void {
    const key = revisionKey(input.revision.envelope.documentId, input.revision.envelope.revisionId);
    const existing = this.#revisions.get(key);
    if (existing && canonicalStringify(existing) !== canonicalStringify(input)) {
      throw new Error("Immutable revision identity conflict.");
    }
    this.#revisions.set(key, immutableClone(input));
    if (branchHead) {
      if (
        branchHead.documentId !== input.revision.envelope.documentId
        || branchHead.revisionId !== input.revision.envelope.revisionId
      ) {
        throw new Error("Seed branch head must reference the seeded revision.");
      }
      this.#branches.set(branchKey(branchHead.documentId, branchHead.branchId), immutableClone(branchHead));
    }
  }

  async getRevision(documentId: DocumentId, revisionId: RevisionId): Promise<StoredRevision | undefined> {
    const value = this.#revisions.get(revisionKey(documentId, revisionId));
    return value ? immutableClone(value) : undefined;
  }

  async getBranchHead(documentId: DocumentId, branchId: BranchId): Promise<BranchHead | undefined> {
    const value = this.#branches.get(branchKey(documentId, branchId));
    return value ? immutableClone(value) : undefined;
  }

  async listDocumentRevisions(documentId: DocumentId): Promise<StoredRevision[]> {
    return [...this.#revisions.values()]
      .filter((record) => record.revision.envelope.documentId === documentId)
      .sort((left, right) => left.revision.envelope.revisionId.localeCompare(right.revision.envelope.revisionId))
      .map(immutableClone);
  }

  async commitTransactionRevision(
    request: AtomicTransactionCommitRequest<TRecord>,
  ): Promise<AtomicTransactionCommitResult> {
    const transaction = this.#transactions.get(request.transactionId);
    if (!transaction || transaction.version !== request.expectedTransactionVersion) {
      return { status: "transaction-conflict" };
    }
    const key = branchKey(request.expectedHead.documentId, request.expectedHead.branchId);
    const current = this.#branches.get(key);
    if (!current || canonicalStringify(current) !== canonicalStringify(request.expectedHead)) {
      return { status: "head-conflict", current: current ? immutableClone(current) : undefined };
    }
    if (
      request.nextHead.documentId !== request.expectedHead.documentId
      || request.nextHead.branchId !== request.expectedHead.branchId
      || request.nextHead.revisionId !== request.revision.revision.envelope.revisionId
    ) {
      throw new Error("Atomic commit identities are inconsistent.");
    }
    const revisionIdentity = revisionKey(
      request.revision.revision.envelope.documentId,
      request.revision.revision.envelope.revisionId,
    );
    const existing = this.#revisions.get(revisionIdentity);
    if (existing && canonicalStringify(existing) !== canonicalStringify(request.revision)) {
      return { status: "revision-conflict" };
    }
    this.#revisions.set(revisionIdentity, immutableClone(request.revision));
    this.#branches.set(key, immutableClone(request.nextHead));
    this.#transactions.set(request.transactionId, {
      version: transaction.version + 1,
      value: immutableClone(request.transaction),
    });
    return { status: "committed" };
  }

  async createTransaction(transactionId: TransactionId, value: TRecord): Promise<"created" | "exists"> {
    if (this.#transactions.has(transactionId)) return "exists";
    this.#transactions.set(transactionId, { version: 1, value: immutableClone(value) });
    return "created";
  }

  async getTransaction(transactionId: TransactionId): Promise<Versioned<TRecord> | undefined> {
    const record = this.#transactions.get(transactionId);
    return record ? immutableClone(record) : undefined;
  }

  async compareAndSetTransaction(
    transactionId: TransactionId,
    expectedVersion: number,
    value: TRecord,
  ): Promise<"updated" | "conflict" | "missing"> {
    const current = this.#transactions.get(transactionId);
    if (!current) return "missing";
    if (current.version !== expectedVersion) return "conflict";
    this.#transactions.set(transactionId, { version: current.version + 1, value: immutableClone(value) });
    return "updated";
  }

  async claimIdentityMapDelta(
    transactionId: TransactionId,
    delta: TransactionIdentityMapDelta,
  ): Promise<"claimed" | "conflict"> {
    for (const entry of delta) {
      const localKey = `${transactionId}:${entry.kind}:${entry.localId}`;
      const canonicalRef = toCanonicalRef(entry);
      const priorLocal = this.#localIdentityAssignments.get(localKey);
      if (priorLocal && canonicalStringify(priorLocal) !== canonicalStringify(canonicalRef)) return "conflict";
      const canonicalKey = `${entry.kind}:${entry.canonicalId}`;
      const owner = this.#canonicalIdentityOwners.get(canonicalKey);
      if (owner && owner !== transactionId) return "conflict";
    }
    for (const entry of delta) {
      const localKey = `${transactionId}:${entry.kind}:${entry.localId}`;
      const canonicalRef = toCanonicalRef(entry);
      this.#localIdentityAssignments.set(localKey, immutableClone(canonicalRef));
      this.#canonicalIdentityOwners.set(`${entry.kind}:${entry.canonicalId}`, transactionId);
    }
    return "claimed";
  }
}

function toCanonicalRef(entry: TransactionIdentityMapDelta[number]): CanonicalEntityRef {
  return { kind: entry.kind, id: entry.canonicalId } as CanonicalEntityRef;
}

function revisionKey(documentId: DocumentId, revisionId: RevisionId): string {
  return `${documentId}\0${revisionId}`;
}

function branchKey(documentId: DocumentId, branchId: BranchId): string {
  return `${documentId}\0${branchId}`;
}
