import type { HashProvider } from "./canonical";
import { canonicalHash, canonicalize, webCryptoSha256Provider } from "./canonical";
import { ARTIFACT_PROTOCOL, ARTIFACT_PROTOCOL_VERSION, DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import { projectArtifactSemanticContent, validateArtifactDocument } from "./document";
import {
  commitCommandSchema,
  draftOperationSchema,
  proposalContextSchema,
  type ArtifactDocument,
  type ArtifactNode,
  type BranchHeadPrecondition,
  type ClientArtifactEvent,
  type CommitCommand,
  type Diagnostic,
  type DraftOperation,
  type ProposalContext,
  type ProtocolLimits,
  type RuntimeSnapshot,
  type StateRecord,
} from "./schemas";
import type {
  AppliedDraftOperation,
  ArtifactDraftContent,
  ArtifactRuntimeStorePort,
  AtomicAbortResult,
  StoredTransaction,
} from "./store";

export type NodeCommitPolicy = "progressive" | "atomic";

export type RuntimeCatalogIdentity = {
  id: string;
  version: string;
  contractFingerprint: string;
  nodeVersions?: Readonly<Record<string, number>>;
};

export type ArtifactTransactionRuntimeOptions = {
  store: ArtifactRuntimeStorePort;
  catalog: RuntimeCatalogIdentity;
  streamId?: string;
  limits?: ProtocolLimits;
  hashProvider?: HashProvider;
  now?: () => string;
  revisionIdFactory?: (transactionId: string) => string;
  stateRevisionIdFactory?: (transactionId: string, stateId: string) => string;
  nodeCommitPolicy?: (type: string, version: number) => NodeCommitPolicy;
  validateDocument?: (document: ArtifactDocument) => Diagnostic[] | Promise<Diagnostic[]>;
};

export type BeginResult =
  | { status: "begun" | "replayed"; transaction: StoredTransaction }
  | { status: "rejected"; diagnostics: Diagnostic[]; lastGood?: RuntimeSnapshot };

type TransactionFailureResult = {
  status: "aborted" | "too-late" | "rejected";
  diagnostics: Diagnostic[];
  lastGood?: RuntimeSnapshot;
  transaction?: StoredTransaction;
};

export type ApplyResult =
  | {
      status: "accepted" | "buffered" | "replayed";
      transaction: StoredTransaction;
      acceptedThroughSeq: number;
      events: ClientArtifactEvent[];
    }
  | TransactionFailureResult;

export type FinalizeResult =
  | { status: "committed" | "replayed"; snapshot: RuntimeSnapshot; event?: ClientArtifactEvent; transaction: StoredTransaction }
  | TransactionFailureResult;

export type AbortResult =
  | { status: "aborted" | "replayed"; transaction: StoredTransaction; event?: ClientArtifactEvent; lastGood?: RuntimeSnapshot }
  | { status: "too-late" | "rejected"; diagnostics: Diagnostic[]; transaction?: StoredTransaction; lastGood?: RuntimeSnapshot };

export type CommitCommandResult = BeginResult | ApplyResult | FinalizeResult | AbortResult;

export class ArtifactTransactionRuntime {
  readonly #store: ArtifactRuntimeStorePort;
  readonly #catalog: RuntimeCatalogIdentity;
  readonly #streamId: string | undefined;
  readonly #limits: ProtocolLimits;
  readonly #hashProvider: HashProvider;
  readonly #now: () => string;
  readonly #revisionIdFactory: NonNullable<ArtifactTransactionRuntimeOptions["revisionIdFactory"]>;
  readonly #stateRevisionIdFactory: NonNullable<ArtifactTransactionRuntimeOptions["stateRevisionIdFactory"]>;
  readonly #nodeCommitPolicy: NonNullable<ArtifactTransactionRuntimeOptions["nodeCommitPolicy"]>;
  readonly #validateDocument: NonNullable<ArtifactTransactionRuntimeOptions["validateDocument"]>;

  constructor(options: ArtifactTransactionRuntimeOptions) {
    this.#store = options.store;
    this.#catalog = { ...options.catalog };
    this.#streamId = options.streamId;
    this.#limits = options.limits ?? DEFAULT_PROTOCOL_LIMITS;
    this.#hashProvider = options.hashProvider ?? webCryptoSha256Provider;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#revisionIdFactory = options.revisionIdFactory ?? ((transactionId) => `revision:${transactionId}`);
    this.#stateRevisionIdFactory = options.stateRevisionIdFactory
      ?? ((transactionId, stateId) => `state:${transactionId}:${stateId}:0`);
    this.#nodeCommitPolicy = options.nodeCommitPolicy ?? (() => "atomic");
    this.#validateDocument = options.validateDocument ?? (() => []);
  }

  async initialize(): Promise<void> {
    if (this.#streamId) {
      await this.#store.createStream(this.#streamId, this.#catalog.contractFingerprint);
    }
  }

  async dispatch(input: unknown): Promise<CommitCommandResult> {
    const parsed = commitCommandSchema.safeParse(input);
    if (!parsed.success) {
      return { status: "rejected", diagnostics: diagnosticsFromZodError(parsed.error, "decode") };
    }
    const command = parsed.data;
    if (command.type === "begin") return this.begin(command.transactionId, command.context);
    if (command.type === "apply") return this.apply(command);
    if (command.type === "finalize") return this.finalize(command.transactionId, command.canonicalDraftHash);
    return this.abort(command.transactionId, command.reason);
  }

  async begin(transactionId: string, input: ProposalContext): Promise<BeginResult> {
    const parsed = proposalContextSchema.safeParse(input);
    if (!parsed.success) return { status: "rejected", diagnostics: diagnosticsFromZodError(parsed.error, "validate") };
    const context = parsed.data;
    const compatibilityDiagnostics = this.#validateContext(context, transactionId);
    if (compatibilityDiagnostics.length > 0) {
      return {
        status: "rejected",
        diagnostics: compatibilityDiagnostics,
        lastGood: await this.#lastGood(context),
      };
    }

    const contextHash = await canonicalHash(context, this.#hashProvider);
    const existing = await this.#store.getTransaction(transactionId);
    if (existing) {
      if (existing.contextHash !== contextHash) {
        return {
          status: "rejected",
          diagnostics: [fatalDiagnostic(
            "transaction.identity-reused",
            "Transaction ID was reused with a different proposal context.",
            transactionId,
          )],
          lastGood: await this.#lastGood(context),
        };
      }
      return { status: "replayed", transaction: existing };
    }

    const draft = await this.#createDraft(context);
    if ("diagnostics" in draft) {
      return { status: "rejected", diagnostics: draft.diagnostics, lastGood: await this.#lastGood(context) };
    }
    const now = this.#now();
    const transaction: StoredTransaction = {
      transactionId,
      status: "open",
      version: 0,
      context,
      contextHash,
      draft: draft.value,
      acceptedThroughSeq: 0,
      applied: [],
      buffered: {},
      bufferedBytes: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.#store.createTransaction(transaction);
    if (created.status === "exists" && created.transaction.contextHash !== contextHash) {
      return {
        status: "rejected",
        diagnostics: [fatalDiagnostic(
          "transaction.identity-reused",
          "Transaction ID was concurrently reused with a different proposal context.",
          transactionId,
        )],
        lastGood: await this.#lastGood(context),
      };
    }
    return {
      status: created.status === "created" ? "begun" : "replayed",
      transaction: created.transaction,
    };
  }

  async apply(command: Extract<CommitCommand, { type: "apply" }>): Promise<ApplyResult> {
    const operation = draftOperationSchema.safeParse(command.operation);
    if (!operation.success) {
      return { status: "rejected", diagnostics: diagnosticsFromZodError(operation.error, "validate") };
    }
    const calculatedHash = await canonicalHash(operation.data, this.#hashProvider);
    if (calculatedHash !== command.payloadHash) {
      return this.#abortForFailure(command.transactionId, [fatalDiagnostic(
        "operation.payload-hash-mismatch",
        "Draft operation payload hash does not match its canonical payload.",
        command.transactionId,
        command.seq,
        command.opId,
      )]);
    }

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.#store.getTransaction(command.transactionId);
      if (!current) {
        return { status: "rejected", diagnostics: [errorDiagnostic("transaction.missing", "Transaction does not exist.", command.transactionId)] };
      }
      const prior = findOperation(current, command.seq, command.opId);
      if (prior) {
        if (
          prior.seq === command.seq
          && prior.opId === command.opId
          && prior.payloadHash === command.payloadHash
          && canonicalize(prior.operation) === canonicalize(operation.data)
        ) {
          return {
            status: "replayed",
            transaction: current,
            acceptedThroughSeq: current.acceptedThroughSeq,
            events: [],
          };
        }
        return this.#abortForFailure(command.transactionId, [fatalDiagnostic(
          "operation.identity-reused",
          "Operation sequence or ID was reused with different bytes.",
          command.transactionId,
          command.seq,
          command.opId,
        )]);
      }
      if (current.status !== "open") {
        return {
          status: "too-late",
          transaction: current,
          diagnostics: [errorDiagnostic("transaction.too-late", `Transaction is already ${current.status}.`, command.transactionId)],
          lastGood: await this.#lastGood(current.context),
        };
      }
      if (this.#isExpired(current)) {
        return this.#abortForFailure(command.transactionId, [errorDiagnostic(
          "transaction.timeout",
          "Transaction exceeded its negotiated lifetime.",
          command.transactionId,
        )]);
      }

      const operationCount = current.applied.length + Object.keys(current.buffered).length;
      if (operationCount >= this.#limits.maxOperationsPerTransaction) {
        return this.#abortForFailure(command.transactionId, [errorDiagnostic(
          "transaction.operation-limit",
          `Transaction exceeds ${this.#limits.maxOperationsPerTransaction} operations.`,
          command.transactionId,
        )]);
      }
      if (command.seq <= current.acceptedThroughSeq) {
        return this.#abortForFailure(command.transactionId, [fatalDiagnostic(
          "operation.sequence-reused",
          "An accepted sequence was reused without its original operation identity.",
          command.transactionId,
          command.seq,
          command.opId,
        )]);
      }

      const record: AppliedDraftOperation = {
        seq: command.seq,
        opId: command.opId,
        payloadHash: command.payloadHash,
        operation: operation.data,
      };
      const next = cloneTransaction(current);
      let status: "accepted" | "buffered" = "buffered";
      let newlyApplied: AppliedDraftOperation[] = [];

      if (command.seq > current.acceptedThroughSeq + 1) {
        const bufferedBytes = new TextEncoder().encode(canonicalize(record)).byteLength;
        if (
          Object.keys(current.buffered).length >= this.#limits.maxBufferedGapFrames
          || current.bufferedBytes + bufferedBytes > this.#limits.maxBufferedGapBytes
        ) {
          return this.#abortForFailure(command.transactionId, [errorDiagnostic(
            "operation.gap-limit",
            "Operation gap exceeds negotiated buffering limits; resume is required.",
            command.transactionId,
            command.seq,
            command.opId,
          )]);
        }
        next.buffered[String(command.seq)] = record;
        next.bufferedBytes += bufferedBytes;
      } else {
        status = "accepted";
        newlyApplied = this.#consumeContiguous(next, record);
        const applied = this.#applyOperations(next.draft, newlyApplied, next.context);
        if ("diagnostics" in applied) {
          return this.#abortForFailure(command.transactionId, applied.diagnostics);
        }
        next.draft = applied.value;
        next.applied.push(...newlyApplied);
        next.acceptedThroughSeq = newlyApplied.at(-1)?.seq ?? next.acceptedThroughSeq;
      }
      next.version = current.version + 1;
      next.updatedAt = this.#now();

      const updated = await this.#store.compareAndSwapTransaction(current.transactionId, current.version, next);
      if (updated.status === "conflict") continue;
      if (updated.status === "missing") {
        return { status: "rejected", diagnostics: [errorDiagnostic("transaction.missing", "Transaction disappeared during apply.", command.transactionId)] };
      }

      const events: ClientArtifactEvent[] = [];
      if (this.#streamId) {
        await this.initialize();
        if (status === "accepted" && current.context.renderMode === "progressive") {
          const previewOperations = newlyApplied
            .map((item) => item.operation)
            .filter((item) => this.#isPreviewable(item));
          if (previewOperations.length > 0) {
            events.push(await this.#store.appendEvent(this.#streamId, {
              type: "draft-preview",
              transactionId: current.transactionId,
              parentRevisionIds: current.context.target.parentRevisionIds,
              previewSeq: updated.transaction.acceptedThroughSeq,
              operations: previewOperations,
              unresolvedIds: collectUnresolvedIds(updated.transaction.draft),
            }));
          }
        }
        events.push(await this.#store.appendEvent(this.#streamId, {
          type: "ack",
          transactionId: current.transactionId,
          acceptedThroughSeq: updated.transaction.acceptedThroughSeq,
        }));
      }
      return {
        status,
        transaction: updated.transaction,
        acceptedThroughSeq: updated.transaction.acceptedThroughSeq,
        events,
      };
    }

    return {
      status: "rejected",
      diagnostics: [errorDiagnostic("transaction.contention", "Transaction update contention exceeded the retry budget.", command.transactionId)],
    };
  }

  async finalize(transactionId: string, canonicalDraftHash: string): Promise<FinalizeResult> {
    const current = await this.#store.getTransaction(transactionId);
    if (!current) {
      return { status: "rejected", diagnostics: [errorDiagnostic("transaction.missing", "Transaction does not exist.", transactionId)] };
    }
    if (current.status === "committed") {
      if (current.committed?.canonicalDraftHash !== canonicalDraftHash || !current.committed.snapshot) {
        return {
          status: "rejected",
          transaction: current,
          diagnostics: [fatalDiagnostic("transaction.finalize-hash-reused", "Finalize was replayed with a different draft hash.", transactionId)],
          lastGood: await this.#lastGood(current.context),
        };
      }
      return {
        status: "replayed",
        transaction: current,
        snapshot: current.committed.snapshot,
        event: current.committed.event,
      };
    }
    if (current.status === "aborted") {
      return {
        status: "too-late",
        transaction: current,
        diagnostics: current.aborted?.diagnostics ?? [errorDiagnostic("transaction.too-late", "Transaction is already aborted.", transactionId)],
        lastGood: await this.#lastGood(current.context),
      };
    }
    if (Object.keys(current.buffered).length > 0) {
      return this.#abortForFailure(transactionId, [errorDiagnostic(
        "transaction.sequence-gap",
        "Transaction cannot finalize while operation sequence gaps remain.",
        transactionId,
      )]);
    }
    if (this.#isExpired(current)) {
      return this.#abortForFailure(transactionId, [errorDiagnostic("transaction.timeout", "Transaction exceeded its negotiated lifetime.", transactionId)]);
    }

    const built = await this.#buildDocument(current);
    if ("diagnostics" in built) return this.#abortForFailure(transactionId, built.diagnostics);
    if (built.contentHash !== canonicalDraftHash) {
      return this.#abortForFailure(transactionId, [fatalDiagnostic(
        "transaction.draft-hash-mismatch",
        "Finalize hash does not match independently canonicalized semantic content.",
        transactionId,
      )]);
    }

    await this.initialize();
    const target = current.context.target;
    const result = await this.#store.commitTransaction({
      transactionId,
      expectedTransactionVersion: current.version,
      canonicalDraftHash,
      document: built.document,
      expectedHeads: target.mode === "create" ? [] : target.headPreconditions,
      requireTargetBranchAbsent: target.mode === "create",
      nextState: built.nextState,
      ...(this.#streamId ? { streamId: this.#streamId } : {}),
    });

    if (result.status === "committed" || result.status === "replayed") {
      return {
        status: result.status,
        transaction: result.transaction,
        snapshot: result.snapshot,
        event: result.event,
      };
    }
    if (result.status === "too-late") {
      return {
        status: "too-late",
        transaction: result.transaction,
        diagnostics: [errorDiagnostic("transaction.too-late", "Abort won the transaction terminal-state race.", transactionId)],
        lastGood: await this.#lastGood(current.context),
      };
    }
    if (result.status === "hash-conflict") {
      return {
        status: "rejected",
        transaction: result.transaction,
        diagnostics: [fatalDiagnostic("transaction.finalize-hash-reused", "Finalize identity was reused with a different draft hash.", transactionId)],
        lastGood: await this.#lastGood(current.context),
      };
    }
    if (result.status === "transaction-conflict") {
      return this.finalize(transactionId, canonicalDraftHash);
    }
    if (result.status === "missing") {
      return { status: "rejected", diagnostics: [errorDiagnostic("transaction.missing", "Transaction disappeared during commit.", transactionId)] };
    }
    if (result.status === "state-conflict") {
      return this.#abortForFailure(transactionId, [createDiagnostic({
        phase: "commit",
        code: "commit.state-conflict",
        severity: "error",
        recoverable: true,
        modelCorrectable: false,
        message: `State preconditions failed: ${result.stateIds.join(", ")}.`,
        location: { transactionId },
      })]);
    }
    return this.#abortForFailure(transactionId, [createDiagnostic({
      phase: "commit",
      code: "commit.branch-conflict",
      severity: "error",
      recoverable: true,
      modelCorrectable: false,
      message: "One or more branch-head preconditions failed.",
      location: { transactionId },
    })]);
  }

  async abort(transactionId: string, reason?: string): Promise<AbortResult> {
    const current = await this.#store.getTransaction(transactionId);
    if (!current) {
      return { status: "rejected", diagnostics: [errorDiagnostic("transaction.missing", "Transaction does not exist.", transactionId)] };
    }
    const diagnostic = createDiagnostic({
      phase: "commit",
      code: "transaction.aborted-by-caller",
      severity: "warning",
      recoverable: true,
      modelCorrectable: false,
      message: reason ?? "Transaction was aborted by its caller.",
      location: { transactionId },
    });
    return this.#abortCurrent(current, [diagnostic], reason);
  }

  async computeDraftHash(transactionId: string): Promise<string> {
    const transaction = await this.#store.getTransaction(transactionId);
    if (!transaction) throw new Error(`Unknown transaction ${transactionId}.`);
    const built = await this.#buildDocument(transaction);
    if ("diagnostics" in built) throw new Error(built.diagnostics.map((item) => item.message).join("; "));
    return built.contentHash;
  }

  async #createDraft(
    context: ProposalContext,
  ): Promise<{ value: ArtifactDraftContent } | { diagnostics: Diagnostic[] }> {
    const target = context.target;
    if (target.mode === "create") {
      const { expiresAt: _expiresAt, ...semanticPolicy } = context.documentPolicy;
      return {
        value: {
          protocol: ARTIFACT_PROTOCOL,
          protocolVersion: ARTIFACT_PROTOCOL_VERSION,
          policy: { ...semanticPolicy, ...(context.documentPolicy.expiresAt ? { expiresAt: context.documentPolicy.expiresAt } : {}) },
          catalog: {
            id: this.#catalog.id,
            version: this.#catalog.version,
            contractFingerprint: this.#catalog.contractFingerprint,
          },
          renderMode: context.renderMode,
          nodes: {},
          state: {},
          actions: {},
          resources: {},
          evidence: {},
          claims: {},
          meta: {},
        },
      };
    }

    const parents: ArtifactDocument[] = [];
    for (const revisionId of target.parentRevisionIds) {
      const parent = await this.#store.getRevision(target.documentId, revisionId);
      if (!parent) {
        return { diagnostics: [errorDiagnostic("revision.parent-missing", `Parent revision ${revisionId} does not exist.`)] };
      }
      if (parent.revision.contractFingerprint !== context.contractFingerprint) {
        return { diagnostics: [fatalDiagnostic(
          "compatibility.parent-fingerprint-mismatch",
          `Parent revision ${revisionId} uses another contract fingerprint.`,
        )] };
      }
      parents.push(parent);
    }
    const base = parents[0]!;
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...meta } = base.meta;
    return {
      value: {
        protocol: ARTIFACT_PROTOCOL,
        protocolVersion: ARTIFACT_PROTOCOL_VERSION,
        policy: context.documentPolicy,
        catalog: {
          id: this.#catalog.id,
          version: this.#catalog.version,
          contractFingerprint: this.#catalog.contractFingerprint,
        },
        renderMode: context.renderMode,
        root: base.root,
        nodes: cloneRecord(base.nodes),
        state: cloneRecord(base.state),
        actions: cloneRecord(base.actions),
        resources: cloneRecord(base.resources),
        evidence: cloneRecord(base.evidence),
        claims: cloneRecord(base.claims),
        meta,
      },
    };
  }

  #consumeContiguous(next: StoredTransaction, first: AppliedDraftOperation): AppliedDraftOperation[] {
    const output = [first];
    let sequence = first.seq + 1;
    while (next.buffered[String(sequence)]) {
      const buffered = next.buffered[String(sequence)]!;
      output.push(buffered);
      next.bufferedBytes -= new TextEncoder().encode(canonicalize(buffered)).byteLength;
      delete next.buffered[String(sequence)];
      sequence += 1;
    }
    return output;
  }

  #applyOperations(
    source: ArtifactDraftContent,
    operations: AppliedDraftOperation[],
    context: ProposalContext,
  ): { value: ArtifactDraftContent } | { diagnostics: Diagnostic[] } {
    const draft = cloneDraft(source);
    const diagnostics: Diagnostic[] = [];

    for (const { operation } of operations) {
      switch (operation.op) {
        case "put-node":
          draft.nodes[operation.nodeId] = operation.value;
          break;
        case "remove-node":
          delete draft.nodes[operation.nodeId];
          break;
        case "put-state":
          draft.state[operation.stateId] = operation.value;
          break;
        case "remove-state":
          delete draft.state[operation.stateId];
          break;
        case "put-action":
          draft.actions[operation.actionId] = operation.value;
          break;
        case "remove-action":
          delete draft.actions[operation.actionId];
          break;
        case "put-claim":
          if (operation.value.claimId !== operation.claimId) {
            diagnostics.push(errorDiagnostic("claim.identity-mismatch", "Claim operation ID and claimId differ."));
          } else {
            draft.claims[operation.claimId] = operation.value;
          }
          break;
        case "remove-claim":
          delete draft.claims[operation.claimId];
          break;
        case "attach-resource": {
          const grant = context.resourceGrants[operation.resourceId];
          if (!grant) {
            diagnostics.push(createDiagnostic({
              phase: "policy",
              code: "resource.not-granted",
              severity: "error",
              recoverable: true,
              modelCorrectable: true,
              message: `Resource ${operation.resourceId} was not granted to this proposal.`,
              location: { entity: { kind: "resource", id: operation.resourceId } },
            }));
          } else {
            draft.resources[operation.resourceId] = grant;
          }
          break;
        }
        case "detach-resource":
          delete draft.resources[operation.resourceId];
          break;
        case "set-root":
          draft.root = operation.nodeId;
          break;
        case "set-meta":
          draft.meta = operation.value;
          break;
      }
    }
    return diagnostics.length > 0 ? { diagnostics } : { value: draft };
  }

  async #buildDocument(
    transaction: StoredTransaction,
  ): Promise<
    | { document: ArtifactDocument; contentHash: string; nextState: StateRecord[] }
    | { diagnostics: Diagnostic[] }
  > {
    if (!transaction.draft.root) {
      return { diagnostics: [errorDiagnostic("document.missing-root", "Draft does not define a root node.", transaction.transactionId)] };
    }
    const root = transaction.draft.root;
    const draft = cloneDraft(transaction.draft);
    this.#materializeEvidence(draft, transaction.context);
    const target = transaction.context.target;
    const parentDocuments: ArtifactDocument[] = [];
    for (const parentId of target.parentRevisionIds) {
      const parent = await this.#store.getRevision(target.documentId, parentId);
      if (!parent) return { diagnostics: [errorDiagnostic("revision.parent-missing", `Parent revision ${parentId} does not exist.`)] };
      parentDocuments.push(parent);
    }
    const previousSnapshot = await this.#store.readRuntimeSnapshot(target.documentId, target.branchId);
    const nextState = this.#deriveState(transaction, previousSnapshot?.state ?? []);
    if ("diagnostics" in nextState) return nextState;

    const now = this.#now();
    const revisionId = this.#revisionIdFactory(transaction.transactionId);
    const sequence = parentDocuments.length === 0
      ? 1
      : Math.max(...parentDocuments.map((parent) => parent.revision.sequence)) + 1;
    const createdAt = parentDocuments[0]?.meta.createdAt ?? now;

    const semanticContent = {
      protocol: ARTIFACT_PROTOCOL,
      protocolVersion: ARTIFACT_PROTOCOL_VERSION,
      policy: omitExpiry(draft.policy),
      catalog: draft.catalog,
      renderMode: draft.renderMode,
      root,
      nodes: draft.nodes,
      state: Object.fromEntries(Object.entries(draft.state).map(([id, definition]) => [id, {
        ...definition,
        policy: omitExpiry(definition.policy),
      }])),
      actions: draft.actions,
      resources: Object.fromEntries(Object.entries(draft.resources).map(([id, reference]) => [id, omitExpiry(reference)])),
      evidence: Object.fromEntries(Object.entries(draft.evidence).map(([id, reference]) => [id, omitEvidenceTimes(reference)])),
      claims: draft.claims,
      meta: draft.meta,
    } as const;
    const contentHash = await canonicalHash(semanticContent, this.#hashProvider);
    const document: ArtifactDocument = {
      protocol: ARTIFACT_PROTOCOL,
      protocolVersion: ARTIFACT_PROTOCOL_VERSION,
      documentId: target.documentId,
      revision: {
        revisionId,
        parentRevisionIds: [...target.parentRevisionIds],
        branchId: target.branchId,
        sequence,
        contentHash,
        contractFingerprint: transaction.context.contractFingerprint,
        migrationReceiptIds: [],
        stateTransitionReceiptIds: [],
      },
      policy: draft.policy,
      catalog: draft.catalog,
      renderMode: draft.renderMode,
      root,
      nodes: draft.nodes,
      state: draft.state,
      actions: draft.actions,
      resources: draft.resources,
      evidence: draft.evidence,
      claims: draft.claims,
      meta: { ...draft.meta, createdAt, updatedAt: now },
    };

    const documentValidation = await validateArtifactDocument(document, {
      limits: this.#limits,
      expectedContractFingerprint: this.#catalog.contractFingerprint,
      verifyContentHash: true,
      hashProvider: this.#hashProvider,
    });
    const diagnostics = documentValidation.success ? [] : [...documentValidation.diagnostics];
    diagnostics.push(...this.#inspectCatalogVersions(document, transaction.context));
    diagnostics.push(...await this.#validateDocument(document));
    const projected = projectArtifactSemanticContent(document);
    if (canonicalize(projected) !== canonicalize(semanticContent)) {
      diagnostics.push(fatalDiagnostic(
        "document.semantic-projection-drift",
        "Runtime semantic projection differs from the draft hash projection.",
        transaction.transactionId,
      ));
    }
    return diagnostics.length > 0 ? { diagnostics } : { document, contentHash, nextState: nextState.value };
  }

  #deriveState(
    transaction: StoredTransaction,
    previous: StateRecord[],
  ): { value: StateRecord[] } | { diagnostics: Diagnostic[] } {
    const byId = new Map(previous.map((record) => [record.stateId, record]));
    const output: StateRecord[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const [stateId, definition] of Object.entries(transaction.draft.state)) {
      const record = byId.get(stateId);
      if (record) {
        if (
          record.schemaId !== definition.schemaId
          || record.schemaVersion !== definition.schemaVersion
          || record.schemaHash !== definition.schemaHash
          || record.policyHash !== definition.policy.policyHash
        ) {
          diagnostics.push(createDiagnostic({
            phase: "commit",
            code: "state.migration-required",
            severity: "error",
            recoverable: true,
            modelCorrectable: false,
            message: `State ${stateId} changed schema or policy without an explicit migration.`,
            location: { transactionId: transaction.transactionId, entity: { kind: "state", id: stateId } },
          }));
          continue;
        }
        output.push(record);
      } else {
        output.push({
          documentId: transaction.context.target.documentId,
          branchId: transaction.context.target.branchId,
          stateId,
          stateRevision: this.#stateRevisionIdFactory(transaction.transactionId, stateId),
          schemaId: definition.schemaId,
          schemaVersion: definition.schemaVersion,
          schemaHash: definition.schemaHash,
          policyHash: definition.policy.policyHash,
          value: definition.initial,
        });
      }
    }
    return diagnostics.length > 0 ? { diagnostics } : { value: output };
  }

  #materializeEvidence(draft: ArtifactDraftContent, context: ProposalContext): void {
    const referenced = new Set<string>();
    for (const node of Object.values(draft.nodes)) {
      for (const evidenceId of node.evidence ?? []) referenced.add(evidenceId);
    }
    for (const claim of Object.values(draft.claims)) {
      for (const evidenceId of claim.evidenceIds) referenced.add(evidenceId);
    }
    for (const evidenceId of referenced) {
      if (!draft.evidence[evidenceId] && context.evidenceGrants[evidenceId]) {
        draft.evidence[evidenceId] = context.evidenceGrants[evidenceId];
      }
    }
  }

  #inspectCatalogVersions(document: ArtifactDocument, context: ProposalContext): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (this.#catalog.nodeVersions) {
      for (const [nodeId, node] of Object.entries(document.nodes)) {
        const selected = this.#catalog.nodeVersions[node.type];
        if (selected === undefined || selected !== node.typeVersion) {
          diagnostics.push(createDiagnostic({
            phase: "validate",
            code: "compatibility.node-version-mismatch",
            severity: "error",
            recoverable: true,
            modelCorrectable: true,
            message: `Node ${node.type}@${node.typeVersion} is not the selected catalog version.`,
            location: { entity: { kind: "node", id: nodeId } },
          }));
        }
      }
    }
    for (const [actionId, action] of Object.entries(document.actions)) {
      const selected = context.actionContractVersions[action.contractId];
      if (selected === undefined || selected !== action.contractVersion) {
        diagnostics.push(createDiagnostic({
          phase: "validate",
          code: "compatibility.action-version-mismatch",
          severity: "error",
          recoverable: true,
          modelCorrectable: true,
          message: `Action ${action.contractId}@${action.contractVersion} is not selected by the proposal context.`,
          location: { entity: { kind: "action", id: actionId } },
        }));
      }
    }
    return diagnostics;
  }

  #validateContext(context: ProposalContext, transactionId: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    if (context.contractFingerprint !== this.#catalog.contractFingerprint) {
      diagnostics.push(fatalDiagnostic(
        "compatibility.context-fingerprint-mismatch",
        "Proposal context does not match the runtime catalog fingerprint.",
        transactionId,
      ));
    }
    if (context.target.mode !== "create") {
      const targetHead = context.target.headPreconditions.find((head) => head.branchId === context.target.branchId);
      if (!targetHead) {
        diagnostics.push(fatalDiagnostic(
          "commit.target-head-precondition-missing",
          "Edit and merge targets require a precondition for the target branch.",
          transactionId,
        ));
      }
      const parentSet = new Set(context.target.parentRevisionIds);
      for (const head of context.target.headPreconditions) {
        if (!parentSet.has(head.revisionId)) {
          diagnostics.push(fatalDiagnostic(
            "commit.head-parent-mismatch",
            `Head precondition ${head.branchId} does not name a parent revision.`,
            transactionId,
          ));
        }
      }
    }
    return diagnostics;
  }

  #isExpired(transaction: StoredTransaction): boolean {
    const created = Date.parse(transaction.createdAt);
    const now = Date.parse(this.#now());
    return Number.isFinite(created) && Number.isFinite(now) && now - created > this.#limits.transactionTimeoutMs;
  }

  #isPreviewable(operation: DraftOperation): boolean {
    if (operation.op !== "put-node") return true;
    return this.#nodeCommitPolicy(operation.value.type, operation.value.typeVersion) === "progressive";
  }

  async #abortForFailure(transactionId: string, diagnostics: Diagnostic[]): Promise<TransactionFailureResult> {
    const current = await this.#store.getTransaction(transactionId);
    if (!current) return { status: "rejected", diagnostics };
    const result = await this.#abortCurrent(current, diagnostics);
    if (result.status === "rejected" || result.status === "too-late") {
      return { ...result, diagnostics: result.diagnostics };
    }
    const transaction = result.transaction ?? current;
    return {
      status: "aborted",
      transaction,
      diagnostics: transaction.aborted?.diagnostics ?? diagnostics,
      lastGood: result.lastGood,
    };
  }

  async #abortCurrent(
    current: StoredTransaction,
    diagnostics: Diagnostic[],
    reason?: string,
  ): Promise<AbortResult & { diagnostics?: Diagnostic[] }> {
    if (current.status === "committed") {
      return {
        status: "too-late",
        transaction: current,
        diagnostics: [errorDiagnostic("transaction.too-late", "Transaction is already committed.", current.transactionId)],
        lastGood: await this.#lastGood(current.context),
      };
    }
    await this.initialize();
    const result: AtomicAbortResult = await this.#store.abortTransaction({
      transactionId: current.transactionId,
      expectedTransactionVersion: current.version,
      ...(reason === undefined ? {} : { reason }),
      diagnostics,
      ...(this.#streamId ? { streamId: this.#streamId } : {}),
    });
    if (result.status === "transaction-conflict") {
      const newest = result.transaction;
      if (newest.status === "open") return this.#abortCurrent(newest, diagnostics, reason);
      if (newest.status === "committed") {
        return {
          status: "too-late",
          transaction: newest,
          diagnostics,
          lastGood: await this.#lastGood(newest.context),
        };
      }
      return {
        status: "replayed",
        transaction: newest,
        diagnostics: newest.aborted?.diagnostics,
        event: newest.aborted?.event,
        lastGood: await this.#lastGood(newest.context),
      };
    }
    if (result.status === "missing") return { status: "rejected", diagnostics };
    if (result.status === "too-late") {
      return {
        status: "too-late",
        transaction: result.transaction,
        diagnostics,
        lastGood: await this.#lastGood(result.transaction.context),
      };
    }
    return {
      status: result.status,
      transaction: result.transaction,
      diagnostics: result.transaction.aborted?.diagnostics ?? diagnostics,
      event: result.event,
      lastGood: await this.#lastGood(result.transaction.context),
    };
  }

  async #lastGood(context: ProposalContext): Promise<RuntimeSnapshot | undefined> {
    return this.#store.readRuntimeSnapshot(context.target.documentId, context.target.branchId);
  }
}

