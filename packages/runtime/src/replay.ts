import {
  DEFAULT_PROTOCOL_LIMITS,
  HASH_DOMAINS,
  canonicalEncode,
  canonicalStringify,
  createDiagnostic,
  hashCanonical,
  stateValueSnapshotSchema,
  surfaceEventEnvelopeSchema,
  toProposalEntityKey,
  verifyCommittedRevision,
  verifySurfaceEventEnvelope,
  type ActionId,
  type ActionInvocationStatus,
  type ActionStatus,
  type CanonicalEntityRef,
  type CanonicalNode,
  type Diagnostic,
  type DocumentContent,
  type EffectReceipt,
  type EventId,
  type HashProvider,
  type JsonValue,
  type NodeId,
  type ResourceBindingId,
  type Sha256Hash,
  type StateId,
  type StreamId,
  type StreamPolicy,
  type SurfaceEventEnvelope,
  type SurfaceEventPayload,
  type SurfaceSessionId,
  type SurfaceSnapshot,
  type TransactionId,
  type TransactionIdentityMap,
  type ValidatedPreview,
} from "@open-generative/protocol";
import { applyCanonicalOperationUnchecked } from "./document-operations";
import { verifyValidatedPreviewHash } from "./preview";
import { immutableClone } from "./utils";

export type SurfacePreviewOverlay = {
  transactionId: TransactionId;
  baseRevisionId: ValidatedPreview["baseRevisionId"];
  overlaySequence: number;
  overlayHash: Sha256Hash;
  identityMap: TransactionIdentityMap;
  document: DocumentContent;
  renderableNodeIds: ValidatedPreview["renderableNodeIds"];
  disabledActionIds: ValidatedPreview["disabledActionIds"];
};

type BufferedSurfaceEvent = {
  envelope: SurfaceEventEnvelope;
  fingerprint: Sha256Hash;
  byteLength: number;
};

type SnapshotPublishedEvent = SurfaceEventEnvelope<
  Extract<SurfaceEventPayload, { type: "snapshot-published" }>
>;

export type SurfaceReplayState = {
  surfaceSessionId?: SurfaceSessionId;
  streamId?: StreamId;
  epoch?: number;
  acceptedThroughSequence: number;
  cursor?: SurfaceEventEnvelope["cursor"];
  audienceBindingHash?: Sha256Hash;
  contractSetHash?: Sha256Hash;
  streamPolicy?: StreamPolicy;
  lastGood?: SurfaceSnapshot;
  overlays: Record<TransactionId, SurfacePreviewOverlay>;
  overlayOrder: TransactionId[];
  effectReceipts: Record<string, EffectReceipt>;
  buffered: Record<string, BufferedSurfaceEvent>;
  bufferedBytes: number;
  eventFingerprints: Record<EventId, Sha256Hash>;
  eventSequences: Record<EventId, number>;
  sequenceFingerprints: Record<string, Sha256Hash>;
  diagnostics: Diagnostic[];
  requiresSnapshot: boolean;
};

export type SurfaceReplayOptions = {
  hashProvider?: HashProvider;
  maxDiagnostics?: number;
  maxRememberedEvents?: number;
};

export type SurfaceReplayResult = {
  status: "applied" | "buffered" | "replayed" | "rejected" | "resync-required";
  state: Readonly<SurfaceReplayState>;
  issues: readonly Diagnostic[];
};

export type RenderableNodeProjection = {
  node: Readonly<CanonicalNode>;
  projectionMode: "committed" | "read-only-preview";
};

export function createSurfaceReplayState(): Readonly<SurfaceReplayState> {
  return immutableClone({
    acceptedThroughSequence: 0,
    overlays: {} as Record<TransactionId, SurfacePreviewOverlay>,
    overlayOrder: [],
    effectReceipts: {},
    buffered: {},
    bufferedBytes: 0,
    eventFingerprints: {} as Record<EventId, Sha256Hash>,
    eventSequences: {} as Record<EventId, number>,
    sequenceFingerprints: {},
    diagnostics: [],
    requiresSnapshot: false,
  });
}

