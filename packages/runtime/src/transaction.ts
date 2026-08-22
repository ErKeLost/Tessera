import {
  DEFAULT_PROTOCOL_LIMITS,
  HASH_DOMAINS,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  actorAuditRefSchema,
  branchIdSchema,
  canonicalOperationEnvelopeSchema,
  canonicalStringify,
  commitCommandPayloadSchema,
  committedRevisionSchema,
  documentIdSchema,
  documentContentSchema,
  headTokenSchema,
  hashCanonical,
  hashDocumentContent,
  isoTimestampSchema,
  revisionEnvelopeSchema,
  revisionIdSchema,
  surfaceSessionIdSchema,
  toProposalEntityKey,
  transactionIdSchema,
  transactionIdentityMapDeltaSchema,
  verifyCanonicalOperationEnvelope,
  type ActorAuditRef,
  type BranchHead,
  type BranchId,
  type CanonicalEntityRef,
  type CanonicalOperationEnvelope,
  type CommittedRevision,
  type DocumentContent,
  type DocumentId,
  type HashProvider,
  type HeadToken,
  type MigrationReceiptId,
  type NodeId,
  type RevisionId,
  type Sha256Hash,
  type SurfaceSessionId,
  type TransactionId,
  type TransactionIdentityMap,
  type TransactionIdentityMapDelta,
  type ValidatedPreview,
} from "@open-generative/protocol";
import { applyCanonicalOperationChecked, type EntityRevisionIndex } from "./document-operations";
import { projectValidatedPreview } from "./preview";
import type { RuntimeStorePort } from "./store";
import type { RuntimeValidationIssue, RuntimeValidationPort } from "./validation";
import { cloneCanonical } from "./utils";

export type BeginTransactionInput = {
  transactionId: TransactionId;
  surfaceSessionId: SurfaceSessionId;
  documentId: DocumentId;
  branchId: BranchId;
  baseRevisionId: RevisionId;
  expectedHeadToken: HeadToken;
  targetRevisionId: RevisionId;
  nextHeadToken: HeadToken;
  createdAt: string;
  createdBy: ActorAuditRef;
  migrationReceiptIds?: MigrationReceiptId[];
};

type PendingOperation = {
  envelope: CanonicalOperationEnvelope;
  identityMapDelta: TransactionIdentityMapDelta;
};

export type RuntimeTransactionRecord = {
  beginHash: Sha256Hash;
  input: BeginTransactionInput;
  status: "active" | "aborted" | "committed";
  draft: DocumentContent;
  entityRevisions: EntityRevisionIndex;
  nextSequence: number;
  buffered: Record<string, PendingOperation>;
  applied: PendingOperation[];
  identityMap: TransactionIdentityMap;
  overlaySequence: number;
  overlayHash?: Sha256Hash;
  abort?: { code: string; message: string };
  committedRevision?: CommittedRevision;
};

export type BeginTransactionResult =
  | { status: "begun" | "replayed"; transaction: RuntimeTransactionRecord; lastGood: CommittedRevision }
  | { status: "rejected" | "conflict" | "missing-base"; message: string; lastGood?: CommittedRevision };

export type ApplyOperationResult =
  | { status: "accepted"; acceptedThroughSequence: number; previews: ValidatedPreview[] }
  | { status: "buffered"; acceptedThroughSequence: number }
  | { status: "replayed"; acceptedThroughSequence: number }
  | { status: "rejected" | "conflict"; message: string; lastGood?: CommittedRevision };

export type FinalizeTransactionInput = {
  transactionId: TransactionId;
  finalOperationSequence: number;
  expectedContentHash: Sha256Hash;
  expectedOverlayHash?: Sha256Hash;
};

export type FinalizeTransactionResult =
  | { status: "committed" | "replayed"; revision: CommittedRevision; consumedOverlayHash?: Sha256Hash }
  | { status: "rejected" | "conflict"; issues: RuntimeValidationIssue[]; lastGood?: CommittedRevision };

