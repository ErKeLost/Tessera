import {
  HASH_DOMAINS,
  canonicalStringify,
  hashCanonical,
  isoTimestampSchema,
  stateRevisionIdSchema,
  stateValueSnapshotSchema,
  validatedPreviewSchema,
  verifyCommittedRevision,
  type CanonicalOperationEnvelope,
  type CommittedRevision,
  type CorrelationId,
  type HashProvider,
  type ResourceBindingId,
  type StateId,
  type StateValueSnapshot,
  type SurfaceSessionId,
  type TransactionId,
  type TransactionIdentityMapDelta,
} from "@open-generative/protocol";
import type {
  AbortTransactionResult,
  ApplyOperationResult,
  BeginTransactionInput,
  BeginTransactionOptions,
  BeginTransactionResult,
  FinalizeTransactionInput,
  FinalizeTransactionResult,
  TransactionCallOptions,
} from "@open-generative/runtime";
import { verifyValidatedPreviewHash } from "@open-generative/runtime";
import type { RuntimeCommitPort } from "@open-generative/compiler";
import type { SurfaceSessionJournal } from "./surface-journal";
import { assertRevisionCatalogLock, SurfaceSessionError } from "./surface-session";
import type { SurfaceSessionRecord } from "./surface-store";

const DEFAULT_SURFACE_TRANSACTION_SWEEP_LIMIT = 100;
const MAX_SURFACE_TRANSACTION_SWEEP_LIMIT = 1_000;

type DeadlineRuntimeCommitPort = Readonly<{
  begin(input: BeginTransactionInput, options?: BeginTransactionOptions): Promise<BeginTransactionResult>;
  apply(
    envelope: CanonicalOperationEnvelope,
    identityMapDelta?: TransactionIdentityMapDelta,
    options?: TransactionCallOptions,
  ): Promise<ApplyOperationResult>;
  finalize(input: FinalizeTransactionInput, options?: TransactionCallOptions): Promise<FinalizeTransactionResult>;
  abort(transactionId: TransactionId, code?: string): Promise<AbortTransactionResult>;
}>;

export type RecoverSurfaceTransactionInput = Readonly<{
  at?: Date | string;
  signal?: AbortSignal;
}>;

export type RecoverSurfaceTransactionResult = Readonly<{
  surfaceSessionId: SurfaceSessionId;
  transactionId?: TransactionId;
  status: "idle" | "active" | "aborted" | "published" | "conflict";
}>;

export class SurfaceTransactionPublisher implements RuntimeCommitPort {
  readonly #journal: SurfaceSessionJournal;
  readonly #runtime: DeadlineRuntimeCommitPort;
  readonly #surfaceSessionId: SurfaceSessionId;
  readonly #correlationId: CorrelationId;
  readonly #hashProvider?: HashProvider;
  readonly #now: () => Date;

  constructor(input: Readonly<{
    journal: SurfaceSessionJournal;
    runtime: RuntimeCommitPort;
    surfaceSessionId: SurfaceSessionId;
    correlationId: CorrelationId;
    hashProvider?: HashProvider;
    now?: () => Date;
  }>) {
    this.#journal = input.journal;
    this.#runtime = input.runtime;
    this.#surfaceSessionId = input.surfaceSessionId;
    this.#correlationId = input.correlationId;
    this.#hashProvider = input.hashProvider;
    this.#now = input.now ?? (() => new Date());
  }