export async function reduceTrustedSurfaceEvent(
  sourceInput: Readonly<SurfaceReplayState>,
  input: unknown,
  options: SurfaceReplayOptions = {},
): Promise<SurfaceReplayResult> {
  const parsed = surfaceEventEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return reject(sourceInput, diagnostic(
      "stream.envelope-invalid",
      parsed.error.message,
    ), options, false);
  }
  const event = parsed.data;
  if (!await verifySurfaceEventEnvelope(event, options.hashProvider)) {
    return reject(sourceInput, diagnostic(
      "stream.payload-tampered",
      "Surface event payload hash does not match its canonical payload.",
      event,
    ), options, true);
  }
  const fingerprint = await hashCanonical(HASH_DOMAINS.operationPayload, event, options.hashProvider);
  if (
    sourceInput.surfaceSessionId !== undefined
    && sourceInput.surfaceSessionId !== event.surfaceSessionId
  ) {
    return reject(sourceInput, diagnostic(
      "stream.surface-mismatch",
      "Surface event belongs to another Surface session.",
      event,
    ), options, true);
  }

  const isSnapshot = event.payload.type === "snapshot-published";
  const streamChanged = sourceInput.streamId !== undefined && sourceInput.streamId !== event.streamId;
  const epochChanged = sourceInput.epoch !== undefined && sourceInput.epoch !== event.epoch;
  const sameLineage = !streamChanged && !epochChanged && !sourceInput.requiresSnapshot;
  if (sameLineage) {
    const rememberedEvent = sourceInput.eventFingerprints[event.eventId];
    if (rememberedEvent !== undefined) {
      return rememberedEvent === fingerprint
        ? replayed(sourceInput)
        : reject(sourceInput, diagnostic(
            "stream.event-id-reused",
            "Surface event ID was reused with different canonical bytes.",
            event,
          ), options, true);
    }
    const rememberedSequence = sourceInput.sequenceFingerprints[String(event.sequence)];
    if (rememberedSequence !== undefined) {
      return rememberedSequence === fingerprint
        ? replayed(sourceInput)
        : reject(sourceInput, diagnostic(
            "stream.sequence-reused",
            "Surface stream sequence was reused with a different event.",
            event,
          ), options, true);
    }
  }
  if (
    sourceInput.streamId === undefined
    || sourceInput.epoch === undefined
    || sourceInput.requiresSnapshot
    || streamChanged
    || epochChanged
  ) {
    if (!isSnapshot) {
      const code = epochChanged ? "stream.epoch-changed" : streamChanged
        ? "stream.identity-changed" : "stream.snapshot-required";
      return reject(sourceInput, diagnostic(
        code,
        "A trusted full snapshot is required before this Surface event can be applied.",
        event,
      ), options, true);
    }
    return replaceFromSnapshot(sourceInput, event as SnapshotPublishedEvent, fingerprint, options);
  }

  if (
    sourceInput.audienceBindingHash !== event.audienceBindingHash
    || sourceInput.contractSetHash !== event.contractSetHash
  ) {
    return isSnapshot
      ? replaceFromSnapshot(sourceInput, event as SnapshotPublishedEvent, fingerprint, options)
      : reject(sourceInput, diagnostic(
          "stream.binding-changed",
          "Audience or Contract-set binding changed without a full snapshot.",
          event,
        ), options, true);
  }

  const expected = sourceInput.acceptedThroughSequence + 1;
  if (event.sequence < expected) {
    return reject(sourceInput, diagnostic(
      "stream.stale-unverifiable",
      "A stale event fell outside the retained idempotency window.",
      event,
    ), options, true);
  }
  if (event.sequence > expected) {
    return bufferEvent(sourceInput, event, fingerprint, options);
  }
  return applyInSequence(sourceInput, event, fingerprint, options);
}

export async function replayTrustedSurfaceEvents(
  events: readonly unknown[],
  source: Readonly<SurfaceReplayState> = createSurfaceReplayState(),
  options: SurfaceReplayOptions = {},
): Promise<SurfaceReplayResult> {
  let state = source;
  let status: SurfaceReplayResult["status"] = "replayed";
  const issues: Diagnostic[] = [];
  for (const event of events) {
    const result = await reduceTrustedSurfaceEvent(state, event, options);
    state = result.state;
    status = result.status;
    issues.push(...result.issues);
    if (result.status === "rejected" || result.status === "resync-required") break;
  }
  return { status, state, issues: immutableClone(issues) };
}

export function latestRenderableOverlay(
  state: Readonly<SurfaceReplayState>,
): Readonly<SurfacePreviewOverlay> | undefined {
  for (let index = state.overlayOrder.length - 1; index >= 0; index -= 1) {
    const overlay = state.overlays[state.overlayOrder[index]!];
    if (
      overlay
      && overlay.baseRevisionId === state.lastGood?.revision.envelope.revisionId
    ) return overlay;
  }
  return undefined;
}

export function resolveRenderableNode(
  state: Readonly<SurfaceReplayState>,
  nodeId: NodeId,
): RenderableNodeProjection | undefined {
  const overlay = latestRenderableOverlay(state);
  if (overlay?.renderableNodeIds.includes(nodeId)) {
    const node = overlay.document.nodes[nodeId];
    return node ? { node, projectionMode: "read-only-preview" } : undefined;
  }
  const node = state.lastGood?.revision.content.nodes[nodeId];
  return node ? { node, projectionMode: "committed" } : undefined;
}

