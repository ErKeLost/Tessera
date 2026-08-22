import {
  HASH_DOMAINS,
  canonicalStringify,
  hashCanonical,
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
  BeginTransactionResult,
  FinalizeTransactionInput,
  FinalizeTransactionResult,
} from "@open-generative/runtime";
import { verifyValidatedPreviewHash } from "@open-generative/runtime";
import type { RuntimeCommitPort } from "@open-generative/compiler";
import type { SurfaceSessionJournal } from "./surface-journal";
import { assertRevisionCatalogLock, SurfaceSessionError } from "./surface-session";
import type { SurfaceSessionRecord } from "./surface-store";

export class SurfaceTransactionPublisher implements RuntimeCommitPort {
  readonly #journal: SurfaceSessionJournal;
  readonly #runtime: RuntimeCommitPort;
  readonly #surfaceSessionId: SurfaceSessionId;
  readonly #correlationId: CorrelationId;
  readonly #hashProvider?: HashProvider;

  constructor(input: Readonly<{
    journal: SurfaceSessionJournal;
    runtime: RuntimeCommitPort;
    surfaceSessionId: SurfaceSessionId;
    correlationId: CorrelationId;
    hashProvider?: HashProvider;
  }>) {
    this.#journal = input.journal;
    this.#runtime = input.runtime;
    this.#surfaceSessionId = input.surfaceSessionId;
    this.#correlationId = input.correlationId;
    this.#hashProvider = input.hashProvider;
  }

  async begin(input: BeginTransactionInput): Promise<BeginTransactionResult> {
    const session = await this.#journal.get(this.#surfaceSessionId);
    if (!session) return { status: "rejected", message: "Surface session does not exist." };
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
    if (session.value.activePreview?.transactionId !== undefined
      && session.value.activePreview.transactionId !== input.transactionId) {
      return {
        status: "conflict",
        message: "Surface already has an active preview transaction.",
        lastGood: session.value.committedRevision,
      };
    }
    return this.#runtime.begin(input);
  }

  async apply(
    envelope: CanonicalOperationEnvelope,
    identityMapDelta?: TransactionIdentityMapDelta,
  ): Promise<ApplyOperationResult> {
    const result = await this.#runtime.apply(envelope, identityMapDelta);
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

  async finalize(input: FinalizeTransactionInput): Promise<FinalizeTransactionResult> {
    const result = await this.#runtime.finalize(input);
    if (!("revision" in result)) {
      await this.#invalidate(input.transactionId, result.status === "conflict" ? "conflict" : "reject");
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
    await this.#invalidate(transactionId, code?.includes("timeout") ? "timeout" : "abort");
    return result;
  }

  async #publishPreview(preview: ReturnType<typeof validatedPreviewSchema.parse>): Promise<boolean> {
    if (
      preview.surfaceSessionId !== this.#surfaceSessionId
      || preview.transactionId === undefined
    ) return false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(this.#surfaceSessionId);
      if (!current || current.value.committedRevision.envelope.revisionId !== preview.baseRevisionId) return false;
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
      if (current.value.committedRevision.envelope.revisionId === revision.envelope.revisionId) {
        return canonicalStringify(current.value.committedRevision) === canonicalStringify(revision);
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
      delete next.activePreview;
      next.state = await reconcileState(next, revision, this.#hashProvider);
      next.resources = reconcileResources(current.value, revision);
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
      if (!current || current.value.activePreview?.transactionId !== transactionId) return;
      const next = structuredClone(current.value);
      const invalidatedOverlayHash = next.activePreview?.overlayHash;
      delete next.activePreview;
      const committed = await this.#journal.commit({
        surfaceSessionId: this.#surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [{
          correlationId: this.#correlationId,
          payload: {
            type: "preview-invalidated",
            transactionId,
            ...(invalidatedOverlayHash ? { invalidatedOverlayHash } : {}),
            reason,
          },
        }],
      });
      if (committed.status !== "conflict") return;
    }
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
): SurfaceSessionRecord["resources"] {
  const resources = {} as SurfaceSessionRecord["resources"];
  for (const [bindingIdText, declaration] of Object.entries(revision.content.resourceBindings)) {
    const bindingId = bindingIdText as ResourceBindingId;
    const previousDeclaration = session.committedRevision.content.resourceBindings[bindingId];
    const previous = session.resources[bindingId];
    if (
      previous
      && previousDeclaration
      && canonicalStringify(previousDeclaration) === canonicalStringify(declaration)
    ) resources[bindingId] = previous;
  }
  return resources;
}