  async begin(
    input: BeginTransactionInput,
    options: BeginTransactionOptions = {},
  ): Promise<BeginTransactionResult> {
    let session = await this.#journal.get(this.#surfaceSessionId);
    if (!session) return { status: "rejected", message: "Surface session does not exist." };
    const now = this.#readNow();
    if (Date.parse(session.value.expiresAt) <= now.getTime()) {
      return {
        status: "rejected",
        message: "Surface session expired before transaction begin.",
        lastGood: session.value.committedRevision,
      };
    }
    if (session.value.pendingRevisionPublication) {
      if (!await this.#recoverPendingPublication(
        session.value.pendingRevisionPublication.finalize,
        options,
      )) {
        return {
          status: "conflict",
          message: "Surface has a committed Runtime revision awaiting durable publication.",
          lastGood: session.value.committedRevision,
        };
      }
      session = await this.#journal.get(this.#surfaceSessionId);
      if (!session) return { status: "rejected", message: "Surface session does not exist." };
    }
    if (
      session.value.activeTransaction
      && session.value.activeTransaction.transactionId !== input.transactionId
      && Date.parse(session.value.activeTransaction.deadlineAt) <= now.getTime()
    ) {
      await this.recover({ at: now, signal: options.signal });
      session = await this.#journal.get(this.#surfaceSessionId);
      if (!session) return { status: "rejected", message: "Surface session does not exist." };
    }
    if (
      input.surfaceSessionId !== this.#surfaceSessionId
      || input.documentId !== session.value.committedRevision.envelope.documentId
      || input.baseRevisionId !== session.value.committedRevision.envelope.revisionId
    ) {
      return {
        status: "conflict",
        message: "Transaction begin does not match the Surface last-good revision.",
        lastGood: session.value.committedRevision,
      };
    }
    if (session.value.activeTransaction !== undefined
      && session.value.activeTransaction.transactionId !== input.transactionId) {
      return {
        status: "conflict",
        message: "Surface already has an active transaction.",
        lastGood: session.value.committedRevision,
      };
    }
    const deadlineAt = earlierTimestamp(options.deadlineAt, session.value.expiresAt);
    const result = await this.#runtime.begin(input, { ...options, deadlineAt });
    if (!("transaction" in result) || result.transaction.status !== "active") return result;
    if (!await this.#trackTransaction(result.transaction)) {
      await this.#runtime.abort(input.transactionId, "surface.transaction-tracking-conflict");
      return {
        status: "conflict",
        message: "Runtime transaction could not be durably tracked by the Surface session.",
        lastGood: (await this.#journal.get(this.#surfaceSessionId))?.value.committedRevision,
      };
    }
    return result;
  }

  async apply(
    envelope: CanonicalOperationEnvelope,
    identityMapDelta?: TransactionIdentityMapDelta,
    options: TransactionCallOptions = {},
  ): Promise<ApplyOperationResult> {
    const result = await this.#runtime.apply(envelope, identityMapDelta, options);
    if (result.status === "rejected" && (
      options.signal?.aborted
      || result.message.toLowerCase().includes("deadline")
      || result.message.toLowerCase().includes("cancelled")
    )) {
      await this.#invalidate(
        envelope.transactionId,
        result.message.toLowerCase().includes("deadline") ? "timeout" : "abort",
      );
    }
    if (result.status !== "accepted") return result;
    for (const previewInput of result.previews) {
      const preview = validatedPreviewSchema.parse(previewInput);
      if (!await verifyValidatedPreviewHash(preview, this.#hashProvider)) {
        await this.#runtime.abort(envelope.transactionId, "preview.hash-invalid");
        return {
          status: "rejected",
          message: "Runtime preview failed its canonical overlay hash verification.",
        };
      }
      const published = await this.#publishPreview(preview);
      if (!published) {
        await this.#runtime.abort(envelope.transactionId, "preview.publication-conflict");
        const session = await this.#journal.get(this.#surfaceSessionId);
        return {
          status: "conflict",
          message: "Validated preview could not be published against Surface last-good.",
          ...(session ? { lastGood: session.value.committedRevision } : {}),
        };
      }
    }
    return result;
  }