export type AbortTransactionResult = {
  status: "aborted" | "replayed" | "already-committed";
  lastGood?: CommittedRevision;
};

export class DocumentTransactionRuntime {
  readonly #store: RuntimeStorePort<RuntimeTransactionRecord>;
  readonly #validation: RuntimeValidationPort;
  readonly #hashProvider?: HashProvider;

  constructor(input: {
    store: RuntimeStorePort<RuntimeTransactionRecord>;
    validation: RuntimeValidationPort;
    hashProvider?: HashProvider;
  }) {
    this.#store = input.store;
    this.#validation = input.validation;
    this.#hashProvider = input.hashProvider;
  }

  async begin(input: BeginTransactionInput): Promise<BeginTransactionResult> {
    let normalized: BeginTransactionInput;
    try {
      normalized = parseBeginTransactionInput(input);
    } catch (error) {
      return { status: "rejected", message: errorMessage(error, "Invalid transaction begin input.") };
    }

    const beginHash = await hashCanonical(HASH_DOMAINS.operationPayload, normalized, this.#hashProvider);
    const existing = await this.#store.getTransaction(normalized.transactionId);
    if (existing) {
      if (existing.value.beginHash !== beginHash) {
        return { status: "conflict", message: "Transaction ID is already bound to different begin input." };
      }
      const lastGood = await this.#lastGood(existing.value.input)
        ?? existing.value.committedRevision;
      if (!lastGood) {
        return {
          status: "rejected",
          message: "Transaction replay has no recoverable last-good revision.",
        };
      }
      return { status: "replayed", transaction: existing.value, lastGood };
    }

    const [base, head] = await Promise.all([
      this.#store.getRevision(normalized.documentId, normalized.baseRevisionId),
      this.#store.getBranchHead(normalized.documentId, normalized.branchId),
    ]);
    if (!base) return { status: "missing-base", message: "Base revision does not exist." };
    if (
      !head
      || head.revisionId !== normalized.baseRevisionId
      || head.headToken !== normalized.expectedHeadToken
    ) {
      return { status: "conflict", message: "Branch head does not match transaction preconditions.", lastGood: await revisionFromHead(this.#store, head) };
    }

    const transaction: RuntimeTransactionRecord = {
      beginHash,
      input: cloneCanonical(normalized),
      status: "active",
      draft: cloneCanonical(base.revision.content),
      entityRevisions: cloneCanonical(base.entityRevisions),
      nextSequence: 1,
      buffered: {},
      applied: [],
      identityMap: {},
      overlaySequence: 0,
    };
    const created = await this.#store.createTransaction(normalized.transactionId, transaction);
    if (created === "exists") return this.begin(normalized);
    return { status: "begun", transaction, lastGood: base.revision };
  }

  async apply(
    envelopeInput: CanonicalOperationEnvelope,
    identityMapDeltaInput: TransactionIdentityMapDelta = [],
  ): Promise<ApplyOperationResult> {
    let envelope: CanonicalOperationEnvelope;
    let identityMapDelta: TransactionIdentityMapDelta;
    try {
      envelope = canonicalOperationEnvelopeSchema.parse(envelopeInput);
      identityMapDelta = transactionIdentityMapDeltaSchema.parse(identityMapDeltaInput);
    } catch (error) {
      return { status: "rejected", message: error instanceof Error ? error.message : "Invalid operation envelope." };
    }
    if (!await verifyCanonicalOperationEnvelope(envelope, this.#hashProvider)) {
      return { status: "rejected", message: "Operation payload hash does not match its canonical operation." };
    }
    if (envelope.sequence > DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction) {
      return {
        status: "rejected",
        message: `Operation sequence exceeds the ${DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction}-operation transaction limit.`,
      };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const versioned = await this.#store.getTransaction(envelope.transactionId);
      if (!versioned) return { status: "rejected", message: "Transaction does not exist." };
      const record = cloneCanonical(versioned.value);
      if (record.status === "aborted") {
        return { status: "rejected", message: record.abort?.message ?? "Transaction is aborted.", lastGood: await this.#lastGood(record.input) };
      }
      if (record.status === "committed") {
        const existing = findOperation(record, envelope.operationId);
        return existing
          && sameEnvelope(existing.envelope, envelope)
          && canonicalStringify(existing.identityMapDelta) === canonicalStringify(identityMapDelta)
          ? { status: "replayed", acceptedThroughSequence: record.nextSequence - 1 }
          : { status: "conflict", message: "Committed transaction cannot accept a new operation." };
      }
      if (envelope.transactionId !== record.input.transactionId) {
        return { status: "conflict", message: "Operation transaction identity mismatch." };
      }

      const existing = findOperation(record, envelope.operationId);
      if (existing) {
        if (sameEnvelope(existing.envelope, envelope) && canonicalStringify(existing.identityMapDelta) === canonicalStringify(identityMapDelta)) {
          return { status: "replayed", acceptedThroughSequence: record.nextSequence - 1 };
        }
        return { status: "conflict", message: "Operation ID was reused with different content." };
      }
      const bufferedCount = Object.keys(record.buffered).length;
      if (
        record.applied.length > DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction
        || bufferedCount > DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction
        || record.applied.length + bufferedCount >= DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction
      ) {
        return {
          status: "rejected",
          message: `Transaction reached the ${DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction}-operation limit.`,
        };
      }
      const sequenceCollision = record.buffered[String(envelope.sequence)]
        ?? record.applied.find((candidate) => candidate.envelope.sequence === envelope.sequence);
      if (sequenceCollision) return { status: "conflict", message: "Operation sequence is already occupied." };
      if (envelope.sequence < record.nextSequence) return { status: "conflict", message: "Operation sequence is stale." };

      if (await this.#store.claimIdentityMapDelta(envelope.transactionId, identityMapDelta) === "conflict") {
        return { status: "conflict", message: "Transaction identity mapping conflicts with an existing or retired identity." };
      }
      if (!mergeIdentityMap(record.identityMap, identityMapDelta)) {
        return { status: "conflict", message: "Proposal-local identity was remapped within the transaction." };
      }
      record.buffered[String(envelope.sequence)] = { envelope, identityMapDelta };

      const drained: PendingOperation[] = [];
      while (true) {
        const pending = record.buffered[String(record.nextSequence)];
        if (!pending) break;
        const appliedIds = new Set(record.applied.map((candidate) => candidate.envelope.operationId));
        if (!pending.envelope.dependsOn.every((dependency) => appliedIds.has(dependency))) break;
        const result = await applyCanonicalOperationChecked(
          record.draft,
          record.entityRevisions,
          pending.envelope.operation,
          this.#hashProvider,
        );
        if (!result.ok) {
          record.status = "aborted";
          record.abort = result.conflict;
          const saved = await this.#store.compareAndSetTransaction(envelope.transactionId, versioned.version, record);
          if (saved === "conflict") break;
          return { status: "rejected", message: result.conflict.message, lastGood: await this.#lastGood(record.input) };
        }
        record.draft = result.content;
        record.entityRevisions = result.entityRevisions;
        delete record.buffered[String(record.nextSequence)];
        record.applied.push(pending);
        record.nextSequence += 1;
        drained.push(pending);
      }

      const previews: ValidatedPreview[] = [];
      if (drained.length > 0) {
        const delta = drained.flatMap((pending) => pending.identityMapDelta);
        const projection = await projectValidatedPreview({
          surfaceSessionId: record.input.surfaceSessionId,
          transactionId: record.input.transactionId,
          baseRevisionId: record.input.baseRevisionId,
          overlaySequence: record.overlaySequence + 1,
          previousOverlayHash: record.overlayHash,
          identityMapDelta: delta,
          operations: drained.map((pending) => pending.envelope.operation),
          projectionOperations: record.applied.map((pending) => pending.envelope.operation),
          document: record.draft,
        }, this.#validation, this.#hashProvider);
        if (!projection.ok) {
          record.status = "aborted";
          record.abort = { code: "preview.validation-failed", message: projection.issues.map((issue) => issue.message).join("; ") };
        } else {
          record.overlaySequence = projection.preview.overlaySequence;
          record.overlayHash = projection.preview.overlayHash;
          previews.push(projection.preview);
        }
      }

      const saved = await this.#store.compareAndSetTransaction(envelope.transactionId, versioned.version, record);
      if (saved === "conflict") continue;
      if (saved === "missing") return { status: "rejected", message: "Transaction disappeared during apply." };
      if (record.status === "aborted") {
        return { status: "rejected", message: record.abort?.message ?? "Preview validation failed.", lastGood: await this.#lastGood(record.input) };
      }
      return drained.length > 0
        ? { status: "accepted", acceptedThroughSequence: record.nextSequence - 1, previews }
        : { status: "buffered", acceptedThroughSequence: record.nextSequence - 1 };
    }
    return { status: "conflict", message: "Transaction changed concurrently too many times." };
  }

  async finalize(input: FinalizeTransactionInput): Promise<FinalizeTransactionResult> {
    let normalized: FinalizeTransactionInput;
    try {
      normalized = parseFinalizeTransactionInput(input);
    } catch (error) {
      return {
        status: "rejected",
        issues: [{ code: "finalize.input-invalid", message: errorMessage(error, "Invalid finalize input.") }],
      };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const versioned = await this.#store.getTransaction(normalized.transactionId);
      if (!versioned) return { status: "rejected", issues: [{ code: "transaction.missing", message: "Transaction does not exist." }] };
      const record = cloneCanonical(versioned.value);
      if (record.status === "committed") {
        if (!record.committedRevision) {
          return {
            status: "conflict",
            issues: [{ code: "transaction.record-invalid", message: "Committed transaction is missing its immutable revision." }],
          };
        }
        return record.committedRevision.envelope.contentHash === normalized.expectedContentHash
          && record.nextSequence - 1 === normalized.finalOperationSequence
          && record.overlayHash === normalized.expectedOverlayHash
          ? { status: "replayed", revision: record.committedRevision, consumedOverlayHash: record.overlayHash }
          : { status: "conflict", issues: [{ code: "finalize.retry-conflict", message: "Finalize retry changed a committed precondition." }] };
      }
      if (record.status === "aborted") {
        return { status: "rejected", issues: [{ code: record.abort?.code ?? "transaction.aborted", message: record.abort?.message ?? "Transaction is aborted." }], lastGood: await this.#lastGood(record.input) };
      }

      const issues: RuntimeValidationIssue[] = [];
      if (Object.keys(record.buffered).length > 0 || normalized.finalOperationSequence !== record.nextSequence - 1) {
        issues.push({ code: "finalize.incomplete-stream", message: "Operation stream has gaps, blocked dependencies, or an incorrect final sequence." });
      }
      if (normalized.expectedOverlayHash !== record.overlayHash) {
        issues.push({ code: "finalize.overlay-mismatch", message: "Finalize overlay precondition does not match." });
      }
      const parsed = documentContentSchema.safeParse(record.draft);
      if (!parsed.success) issues.push({ code: "finalize.document-invalid", message: parsed.error.message });
      if (parsed.success) {
        for (const [nodeId, node] of Object.entries(parsed.data.nodes)) {
          issues.push(...await this.#validation.validateNode({
            nodeId: nodeId as NodeId,
            node,
            document: parsed.data,
            phase: "commit",
          }));
        }
        issues.push(...await this.#validation.validateDocument({ document: parsed.data, phase: "commit" }));
      }
      const content = parsed.success ? parsed.data : undefined;
      const contentHash = content ? await hashDocumentContent(content, this.#hashProvider) : undefined;
      if (contentHash !== normalized.expectedContentHash) {
        issues.push({ code: "finalize.content-hash-mismatch", message: "Final document content hash does not match the compiler precondition." });
      }
      if (issues.length > 0 || !content || !contentHash) {
        record.status = "aborted";
        record.abort = { code: issues[0]?.code ?? "finalize.rejected", message: issues.map((issue) => issue.message).join("; ") };
        const saved = await this.#store.compareAndSetTransaction(normalized.transactionId, versioned.version, record);
        if (saved === "conflict") continue;
        return { status: "rejected", issues, lastGood: await this.#lastGood(record.input) };
      }

      const revision = committedRevisionSchema.parse({
        envelope: {
          documentId: record.input.documentId,
          revisionId: record.input.targetRevisionId,
          parentRevisionIds: [record.input.baseRevisionId],
          contentHash,
          hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
          migrationReceiptIds: record.input.migrationReceiptIds ?? [],
          createdAt: record.input.createdAt,
          createdBy: record.input.createdBy,
        },
        content,
      });
      const expectedHead: BranchHead = {
        documentId: record.input.documentId,
        branchId: record.input.branchId,
        revisionId: record.input.baseRevisionId,
        headToken: record.input.expectedHeadToken,
      };
      const nextHead: BranchHead = {
        documentId: record.input.documentId,
        branchId: record.input.branchId,
        revisionId: record.input.targetRevisionId,
        headToken: record.input.nextHeadToken,
      };
      record.status = "committed";
      record.committedRevision = revision;
      const committed = await this.#store.commitTransactionRevision({
        transactionId: normalized.transactionId,
        expectedTransactionVersion: versioned.version,
        transaction: record,
        expectedHead,
        nextHead,
        revision: { revision, entityRevisions: record.entityRevisions },
      });
      if (committed.status === "transaction-conflict") continue;
      if (committed.status !== "committed") {
        record.status = "aborted";
        delete record.committedRevision;
        record.abort = { code: `commit.${committed.status}`, message: "Branch compare-and-set failed; draft was not committed." };
        await this.#store.compareAndSetTransaction(normalized.transactionId, versioned.version, record);
        return {
          status: "conflict",
          issues: [{ code: record.abort.code, message: record.abort.message }],
          lastGood: committed.status === "head-conflict"
            ? await revisionFromHead(this.#store, committed.current)
            : await this.#lastGood(record.input),
        };
      }
      return { status: "committed", revision, consumedOverlayHash: record.overlayHash };
    }
    return { status: "conflict", issues: [{ code: "transaction.concurrent-conflict", message: "Transaction changed concurrently too many times." }] };
  }

  async abort(transactionId: TransactionId, code = "transaction.cancelled"): Promise<AbortTransactionResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const versioned = await this.#store.getTransaction(transactionId);
      if (!versioned) return { status: "replayed" };
      const record = cloneCanonical(versioned.value);
      if (record.status === "committed") return { status: "already-committed", lastGood: record.committedRevision };
      if (record.status === "aborted") return { status: "replayed", lastGood: await this.#lastGood(record.input) };
      record.status = "aborted";
      record.abort = { code, message: "Transaction was aborted." };
      const saved = await this.#store.compareAndSetTransaction(transactionId, versioned.version, record);
      if (saved === "conflict") continue;
      return { status: "aborted", lastGood: await this.#lastGood(record.input) };
    }
    return { status: "replayed" };
  }

  async getTransaction(transactionId: TransactionId): Promise<RuntimeTransactionRecord | undefined> {
    return (await this.#store.getTransaction(transactionId))?.value;
  }

  async #lastGood(input: BeginTransactionInput): Promise<CommittedRevision | undefined> {
    const head = await this.#store.getBranchHead(input.documentId, input.branchId);
    return await revisionFromHead(this.#store, head)
      ?? (await this.#store.getRevision(input.documentId, input.baseRevisionId))?.revision;
  }
}

function findOperation(
  record: RuntimeTransactionRecord,
  operationId: CanonicalOperationEnvelope["operationId"],
): PendingOperation | undefined {
  const applied = record.applied.find((candidate) => candidate.envelope.operationId === operationId);
  if (applied) return applied;
  return Object.values(record.buffered).find((pending) => pending.envelope.operationId === operationId);
}

function sameEnvelope(left: CanonicalOperationEnvelope, right: CanonicalOperationEnvelope): boolean {
  return left.payloadHash === right.payloadHash && canonicalStringify(left) === canonicalStringify(right);
}

function mergeIdentityMap(identityMap: TransactionIdentityMap, delta: TransactionIdentityMapDelta): boolean {
  for (const entry of delta) {
    const key = toProposalEntityKey(entry.kind, entry.localId);
    const ref = { kind: entry.kind, id: entry.canonicalId } as CanonicalEntityRef;
    const previous = identityMap[key];
    if (previous && canonicalStringify(previous) !== canonicalStringify(ref)) return false;
    identityMap[key] = ref;
  }
  return true;
}

async function revisionFromHead(
  store: RuntimeStorePort<RuntimeTransactionRecord>,
  head: BranchHead | undefined,
): Promise<CommittedRevision | undefined> {
  if (!head) return undefined;
  return (await store.getRevision(head.documentId, head.revisionId))?.revision;
}

const BEGIN_TRANSACTION_KEYS = new Set([
  "transactionId",
  "surfaceSessionId",
  "documentId",
  "branchId",
  "baseRevisionId",
  "expectedHeadToken",
  "targetRevisionId",
  "nextHeadToken",
  "createdAt",
  "createdBy",
  "migrationReceiptIds",
]);

const FINALIZE_TRANSACTION_KEYS = new Set([
  "transactionId",
  "finalOperationSequence",
  "expectedContentHash",
  "expectedOverlayHash",
]);

function parseBeginTransactionInput(input: unknown): BeginTransactionInput {
  const value = exactRecord(input, BEGIN_TRANSACTION_KEYS, "transaction begin input");
  const migrationReceiptIds = revisionEnvelopeSchema.shape.migrationReceiptIds.parse(
    value.migrationReceiptIds ?? [],
  );
  const parsed: BeginTransactionInput = {
    transactionId: transactionIdSchema.parse(value.transactionId),
    surfaceSessionId: surfaceSessionIdSchema.parse(value.surfaceSessionId),
    documentId: documentIdSchema.parse(value.documentId),
    branchId: branchIdSchema.parse(value.branchId),
    baseRevisionId: revisionIdSchema.parse(value.baseRevisionId),
    expectedHeadToken: headTokenSchema.parse(value.expectedHeadToken),
    targetRevisionId: revisionIdSchema.parse(value.targetRevisionId),
    nextHeadToken: headTokenSchema.parse(value.nextHeadToken),
    createdAt: isoTimestampSchema.parse(value.createdAt),
    createdBy: actorAuditRefSchema.parse(value.createdBy),
    ...(migrationReceiptIds.length === 0 ? {} : { migrationReceiptIds }),
  };
  if (parsed.targetRevisionId === parsed.baseRevisionId) {
    throw new TypeError("Target revision must differ from its base revision.");
  }
  return parsed;
}

function parseFinalizeTransactionInput(input: unknown): FinalizeTransactionInput {
  const value = exactRecord(input, FINALIZE_TRANSACTION_KEYS, "transaction finalize input");
  const parsed = commitCommandPayloadSchema.parse({ type: "finalize", ...value });
  if (parsed.type !== "finalize") throw new TypeError("Expected a finalize command payload.");
  if (parsed.finalOperationSequence > DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction) {
    throw new TypeError(
      `Final operation sequence exceeds the ${DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction}-operation transaction limit.`,
    );
  }
  return {
    transactionId: parsed.transactionId,
    finalOperationSequence: parsed.finalOperationSequence,
    expectedContentHash: parsed.expectedContentHash,
    ...(parsed.expectedOverlayHash === undefined ? {} : { expectedOverlayHash: parsed.expectedOverlayHash }),
  };
}

function exactRecord(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new TypeError(`${label} contains unknown fields: ${unknownKeys.sort().join(", ")}.`);
  }
  return value;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