function findOperation(
  transaction: StoredTransaction,
  sequence: number,
  opId: string,
): AppliedDraftOperation | undefined {
  return transaction.applied.find((item) => item.seq === sequence || item.opId === opId)
    ?? Object.values(transaction.buffered).find((item) => item.seq === sequence || item.opId === opId);
}

function collectUnresolvedIds(draft: ArtifactDraftContent): string[] {
  const unresolved = new Set<string>();
  if (draft.root && !draft.nodes[draft.root]) unresolved.add(`node:${draft.root}`);
  for (const node of Object.values(draft.nodes)) {
    for (const children of Object.values(node.slots ?? {})) {
      for (const childId of children) if (!draft.nodes[childId]) unresolved.add(`node:${childId}`);
    }
    for (const actionId of Object.values(node.events ?? {})) {
      if (!draft.actions[actionId]) unresolved.add(`action:${actionId}`);
    }
    for (const evidenceId of node.evidence ?? []) {
      if (!draft.evidence[evidenceId]) unresolved.add(`evidence:${evidenceId}`);
    }
    collectValueReferences(node, draft, unresolved);
  }
  for (const claim of Object.values(draft.claims)) {
    if (!draft.nodes[claim.nodeId]) unresolved.add(`node:${claim.nodeId}`);
    for (const evidenceId of claim.evidenceIds) if (!draft.evidence[evidenceId]) unresolved.add(`evidence:${evidenceId}`);
  }
  return [...unresolved].sort();
}