  async finalize(
    input: FinalizeTransactionInput,
    options: TransactionCallOptions = {},
  ): Promise<FinalizeTransactionResult> {
    if (!await this.#prepareRevisionPublication(input)) {
      return {
        status: "conflict",
        issues: [{
          code: "surface.revision-publication-busy",
          message: "Another Runtime revision is already awaiting Surface publication.",
        }],
        lastGood: (await this.#journal.get(this.#surfaceSessionId))?.value.committedRevision,
      };
    }
    const result = await this.#runtime.finalize(input, options);
    if (!("revision" in result)) {
      const timeout = result.issues.some((issue) => issue.code.includes("timeout"));
      await this.#invalidate(
        input.transactionId,
        timeout ? "timeout" : result.status === "conflict" ? "conflict" : "reject",
      );
      return result;
    }
    const published = await this.#publishRevision(
      input.transactionId,
      result.revision,
      result.consumedOverlayHash,
    );
    if (!published) {
      return {
        status: "conflict",
        issues: [{
          code: "surface.revision-publication-conflict",
          message: "Committed Runtime revision could not be published to the Surface session.",
        }],
        lastGood: (await this.#journal.get(this.#surfaceSessionId))?.value.committedRevision,
      };
    }
    return result;
  }

  async abort(transactionId: TransactionId, code?: string): Promise<AbortTransactionResult> {
    const result = await this.#runtime.abort(transactionId, code);
    if (result.status === "already-committed" && result.lastGood) {
      const session = await this.#journal.get(this.#surfaceSessionId);
      const consumedOverlayHash = session?.value.activePreview?.transactionId === transactionId
        ? session.value.activePreview.overlayHash
        : undefined;
      await this.#publishRevision(transactionId, result.lastGood, consumedOverlayHash);
      return result;
    }
    await this.#invalidate(transactionId, code?.includes("timeout") ? "timeout" : "abort");
    return result;
  }