export function renderableRootNodeId(
  state: Readonly<SurfaceReplayState>,
): NodeId | undefined {
  const overlay = latestRenderableOverlay(state);
  if (overlay?.renderableNodeIds.includes(overlay.document.rootNodeId)) {
    return overlay.document.rootNodeId;
  }
  return state.lastGood?.revision.content.rootNodeId;
}

export async function computeStateValueHash(
  value: JsonValue,
  provider?: HashProvider,
): Promise<Sha256Hash> {
  return hashCanonical(HASH_DOMAINS.operationPayload, value, provider);
}

async function replaceFromSnapshot(
  source: Readonly<SurfaceReplayState>,
  event: SnapshotPublishedEvent,
  fingerprint: Sha256Hash,
  options: SurfaceReplayOptions,
): Promise<SurfaceReplayResult> {
  const issues = await validateSnapshotEvent(event, options.hashProvider);
  if (issues.length > 0) return reject(source, issues, options, true);
  const next = baseStateFromSnapshot(source, event);
  rememberEvent(next, event, fingerprint);
  trimReplayState(next, options);
  return { status: "applied", state: immutableClone(next), issues: [] };
}

function baseStateFromSnapshot(
  source: Readonly<SurfaceReplayState>,
  event: SnapshotPublishedEvent,
): SurfaceReplayState {
  return {
    surfaceSessionId: event.surfaceSessionId,
    streamId: event.streamId,
    epoch: event.epoch,
    acceptedThroughSequence: event.sequence,
    cursor: event.cursor,
    audienceBindingHash: event.audienceBindingHash,
    contractSetHash: event.contractSetHash,
    streamPolicy: event.payload.streamPolicy,
    lastGood: event.payload.snapshot,
    overlays: {} as Record<TransactionId, SurfacePreviewOverlay>,
    overlayOrder: [],
    effectReceipts: {},
    buffered: {},
    bufferedBytes: 0,
    eventFingerprints: {} as Record<EventId, Sha256Hash>,
    eventSequences: {} as Record<EventId, number>,
    sequenceFingerprints: {},
    diagnostics: [...source.diagnostics],
    requiresSnapshot: false,
  };
}

async function bufferEvent(
  source: Readonly<SurfaceReplayState>,
  event: SurfaceEventEnvelope,
  fingerprint: Sha256Hash,
  options: SurfaceReplayOptions,
): Promise<SurfaceReplayResult> {
  const policy = source.streamPolicy;
  const gap = event.sequence - source.acceptedThroughSequence - 1;
  const byteLength = canonicalEncode(event).byteLength;
  if (
    !policy
    || gap > policy.maxSequenceGap
    || Object.keys(source.buffered).length >= DEFAULT_PROTOCOL_LIMITS.maxBufferedGapFrames
    || source.bufferedBytes + byteLength > policy.maxBufferedBytes
    || source.bufferedBytes + byteLength > DEFAULT_PROTOCOL_LIMITS.maxBufferedGapBytes
  ) {
    return reject(source, diagnostic(
      "stream.gap-limit",
      "Surface event gap exceeds the negotiated buffering policy; a snapshot is required.",
      event,
    ), options, true);
  }
  const next = mutableClone(source);
  next.buffered[String(event.sequence)] = { envelope: event, fingerprint, byteLength };
  next.bufferedBytes += byteLength;
  rememberEvent(next, event, fingerprint);
  trimReplayState(next, options);
  return { status: "buffered", state: immutableClone(next), issues: [] };
}

async function applyInSequence(
  source: Readonly<SurfaceReplayState>,
  firstEvent: SurfaceEventEnvelope,
  firstFingerprint: Sha256Hash,
  options: SurfaceReplayOptions,
): Promise<SurfaceReplayResult> {
  const next = mutableClone(source);
  let event = firstEvent;
  let fingerprint = firstFingerprint;
  while (true) {
    const issues = await applyPayload(next, event, options.hashProvider);
    if (issues.length > 0) return reject(next, issues, options, true);
    next.acceptedThroughSequence = event.sequence;
    next.cursor = event.cursor;
    rememberEvent(next, event, fingerprint);

    const buffered = next.buffered[String(next.acceptedThroughSequence + 1)];
    if (!buffered) break;
    delete next.buffered[String(buffered.envelope.sequence)];
    next.bufferedBytes -= buffered.byteLength;
    event = buffered.envelope;
    fingerprint = buffered.fingerprint;
  }
  trimReplayState(next, options);
  return { status: "applied", state: immutableClone(next), issues: [] };
}