function collectValueReferences(
  node: ArtifactNode,
  draft: ArtifactDraftContent,
  unresolved: Set<string>,
): void {
  const visit = (value: ArtifactNode["props"][string]): void => {
    if (value.kind === "state-ref" && !draft.state[value.stateId]) unresolved.add(`state:${value.stateId}`);
    else if (value.kind === "resource-ref" && !draft.resources[value.resourceId]) unresolved.add(`resource:${value.resourceId}`);
    else if (value.kind === "array") value.items.forEach(visit);
    else if (value.kind === "object") Object.values(value.entries).forEach(visit);
    else if (value.kind === "condition") value.args.forEach(visit);
  };
  Object.values(node.props).forEach(visit);
}

function cloneTransaction(value: StoredTransaction): StoredTransaction {
  return JSON.parse(canonicalize(value)) as StoredTransaction;
}

function cloneDraft(value: ArtifactDraftContent): ArtifactDraftContent {
  return JSON.parse(canonicalize(value)) as ArtifactDraftContent;
}

function cloneRecord<T>(value: Record<string, T>): Record<string, T> {
  return JSON.parse(canonicalize(value)) as Record<string, T>;
}

function omitExpiry<T extends { expiresAt?: string }>(value: T): Omit<T, "expiresAt"> {
  const { expiresAt: _expiresAt, ...rest } = value;
  return rest;
}

function omitEvidenceTimes<T extends { observedAt?: string; recordedAt: string; expiresAt?: string }>(
  value: T,
): Omit<T, "observedAt" | "recordedAt" | "expiresAt"> {
  const { observedAt: _observedAt, recordedAt: _recordedAt, expiresAt: _expiresAt, ...rest } = value;
  return rest;
}

function errorDiagnostic(
  code: string,
  message: string,
  transactionId?: string,
  seq?: number,
  opId?: string,
): Diagnostic {
  return createDiagnostic({
    phase: "commit",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
    location: transactionId ? {
      transactionId,
      ...(seq === undefined ? {} : { seq }),
      ...(opId === undefined ? {} : { opId }),
    } : undefined,
  });
}

function fatalDiagnostic(
  code: string,
  message: string,
  transactionId?: string,
  seq?: number,
  opId?: string,
): Diagnostic {
  return createDiagnostic({
    phase: "commit",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
    location: transactionId ? {
      transactionId,
      ...(seq === undefined ? {} : { seq }),
      ...(opId === undefined ? {} : { opId }),
    } : undefined,
  });
}