  async recover(
    input: RecoverSurfaceTransactionInput = {},
  ): Promise<RecoverSurfaceTransactionResult> {
    const at = parseRecoveryTime(input.at, this.#now);
    input.signal?.throwIfAborted();
    const session = await this.#journal.get(this.#surfaceSessionId);
    if (!session?.value.activeTransaction) {
      return { surfaceSessionId: this.#surfaceSessionId, status: "idle" };
    }
    const transactionId = session.value.activeTransaction.transactionId;
    if (session.value.pendingRevisionPublication) {
      const published = await this.#recoverPendingPublication(
        session.value.pendingRevisionPublication.finalize,
        { signal: input.signal },
      );
      return {
        surfaceSessionId: this.#surfaceSessionId,
        transactionId,
        status: published ? "published" : "conflict",
      };
    }
    if (Date.parse(session.value.activeTransaction.deadlineAt) > at.getTime()) {
      return { surfaceSessionId: this.#surfaceSessionId, transactionId, status: "active" };
    }
    const result = await this.abort(transactionId, "transaction.timeout");
    const cleaned = await this.#journal.get(this.#surfaceSessionId);
    return {
      surfaceSessionId: this.#surfaceSessionId,
      transactionId,
      status: result.status === "already-committed"
        && cleaned?.value.activeTransaction === undefined
        ? "published"
        : cleaned?.value.activeTransaction === undefined
          ? "aborted"
          : "conflict",
    };
  }

  async #trackTransaction(transaction: Readonly<{
    input: BeginTransactionInput;
    startedAt: string;
    deadlineAt: string;
  }>): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current) return false;
      const active = current.value.activeTransaction;
      if (active) {
        return active.transactionId === transaction.input.transactionId
          && active.startedAt === transaction.startedAt
          && active.deadlineAt === transaction.deadlineAt;
      }
      if (current.value.pendingRevisionPublication) return false;
      const next = structuredClone(current.value);
      next.activeTransaction = {
        transactionId: transaction.input.transactionId,
        startedAt: transaction.startedAt,
        deadlineAt: transaction.deadlineAt,
      };
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [],
      });
      if (committed.status === "conflict") continue;
      return committed.status === "committed";
    }
    return false;
  }

  async #prepareRevisionPublication(input: FinalizeTransactionInput): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current) return false;
      const pending = current.value.pendingRevisionPublication;
      if (pending) return canonicalStringify(pending.finalize) === canonicalStringify(input);
      if (
        current.value.activeTransaction?.transactionId !== input.transactionId
        || (
          current.value.activePreview?.transactionId !== undefined
          && current.value.activePreview.transactionId !== input.transactionId
        )
      ) return false;
      const next = structuredClone(current.value);
      next.pendingRevisionPublication = { finalize: structuredClone(input) };
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [],
      });
      if (committed.status === "conflict") continue;
      return committed.status === "committed";
    }
    return false;
  }

  async #recoverPendingPublication(
    input: FinalizeTransactionInput,
    options: TransactionCallOptions = {},
  ): Promise<boolean> {
    const result = await this.#runtime.finalize(input, options);
    if (!("revision" in result)) {
      const timeout = result.issues.some((issue) => issue.code.includes("timeout"));
      await this.#invalidate(
        input.transactionId,
        timeout ? "timeout" : result.status === "conflict" ? "conflict" : "reject",
      );
      return false;
    }
    return this.#publishRevision(input.transactionId, result.revision, result.consumedOverlayHash);
  }

  async #publishPreview(preview: ReturnType<typeof validatedPreviewSchema.parse>): Promise<boolean> {
    if (
      preview.surfaceSessionId !== this.#surfaceSessionId
      || preview.transactionId === undefined
    ) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current || current.value.committedRevision.envelope.revisionId !== preview.baseRevisionId) return false;
      if (current.value.activeTransaction?.transactionId !== preview.transactionId) return false;
      const active = current.value.activePreview;
      if (active?.transactionId !== undefined && active.transactionId !== preview.transactionId) return false;
      if (active) {
        if (
          preview.overlaySequence < active.overlaySequence
          || (preview.overlaySequence === active.overlaySequence && preview.overlayHash !== active.overlayHash)
        ) return false;
        if (preview.overlaySequence === active.overlaySequence && preview.overlayHash === active.overlayHash) return true;
        if (preview.previousOverlayHash !== active.overlayHash) return false;
      } else if (preview.previousOverlayHash !== undefined) {
        return false;
      }
      const next = structuredClone(current.value);
      next.activePreview = {
        transactionId: preview.transactionId,
        overlayHash: preview.overlayHash,
        overlaySequence: preview.overlaySequence,
      };
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [{
          correlationId: this.#correlationId,
          payload: { type: "preview-applied", preview },
        }],
      });
      if (committed.status === "conflict") continue;
      return committed.status === "committed";
    }
    return false;
  }

  async #publishRevision(
    transactionId: TransactionId,
    revision: CommittedRevision,
    consumedOverlayHash?: ReturnType<typeof validatedPreviewSchema.parse>["overlayHash"],
  ): Promise<boolean> {
    if (!await verifyCommittedRevision(revision, this.#hashProvider)) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current) return false;
      const pending = current.value.pendingRevisionPublication;
      if (pending && pending.finalize.transactionId !== transactionId) return false;
      if (current.value.committedRevision.envelope.revisionId === revision.envelope.revisionId) {
        if (canonicalStringify(current.value.committedRevision) !== canonicalStringify(revision)) return false;
        if (!pending && current.value.activeTransaction?.transactionId !== transactionId) return true;
        const next = structuredClone(current.value);
        if (next.activeTransaction?.transactionId === transactionId) delete next.activeTransaction;
        if (next.activePreview?.transactionId === transactionId) delete next.activePreview;
        delete next.pendingRevisionPublication;
        const cleared = await this.#journal.commit({
          surfaceSessionId: this.#surfaceSessionId,
          expectedVersion: current.version,
          next,
          events: [],
        });
        if (cleared.status === "conflict") continue;
        return cleared.status === "committed";
      }
      const previousRevisionId = current.value.committedRevision.envelope.revisionId;
      if (!revision.envelope.parentRevisionIds.includes(previousRevisionId)) return false;
      if (current.value.activePreview?.transactionId !== undefined
        && current.value.activePreview.transactionId !== transactionId) return false;
      if (current.value.activePreview && current.value.activePreview.overlayHash !== consumedOverlayHash) return false;
      try {
        assertRevisionCatalogLock(revision, current.value.catalogSlice);
      } catch (error) {
        if (error instanceof SurfaceSessionError) return false;
        throw error;
      }
      const next = structuredClone(current.value);
      next.committedRevision = revision;
      delete next.activeTransaction;
      delete next.activePreview;
      delete next.pendingRevisionPublication;
      next.state = await reconcileState(next, revision, this.#hashProvider);
      const resourceState = reconcileResources(current.value, revision);
      next.resources = resourceState.resources;
      next.resourceResolutionIdentities = resourceState.identities;
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [{
          correlationId: this.#correlationId,
          payload: {
            type: "revision-committed",
            transactionId,
            previousRevisionId,
            ...(consumedOverlayHash ? { consumedOverlayHash } : {}),
            revision,
          },
        }],
      });
      if (committed.status === "conflict") continue;
      return committed.status === "committed";
    }
    return false;
  }

  async #invalidate(
    transactionId: TransactionId,
    reason: "abort" | "reject" | "conflict" | "timeout",
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current) return;
      const ownsTransaction = current.value.activeTransaction?.transactionId === transactionId;
      const ownsPreview = current.value.activePreview?.transactionId === transactionId;
      const ownsPending = current.value.pendingRevisionPublication?.finalize.transactionId === transactionId;
      if (!ownsTransaction && !ownsPreview && !ownsPending) return;
      const next = structuredClone(current.value);
      const invalidatedOverlayHash = ownsPreview ? next.activePreview?.overlayHash : undefined;
      if (ownsTransaction) delete next.activeTransaction;
      if (ownsPreview) delete next.activePreview;
      if (ownsPending) delete next.pendingRevisionPublication;
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: ownsPreview ? [{
          correlationId: this.#correlationId,
          payload: {
            type: "preview-invalidated",
            transactionId,
            ...(invalidatedOverlayHash ? { invalidatedOverlayHash } : {}),
            reason,
          },
        }] : [],
      });
      if (committed.status !== "conflict") return;
    }
  }

  #readNow(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("Surface transaction clock must return a valid Date.");
    }
    return new Date(now.getTime());
  }
}