async function applyPayload(
  state: SurfaceReplayState,
  event: SurfaceEventEnvelope,
  provider?: HashProvider,
): Promise<Diagnostic[]> {
  const envelopeIssue = validateEnvelopeContinuity(state, event);
  if (envelopeIssue) return [envelopeIssue];
  const payload = event.payload;
  switch (payload.type) {
    case "snapshot-published": {
      const issues = await validateSnapshotEvent(event as SurfaceEventEnvelope<typeof payload>, provider);
      if (issues.length > 0) return issues;
      state.lastGood = payload.snapshot;
      state.streamPolicy = payload.streamPolicy;
      state.overlays = {} as Record<TransactionId, SurfacePreviewOverlay>;
      state.overlayOrder = [];
      state.effectReceipts = {};
      state.requiresSnapshot = false;
      return [];
    }
    case "preview-applied":
      return applyPreview(state, payload.preview, provider);
    case "preview-invalidated":
      return invalidatePreview(state, payload.transactionId, payload.invalidatedOverlayHash, event);
    case "revision-committed":
      return applyCommittedRevision(state, payload, event, provider);
    case "state-changed":
      return applyStateChange(state, payload, event, provider);
    case "resource-resolved":
      return applyResourceResolution(state, payload.result, event);
    case "action-accepted":
      return applyActionAccepted(state, payload.action, event);
    case "approval-requested":
      state.lastGood!.approvals = [
        ...state.lastGood!.approvals.filter((item) => item.approvalToken !== payload.approval.approvalToken),
        payload.approval,
      ];
      return [];
    case "action-status":
      {
        const previous = state.lastGood!.actions[payload.action.invocationId];
        if (!previous) {
          return [diagnostic("stream.action-status-orphan", "Action status has no accepted invocation.", event)];
        }
        const issue = validateActionStatusTransition(previous, payload.action, event);
        if (issue) return [issue];
        state.lastGood!.actions[payload.action.invocationId] = payload.action;
        return [];
      }
    case "effect-receipt": {
      if (!state.lastGood!.actions[payload.receipt.invocationId]) {
        return [diagnostic("stream.effect-receipt-orphan", "Effect receipt has no accepted invocation.", event)];
      }
      const existing = state.effectReceipts[payload.receipt.receiptId];
      if (existing && canonicalStringify(existing) !== canonicalStringify(payload.receipt)) {
        return [diagnostic("stream.effect-receipt-id-reused", "Effect receipt identity was reused with different content.", event)];
      }
      const invocationReceipt = Object.values(state.effectReceipts)
        .find((receipt) => receipt.invocationId === payload.receipt.invocationId);
      if (
        invocationReceipt
        && canonicalStringify(invocationReceipt) !== canonicalStringify(payload.receipt)
      ) {
        return [diagnostic(
          "stream.effect-receipt-invocation-reused",
          "Action invocation received more than one effect receipt.",
          event,
        )];
      }
      state.effectReceipts[payload.receipt.receiptId] = payload.receipt;
      return [];
    }
    case "rejected":
      if (payload.transactionId) removeOverlay(state, payload.transactionId);
      state.diagnostics.push(...payload.diagnostics);
      return [];
  }
}

async function validateSnapshotEvent(
  event: SnapshotPublishedEvent,
  provider?: HashProvider,
): Promise<Diagnostic[]> {
  const snapshot = event.payload.snapshot;
  const revision = snapshot.revision;
  if (!await safeVerifyRevision(revision, provider)) {
    return [diagnostic("stream.revision-hash-invalid", "Snapshot revision failed content-hash verification.", event)];
  }
  if (
    event.committedRevisionId !== revision.envelope.revisionId
    || event.contractSetHash !== revision.content.contracts.contractSetHash
  ) {
    return [diagnostic(
      "stream.snapshot-binding-mismatch",
      "Snapshot revision identity or Contract-set hash does not match its event envelope.",
      event,
    )];
  }
  for (const [stateIdText, state] of Object.entries(snapshot.state)) {
    const stateId = stateIdText as StateId;
    const definition = revision.content.stateDefinitions[stateId];
    if (
      !definition
      || state.stateId !== stateId
      || state.schemaHash !== definition.schemaHash
      || state.scope !== definition.scope
    ) {
      return [diagnostic("stream.snapshot-state-invalid", `Snapshot state ${stateId} does not match its definition.`, event)];
    }
  }
  for (const [bindingIdText, result] of Object.entries(snapshot.resources)) {
    const bindingId = bindingIdText as ResourceBindingId;
    const declaration = revision.content.resourceBindings[bindingId];
    const resultBindingId = result.status === "resolved"
      ? result.snapshot.bindingId
      : result.unavailable.bindingId;
    if (!declaration || resultBindingId !== bindingId) {
      return [diagnostic(
        "stream.snapshot-resource-invalid",
        `Snapshot resource ${bindingId} does not match the committed document.`,
        event,
      )];
    }
    if (
      result.status === "resolved"
      && declaration.schemaConstraint.compatibility === "exact"
      && result.snapshot.schemaHash !== declaration.schemaConstraint.schemaHash
    ) {
      return [diagnostic(
        "stream.snapshot-resource-schema-mismatch",
        `Snapshot resource ${bindingId} violates its exact schema constraint.`,
        event,
      )];
    }
  }
  return [];
}

function validateEnvelopeContinuity(
  state: SurfaceReplayState,
  event: SurfaceEventEnvelope,
): Diagnostic | undefined {
  if (!state.lastGood) {
    return diagnostic("stream.snapshot-required", "Surface event requires an active last-good snapshot.", event);
  }
  const payload = event.payload;
  const expectedRevisionId = payload.type === "snapshot-published"
    ? payload.snapshot.revision.envelope.revisionId
    : payload.type === "revision-committed"
      ? payload.revision.envelope.revisionId
      : state.lastGood.revision.envelope.revisionId;
  if (event.committedRevisionId !== expectedRevisionId) {
    return diagnostic(
      "stream.revision-envelope-mismatch",
      "Surface event committedRevisionId does not match the revision established by its payload.",
      event,
    );
  }
  return undefined;
}

async function applyPreview(
  state: SurfaceReplayState,
  preview: ValidatedPreview,
  provider?: HashProvider,
): Promise<Diagnostic[]> {
  if (!state.lastGood) return [diagnosticWithoutEvent("stream.snapshot-required", "Preview requires a last-good snapshot.")];
  if (
    preview.surfaceSessionId !== state.surfaceSessionId
    || preview.baseRevisionId !== state.lastGood.revision.envelope.revisionId
  ) {
    return [diagnosticWithoutEvent(
      "stream.preview-base-mismatch",
      "Preview Surface session or base revision does not match last-good.",
    )];
  }
  if (!await verifyValidatedPreviewHash(preview, provider)) {
    return [diagnosticWithoutEvent("stream.preview-hash-invalid", "Validated preview overlay hash is invalid.")];
  }
  if (!isSortedUnique(preview.renderableNodeIds) || !isSortedUnique(preview.disabledActionIds)) {
    return [diagnosticWithoutEvent(
      "stream.preview-order-invalid",
      "Preview renderable nodes and disabled actions must be sorted unique sets.",
    )];
  }

  const current = state.overlays[preview.transactionId];
  if (!current && state.overlayOrder.length > 0) {
    return [diagnosticWithoutEvent(
      "stream.preview-concurrent-forbidden",
      "A Surface can project only one active transaction overlay at a time.",
    )];
  }
  if (current) {
    if (
      preview.overlaySequence !== current.overlaySequence + 1
      || preview.previousOverlayHash !== current.overlayHash
    ) {
      return [diagnosticWithoutEvent("stream.preview-chain-broken", "Preview overlay hash chain is discontinuous.")];
    }
  } else if (preview.overlaySequence !== 1 || preview.previousOverlayHash !== undefined) {
    return [diagnosticWithoutEvent(
      "stream.preview-chain-broken",
      "First preview overlay must start at sequence 1 without a previous hash.",
    )];
  }

  const identityMap = current ? { ...current.identityMap } : {} as TransactionIdentityMap;
  const canonicalOwners = new Map<string, string>();
  for (const [localKey, ref] of Object.entries(identityMap)) {
    canonicalOwners.set(canonicalRefKey(ref), localKey);
  }
  for (const entry of preview.identityMapDelta) {
    const localKey = toProposalEntityKey(entry.kind, entry.localId);
    const ref = { kind: entry.kind, id: entry.canonicalId } as CanonicalEntityRef;
    const prior = identityMap[localKey];
    if (prior && canonicalStringify(prior) !== canonicalStringify(ref)) {
      return [diagnosticWithoutEvent("stream.preview-identity-remapped", "Preview remapped a proposal-local identity.")];
    }
    const owner = canonicalOwners.get(canonicalRefKey(ref));
    if (owner && owner !== localKey) {
      return [diagnosticWithoutEvent(
        "stream.preview-canonical-identity-reused",
        "Preview assigned one canonical identity to multiple proposal-local identities.",
      )];
    }
    identityMap[localKey] = ref;
    canonicalOwners.set(canonicalRefKey(ref), localKey);
  }

  let document = current?.document ?? state.lastGood.revision.content;
  for (const operation of preview.operations) {
    document = applyCanonicalOperationUnchecked(document, operation);
  }
  for (const nodeId of preview.renderableNodeIds) {
    if (!document.nodes[nodeId]) {
      return [diagnosticWithoutEvent(
        "stream.preview-renderable-node-missing",
        `Preview declares missing renderable node ${nodeId}.`,
      )];
    }
  }
  for (const actionId of preview.disabledActionIds) {
    if (!document.actions[actionId]) {
      return [diagnosticWithoutEvent(
        "stream.preview-disabled-action-missing",
        `Preview declares missing disabled action ${actionId}.`,
      )];
    }
  }
  const expectedDisabledActionIds = [...new Set(preview.renderableNodeIds.flatMap((nodeId) => (
    Object.values(document.nodes[nodeId]!.events)
  )))].sort();
  if (canonicalStringify(expectedDisabledActionIds) !== canonicalStringify(preview.disabledActionIds)) {
    return [diagnosticWithoutEvent(
      "stream.preview-disabled-actions-inexact",
      "Preview disabled actions must exactly match every event bound by its renderable nodes.",
    )];
  }

  state.overlays[preview.transactionId] = {
    transactionId: preview.transactionId,
    baseRevisionId: preview.baseRevisionId,
    overlaySequence: preview.overlaySequence,
    overlayHash: preview.overlayHash,
    identityMap,
    document,
    renderableNodeIds: preview.renderableNodeIds,
    disabledActionIds: preview.disabledActionIds,
  };
  if (!state.overlayOrder.includes(preview.transactionId)) state.overlayOrder.push(preview.transactionId);
  return [];
}