export type SweepSurfaceTransactionsInput = Readonly<{
  after?: SurfaceSessionId;
  limit?: number;
  at?: Date | string;
  signal?: AbortSignal;
}>;

export type SweepSurfaceTransactionsResult = Readonly<{
  checkedAt: string;
  inspected: number;
  recoveries: readonly RecoverSurfaceTransactionResult[];
  cursor?: SurfaceSessionId;
  hasMore: boolean;
}>;

export class SurfaceTransactionSweeper {
  readonly #journal: SurfaceSessionJournal;
  readonly #runtimeFor: (session: SurfaceSessionRecord) => RuntimeCommitPort | Promise<RuntimeCommitPort>;
  readonly #correlationIdFor: (session: SurfaceSessionRecord) => CorrelationId;
  readonly #hashProvider?: HashProvider;
  readonly #now: () => Date;

  constructor(input: Readonly<{
    journal: SurfaceSessionJournal;
    runtimeFor(session: SurfaceSessionRecord): RuntimeCommitPort | Promise<RuntimeCommitPort>;
    correlationIdFor(session: SurfaceSessionRecord): CorrelationId;
    hashProvider?: HashProvider;
    now?: () => Date;
  }>) {
    this.#journal = input.journal;
    this.#runtimeFor = input.runtimeFor;
    this.#correlationIdFor = input.correlationIdFor;
    this.#hashProvider = input.hashProvider;
    this.#now = input.now ?? (() => new Date());
  }

  async sweep(input: SweepSurfaceTransactionsInput = {}): Promise<SweepSurfaceTransactionsResult> {
    const at = parseRecoveryTime(input.at, this.#now);
    const limit = parseSurfaceSweepLimit(input.limit);
    input.signal?.throwIfAborted();
    const listed = await this.#journal.list({
      ...(input.after === undefined ? {} : { after: input.after }),
      limit: limit + 1,
    });
    const page = listed.slice(0, limit);
    const recoveries: RecoverSurfaceTransactionResult[] = [];
    for (const session of page) {
      input.signal?.throwIfAborted();
      if (!session.value.activeTransaction) continue;
      const shouldRecover = session.value.pendingRevisionPublication !== undefined
        || Date.parse(session.value.activeTransaction.deadlineAt) <= at.getTime();
      if (!shouldRecover) continue;
      const publisher = new SurfaceTransactionPublisher({
        journal: this.#journal,
        runtime: await this.#runtimeFor(session.value),
        surfaceSessionId: session.value.surfaceSessionId,
        correlationId: this.#correlationIdFor(session.value),
        hashProvider: this.#hashProvider,
        now: this.#now,
      });
      recoveries.push(await publisher.recover({ at, signal: input.signal }));
    }
    return Object.freeze({
      checkedAt: at.toISOString(),
      inspected: page.length,
      recoveries: Object.freeze(recoveries),
      ...(page.at(-1) ? { cursor: page.at(-1)!.value.surfaceSessionId } : {}),
      hasMore: listed.length > limit,
    });
  }
}