function invalidatePreview(
  state: SurfaceReplayState,
  transactionId: TransactionId,
  invalidatedOverlayHash: Sha256Hash | undefined,
  event: SurfaceEventEnvelope,
): Diagnostic[] {
  const overlay = state.overlays[transactionId];
  if (
    invalidatedOverlayHash !== undefined
    && overlay?.overlayHash !== invalidatedOverlayHash
  ) {
    return [diagnostic(
      "stream.preview-invalidation-mismatch",
      "Preview invalidation does not identify the active overlay hash.",
      event,
    )];
  }
  removeOverlay(state, transactionId);
  return [];
}

async function applyCommittedRevision(
  state: SurfaceReplayState,
  payload: Extract<SurfaceEventPayload, { type: "revision-committed" }>,
  event: SurfaceEventEnvelope,
  provider?: HashProvider,
): Promise<Diagnostic[]> {
  const lastGood = state.lastGood!;
  const currentRevisionId = lastGood.revision.envelope.revisionId;
  if (
    payload.previousRevisionId !== currentRevisionId
    || payload.revision.envelope.documentId !== lastGood.revision.envelope.documentId
  ) {
    return [diagnostic(
      "stream.commit-continuity-invalid",
      "Committed revision does not advance the active document revision.",
      event,
    )];
  }
  if (!await safeVerifyRevision(payload.revision, provider)) {
    return [diagnostic("stream.revision-hash-invalid", "Committed revision failed content-hash verification.", event)];
  }
  if (event.contractSetHash !== payload.revision.content.contracts.contractSetHash) {
    return [diagnostic(
      "stream.commit-contract-set-mismatch",
      "Committed revision Contract-set hash does not match the event envelope.",
      event,
    )];
  }
  const overlay = state.overlays[payload.transactionId];
  if (
    (overlay && payload.consumedOverlayHash !== overlay.overlayHash)
    || (!overlay && payload.consumedOverlayHash !== undefined)
  ) {
    return [diagnostic(
      "stream.commit-overlay-mismatch",
      "Revision commit does not atomically consume the active transaction overlay.",
      event,
    )];
  }

  const nextState = {} as SurfaceSnapshot["state"];
  for (const [stateIdText, snapshot] of Object.entries(lastGood.state)) {
    const stateId = stateIdText as StateId;
    const definition = payload.revision.content.stateDefinitions[stateId];
    if (
      definition
      && snapshot.schemaHash === definition.schemaHash
      && snapshot.scope === definition.scope
    ) nextState[stateId] = snapshot;
  }
  const nextResources = {} as SurfaceSnapshot["resources"];
  for (const [bindingIdText, result] of Object.entries(lastGood.resources)) {
    const bindingId = bindingIdText as ResourceBindingId;
    if (payload.revision.content.resourceBindings[bindingId]) nextResources[bindingId] = result;
  }
  state.lastGood = {
    ...lastGood,
    revision: payload.revision,
    state: nextState,
    resources: nextResources,
  };
  state.overlays = {} as Record<TransactionId, SurfacePreviewOverlay>;
  state.overlayOrder = [];
  return [];
}