async function reconcileState(
  session: SurfaceSessionRecord,
  revision: CommittedRevision,
  provider?: HashProvider,
): Promise<Record<StateId, StateValueSnapshot>> {
  const entries = await Promise.all(Object.entries(revision.content.stateDefinitions).map(async ([stateIdText, definition]) => {
    const stateId = stateIdText as StateId;
    const existing = session.state[stateId];
    if (
      existing
      && existing.scope === definition.scope
      && existing.schemaHash === definition.schemaHash
    ) return [stateId, existing] as const;
    const stateRevisionId = stateRevisionIdSchema.parse(await hashCanonical(HASH_DOMAINS.operationPayload, {
      kind: "surface-revision-initial-state",
      surfaceSessionId: session.surfaceSessionId,
      revisionId: revision.envelope.revisionId,
      stateId,
      schemaHash: definition.schemaHash,
      value: definition.initial,
    }, provider));
    return [stateId, stateValueSnapshotSchema.parse({
      stateId,
      stateRevisionId,
      schemaHash: definition.schemaHash,
      scope: definition.scope,
      value: definition.initial,
    })] as const;
  }));
  return Object.fromEntries(entries) as Record<StateId, StateValueSnapshot>;
}

function reconcileResources(
  session: SurfaceSessionRecord,
  revision: CommittedRevision,
): Readonly<{
  resources: SurfaceSessionRecord["resources"];
  identities: SurfaceSessionRecord["resourceResolutionIdentities"];
}> {
  const resources = {} as SurfaceSessionRecord["resources"];
  const identities = {} as SurfaceSessionRecord["resourceResolutionIdentities"];
  for (const [bindingIdText, declaration] of Object.entries(revision.content.resourceBindings)) {
    const bindingId = bindingIdText as ResourceBindingId;
    const previousDeclaration = session.committedRevision.content.resourceBindings[bindingId];
    const previous = session.resources[bindingId];
    if (
      previous
      && previousDeclaration
      && canonicalStringify(previousDeclaration) === canonicalStringify(declaration)
    ) {
      resources[bindingId] = previous;
      const identity = session.resourceResolutionIdentities[bindingId];
      if (identity) identities[bindingId] = identity;
    }
  }
  return { resources, identities };
}

function earlierTimestamp(left: string | undefined, right: string): string {
  const rightValue = isoTimestampSchema.parse(right);
  if (left === undefined) return rightValue;
  const leftValue = isoTimestampSchema.parse(left);
  return Date.parse(leftValue) <= Date.parse(rightValue) ? leftValue : rightValue;
}

function parseRecoveryTime(input: Date | string | undefined, now: () => Date): Date {
  const value = input === undefined
    ? now()
    : typeof input === "string"
      ? new Date(isoTimestampSchema.parse(input))
      : input;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Surface transaction recovery time must be a valid Date or ISO timestamp.");
  }
  return new Date(value.getTime());
}

function parseSurfaceSweepLimit(input: number | undefined): number {
  const limit = input ?? DEFAULT_SURFACE_TRANSACTION_SWEEP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SURFACE_TRANSACTION_SWEEP_LIMIT) {
    throw new TypeError(
      `Surface transaction sweep limit must be an integer between 1 and ${MAX_SURFACE_TRANSACTION_SWEEP_LIMIT}.`,
    );
  }
  return limit;
}