async function applyStateChange(
  state: SurfaceReplayState,
  payload: Extract<SurfaceEventPayload, { type: "state-changed" }>,
  event: SurfaceEventEnvelope,
  provider?: HashProvider,
): Promise<Diagnostic[]> {
  const definition = state.lastGood!.revision.content.stateDefinitions[payload.state.stateId];
  const previous = state.lastGood!.state[payload.state.stateId];
  if (
    !definition
    || payload.state.schemaHash !== definition.schemaHash
    || payload.state.scope !== definition.scope
    || payload.receipt.stateId !== payload.state.stateId
    || payload.receipt.schemaHash !== payload.state.schemaHash
    || payload.receipt.toStateRevisionId !== payload.state.stateRevisionId
    || payload.receipt.fromStateRevisionId !== previous?.stateRevisionId
  ) {
    return [diagnostic(
      "stream.state-transition-invalid",
      "State change definition, identity, or revision precondition is invalid.",
      event,
    )];
  }
  if (payload.receipt.valueHash !== await computeStateValueHash(payload.state.value, provider)) {
    return [diagnostic("stream.state-value-hash-invalid", "State change value hash is invalid.", event)];
  }
  const parsed = stateValueSnapshotSchema.safeParse(payload.state);
  if (!parsed.success) {
    return [diagnostic("stream.state-snapshot-invalid", parsed.error.message, event)];
  }
  state.lastGood!.state[payload.state.stateId] = parsed.data;
  return [];
}

function applyResourceResolution(
  state: SurfaceReplayState,
  result: Extract<SurfaceEventPayload, { type: "resource-resolved" }>["result"],
  event: SurfaceEventEnvelope,
): Diagnostic[] {
  const bindingId = result.status === "resolved" ? result.snapshot.bindingId : result.unavailable.bindingId;
  const declaration = state.lastGood!.revision.content.resourceBindings[bindingId];
  if (!declaration) {
    return [diagnostic("stream.resource-binding-missing", "Resource result references an unknown binding.", event)];
  }
  if (
    result.status === "resolved"
    && declaration.schemaConstraint.compatibility === "exact"
    && result.snapshot.schemaHash !== declaration.schemaConstraint.schemaHash
  ) {
    return [diagnostic("stream.resource-schema-mismatch", "Resolved resource violates its exact schema constraint.", event)];
  }
  state.lastGood!.resources[bindingId] = result;
  return [];
}

function applyActionAccepted(
  state: SurfaceReplayState,
  action: Extract<SurfaceEventPayload, { type: "action-accepted" }>["action"],
  event: SurfaceEventEnvelope,
): Diagnostic[] {
  const definition = state.lastGood!.revision.content.actions[action.actionId];
  if (!definition || definition.kind !== "host-intent") {
    return [diagnostic("stream.action-definition-invalid", "Accepted action is not a committed HostIntent.", event)];
  }
  if (canonicalStringify(definition.contract) !== canonicalStringify(action.actionContract)) {
    return [diagnostic("stream.action-contract-mismatch", "Accepted action Contract does not match its definition.", event)];
  }
  const previous = state.lastGood!.actions[action.invocationId];
  if (previous) {
    return [diagnostic("stream.action-invocation-reused", "Action invocation identity was already used.", event)];
  }
  state.lastGood!.actions[action.invocationId] = {
    invocationId: action.invocationId,
    status: "accepted",
    updatedAt: action.acceptedAt,
  };
  return [];
}

const ACTION_STATUS_TRANSITIONS: Readonly<Record<ActionInvocationStatus, ReadonlySet<ActionInvocationStatus>>> = {
  accepted: new Set(["accepted", "awaiting-approval", "running", "failed", "cancelled", "cancellation-denied"]),
  "awaiting-approval": new Set(["awaiting-approval", "running", "failed", "cancelled", "cancellation-denied"]),
  running: new Set(["running", "succeeded", "failed", "cancelled", "cancellation-denied"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  "cancellation-denied": new Set(["cancellation-denied", "awaiting-approval", "running", "succeeded", "failed", "cancelled"]),
};

function validateActionStatusTransition(
  previous: ActionStatus,
  next: ActionStatus,
  event: SurfaceEventEnvelope,
): Diagnostic | undefined {
  if (!ACTION_STATUS_TRANSITIONS[previous.status].has(next.status)) {
    return diagnostic(
      "stream.action-status-regression",
      `Action status cannot transition from ${previous.status} to ${next.status}.`,
      event,
    );
  }
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
    return diagnostic(
      "stream.action-status-time-regression",
      "Action status timestamp moved backwards.",
      event,
    );
  }
  if (
    ["succeeded", "failed", "cancelled"].includes(previous.status)
    && canonicalStringify(previous) !== canonicalStringify(next)
  ) {
    return diagnostic(
      "stream.action-terminal-status-changed",
      "A terminal action status cannot be rewritten.",
      event,
    );
  }
  return undefined;
}

function removeOverlay(state: SurfaceReplayState, transactionId: TransactionId): void {
  delete state.overlays[transactionId];
  state.overlayOrder = state.overlayOrder.filter((candidate) => candidate !== transactionId);
}

function rememberEvent(
  state: SurfaceReplayState,
  event: SurfaceEventEnvelope,
  fingerprint: Sha256Hash,
): void {
  state.eventFingerprints[event.eventId] = fingerprint;
  state.eventSequences[event.eventId] = event.sequence;
  state.sequenceFingerprints[String(event.sequence)] = fingerprint;
}

function trimReplayState(state: SurfaceReplayState, options: SurfaceReplayOptions): void {
  const maxDiagnostics = options.maxDiagnostics ?? 200;
  if (!Number.isInteger(maxDiagnostics) || maxDiagnostics < 0) {
    throw new TypeError("maxDiagnostics must be a non-negative integer.");
  }
  if (state.diagnostics.length > maxDiagnostics) {
    state.diagnostics = state.diagnostics.slice(-maxDiagnostics);
  }

  const maxRemembered = options.maxRememberedEvents ?? 2_000;
  if (!Number.isInteger(maxRemembered) || maxRemembered <= 0) {
    throw new TypeError("maxRememberedEvents must be a positive integer.");
  }
  const retainedSequences = Object.keys(state.sequenceFingerprints)
    .map(Number)
    .sort((left, right) => left - right)
    .slice(-maxRemembered);
  const retained = new Set(retainedSequences);
  for (const sequence of Object.keys(state.sequenceFingerprints)) {
    if (!retained.has(Number(sequence))) delete state.sequenceFingerprints[sequence];
  }
  for (const [eventIdText, sequence] of Object.entries(state.eventSequences)) {
    if (retained.has(sequence)) continue;
    const eventId = eventIdText as EventId;
    delete state.eventSequences[eventId];
    delete state.eventFingerprints[eventId];
  }
}

function mutableClone(source: Readonly<SurfaceReplayState>): SurfaceReplayState {
  return JSON.parse(canonicalStringify(source)) as SurfaceReplayState;
}

function replayed(source: Readonly<SurfaceReplayState>): SurfaceReplayResult {
  return { status: "replayed", state: immutableClone(source), issues: [] };
}

function reject(
  source: Readonly<SurfaceReplayState>,
  issueInput: Diagnostic | readonly Diagnostic[],
  options: SurfaceReplayOptions,
  requireSnapshot: boolean,
): SurfaceReplayResult {
  const issues = Array.isArray(issueInput) ? [...issueInput] : [issueInput];
  const next = mutableClone(source);
  next.diagnostics.push(...issues);
  if (requireSnapshot) {
    next.requiresSnapshot = true;
    next.overlays = {} as Record<TransactionId, SurfacePreviewOverlay>;
    next.overlayOrder = [];
    next.buffered = {};
    next.bufferedBytes = 0;
  }
  trimReplayState(next, options);
  return {
    status: requireSnapshot ? "resync-required" : "rejected",
    state: immutableClone(next),
    issues: immutableClone(issues),
  };
}

function diagnostic(
  code: string,
  message: string,
  event?: SurfaceEventEnvelope,
): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
    ...(event ? {
      location: {
        streamId: event.streamId,
        sequence: event.sequence,
        ...(event.payload.type === "preview-applied"
          ? { transactionId: event.payload.preview.transactionId }
          : "transactionId" in event.payload && event.payload.transactionId
            ? { transactionId: event.payload.transactionId }
            : {}),
      },
    } : {}),
  });
}

function diagnosticWithoutEvent(code: string, message: string): Diagnostic {
  return diagnostic(code, message);
}

async function safeVerifyRevision(
  revision: SurfaceSnapshot["revision"],
  provider?: HashProvider,
): Promise<boolean> {
  try {
    return await verifyCommittedRevision(revision, provider);
  } catch {
    return false;
  }
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) return false;
  }
  return true;
}

function canonicalRefKey(ref: CanonicalEntityRef): string {
  return `${ref.kind}:${ref.id}`;
}
