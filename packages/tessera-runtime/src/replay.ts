import type { HashProvider } from "./canonical";
import { canonicalHash, canonicalize, webCryptoSha256Provider } from "./canonical";
import { DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import { JsonSchemaContractError, parseJsonWithSchema, prepareStateSchema } from "./json-schema";
import { validateRuntimeSnapshot } from "./snapshot";
import {
  clientArtifactEventSchema,
  type ClientArtifactEvent,
  type ClientArtifactEventPayload,
  type Diagnostic,
  type DraftOperation,
  type RuntimeSnapshot,
} from "./schemas";
import type { ResumeResult } from "./store";

export type DraftPreviewState = {
  transactionId: string;
  parentRevisionIds: string[];
  previewSeq: number;
  operations: DraftOperation[];
  unresolvedIds: string[];
};

export type ClientReplayState = {
  streamId?: string;
  contractFingerprint?: string;
  acceptedThroughSeq: number;
  cursor?: string;
  lastGood?: RuntimeSnapshot;
  previews: Record<string, DraftPreviewState>;
  diagnostics: Diagnostic[];
  eventHashes: Record<string, string>;
  sequenceHashes: Record<string, string>;
};

export type ClientReplayOptions = {
  hashProvider?: HashProvider;
  maxDiagnostics?: number;
  maxRememberedEvents?: number;
};

export function createClientReplayState(snapshot?: RuntimeSnapshot): ClientReplayState {
  return {
    acceptedThroughSeq: 0,
    ...(snapshot ? { contractFingerprint: snapshot.document.revision.contractFingerprint, lastGood: snapshot } : {}),
    previews: {},
    diagnostics: [],
    eventHashes: {},
    sequenceHashes: {},
  };
}

export async function reduceClientArtifactEvent(
  source: ClientReplayState,
  input: unknown,
  options: ClientReplayOptions = {},
): Promise<ClientReplayState> {
  const parsed = clientArtifactEventSchema.safeParse(input);
  if (!parsed.success) {
    return withDiagnostics(source, diagnosticsFromZodError(parsed.error, "transport"), options.maxDiagnostics);
  }
  const event = parsed.data;
  const eventHash = await canonicalHash(event, options.hashProvider ?? webCryptoSha256Provider);

  const rememberedEventHash = source.eventHashes[event.eventId];
  if (rememberedEventHash !== undefined) {
    if (rememberedEventHash === eventHash) return cloneReplayState(source);
    return withDiagnostics(source, [fatalTransportDiagnostic(
      "stream.event-id-reused",
      "Event ID was reused with different bytes.",
      event,
    )], options.maxDiagnostics);
  }
  const rememberedSequenceHash = source.sequenceHashes[String(event.seq)];
  if (rememberedSequenceHash !== undefined) {
    if (rememberedSequenceHash === eventHash) return cloneReplayState(source);
    return withDiagnostics(source, [fatalTransportDiagnostic(
      "stream.sequence-reused",
      "Stream sequence was reused with a different event.",
      event,
    )], options.maxDiagnostics);
  }

  if (source.streamId !== undefined && source.streamId !== event.streamId) {
    return withDiagnostics(source, [fatalTransportDiagnostic(
      "stream.identity-mismatch",
      "Event belongs to another stream; use an atomic resume snapshot to replace streams.",
      event,
    )], options.maxDiagnostics);
  }
  if (
    source.contractFingerprint !== undefined
    && source.contractFingerprint !== event.contractFingerprint
  ) {
    return withDiagnostics(source, [fatalTransportDiagnostic(
      "stream.fingerprint-mismatch",
      "Event contract fingerprint differs from the active stream.",
      event,
    )], options.maxDiagnostics);
  }
  if (event.seq !== source.acceptedThroughSeq + 1) {
    return withDiagnostics(source, [createDiagnostic({
      phase: "transport",
      code: "stream.sequence-gap",
      severity: "error",
      recoverable: true,
      modelCorrectable: false,
      message: `Expected sequence ${source.acceptedThroughSeq + 1}, received ${event.seq}; resume is required.`,
      location: { streamId: event.streamId, seq: event.seq },
    })], options.maxDiagnostics);
  }

  const payloadValidation = await validateEventPayload(source, event, options.hashProvider);
  if (payloadValidation.length > 0) {
    return withDiagnostics(source, payloadValidation, options.maxDiagnostics);
  }

  const next = cloneReplayState(source);
  next.streamId = event.streamId;
  next.contractFingerprint = event.contractFingerprint;
  next.acceptedThroughSeq = event.seq;
  next.cursor = event.cursor;
  next.eventHashes[event.eventId] = eventHash;
  next.sequenceHashes[String(event.seq)] = eventHash;
  applyPayload(next, event.payload);
  trimRememberedEvents(next, options.maxRememberedEvents ?? 2_000);
  trimDiagnostics(next, options.maxDiagnostics ?? 200);
  return next;
}

export async function replayClientArtifactEvents(
  events: readonly ClientArtifactEvent[],
  base: ClientReplayState = createClientReplayState(),
  options: ClientReplayOptions = {},
): Promise<ClientReplayState> {
  let state = cloneReplayState(base);
  for (const event of events) state = await reduceClientArtifactEvent(state, event, options);
  return state;
}

export async function applyResumeResult(
  source: ClientReplayState,
  result: ResumeResult,
  options: ClientReplayOptions = {},
): Promise<ClientReplayState> {
  if (result.status === "events") return replayClientArtifactEvents(result.events, source, options);
  if (result.status === "snapshot") {
    const validation = await validateRuntimeSnapshot(result.snapshot, {
      expectedContractFingerprint: result.snapshot.document.revision.contractFingerprint,
      hashProvider: options.hashProvider,
    });
    if (!validation.success) return withDiagnostics(source, validation.diagnostics, options.maxDiagnostics);
    return {
      acceptedThroughSeq: 0,
      contractFingerprint: validation.snapshot.document.revision.contractFingerprint,
      lastGood: validation.snapshot,
      previews: {},
      diagnostics: cloneReplayState(source).diagnostics,
      eventHashes: {},
      sequenceHashes: {},
    };
  }
  return withDiagnostics(source, [createDiagnostic({
    phase: "transport",
    code: `resume.${result.status}`,
    severity: result.status === "invalid-cursor" ? "error" : "fatal",
    recoverable: result.status === "invalid-cursor",
    modelCorrectable: false,
    message: `Resume failed: ${result.status}.`,
  })], options.maxDiagnostics);
}

export function renderableSnapshot(state: ClientReplayState): RuntimeSnapshot | undefined {
  return state.lastGood;
}

function applyPayload(state: ClientReplayState, payload: ClientArtifactEventPayload): void {
  switch (payload.type) {
    case "snapshot":
      state.lastGood = payload.snapshot;
      state.previews = {};
      return;
    case "draft-preview":
      if (state.lastGood?.document.renderMode === "strict") {
        state.diagnostics.push(createDiagnostic({
          phase: "render",
          code: "preview.forbidden-in-strict-mode",
          severity: "error",
          recoverable: true,
          modelCorrectable: false,
          message: "A strict document ignored a draft preview.",
          location: { transactionId: payload.transactionId },
        }));
        return;
      }
      state.previews[payload.transactionId] = {
        transactionId: payload.transactionId,
        parentRevisionIds: payload.parentRevisionIds,
        previewSeq: payload.previewSeq,
        operations: payload.operations,
        unresolvedIds: payload.unresolvedIds,
      };
      return;
    case "committed":
      state.lastGood = payload.snapshot;
      delete state.previews[payload.transactionId];
      return;
    case "transaction-aborted":
      delete state.previews[payload.transactionId];
      state.diagnostics.push(...payload.diagnostics);
      return;
    case "reject":
      if (payload.transactionId) delete state.previews[payload.transactionId];
      state.diagnostics.push(...payload.diagnostics);
      return;
    case "state-updated":
      if (state.lastGood) {
        applyStateUpdate(state.lastGood, payload);
      }
      return;
    case "action-updated":
      if (state.lastGood) {
        state.lastGood.pendingActions = [
          ...state.lastGood.pendingActions.filter((item) => item.invocationId !== payload.action.invocationId),
          payload.action,
        ];
      }
      return;
    case "effect-updated":
      if (state.lastGood) {
        state.lastGood.pendingEffects = [
          ...state.lastGood.pendingEffects.filter((item) => item.requestId !== payload.effect.requestId),
          payload.effect,
        ];
      }
      return;
    case "approval-checkpoint":
      if (state.lastGood) {
        state.lastGood.activeApprovals = [
          ...state.lastGood.activeApprovals.filter((item) => item.checkpointId !== payload.checkpoint.checkpointId),
          payload.checkpoint,
        ];
      }
      return;
    case "resource-receipt":
      if (payload.receipt.diagnostic) state.diagnostics.push(payload.receipt.diagnostic);
      return;
    case "effect-receipt":
      if (payload.receipt.diagnostic) state.diagnostics.push(payload.receipt.diagnostic);
      return;
    case "ack":
    case "action-cancellation":
    case "effect-cancellation":
      return;
  }
}

async function validateEventPayload(
  source: ClientReplayState,
  event: ClientArtifactEvent,
  hashProvider: HashProvider | undefined,
): Promise<Diagnostic[]> {
  const { payload } = event;
  const snapshot = payload.type === "snapshot" || payload.type === "committed" ? payload.snapshot : undefined;
  if (snapshot) {
    const continuity = validateSnapshotContinuity(source.lastGood, snapshot, event);
    if (continuity.length > 0) return continuity;
    const validation = await validateRuntimeSnapshot(snapshot, {
      expectedContractFingerprint: event.contractFingerprint,
      verifyContentHash: true,
      hashProvider,
    });
    return validation.success ? [] : validation.diagnostics;
  }
  if (payload.type !== "state-updated") return [];
  if (!source.lastGood) {
    return [eventDiagnostic(
      "stream.state-without-snapshot",
      "A state update requires an active last-good snapshot.",
      event,
      payload.record.stateId,
    )];
  }

  const current = source.lastGood;
  const { record, receipt } = payload;
  const definition = current.document.state[record.stateId];
  const previous = current.state.find((item) => item.stateId === record.stateId);
  const diagnostics: Diagnostic[] = [];
  const expectedPreviousRevision = previous?.stateRevision ?? "initial";

  if (
    record.documentId !== current.document.documentId
    || record.branchId !== current.document.revision.branchId
  ) {
    diagnostics.push(eventDiagnostic(
      "stream.state-document-mismatch",
      "State update identity does not match the active document and branch.",
      event,
      record.stateId,
    ));
  }
  if (!definition) {
    diagnostics.push(eventDiagnostic(
      "stream.state-undefined",
      "State update references a state that is not defined by the active document.",
      event,
      record.stateId,
    ));
  } else {
    if (
      record.schemaId !== definition.schemaId
      || record.schemaVersion !== definition.schemaVersion
      || record.schemaHash !== definition.schemaHash
      || record.policyHash !== definition.policy.policyHash
    ) {
      diagnostics.push(eventDiagnostic(
        "stream.state-definition-mismatch",
        "State update identity does not match the active state definition.",
        event,
        record.stateId,
      ));
    }
    try {
      const prepared = await prepareStateSchema(definition);
      parseJsonWithSchema(prepared.validator, record.value);
    } catch (error) {
      diagnostics.push(eventDiagnostic(
        error instanceof JsonSchemaContractError ? error.code : "stream.state-value-invalid",
        error instanceof Error ? error.message : "State update value failed schema validation.",
        event,
        record.stateId,
      ));
    }
  }
  if (
    receipt.documentId !== record.documentId
    || receipt.branchId !== record.branchId
    || receipt.stateId !== record.stateId
    || receipt.schemaHash !== record.schemaHash
    || receipt.policyHash !== record.policyHash
  ) {
    diagnostics.push(eventDiagnostic(
      "stream.state-receipt-identity-mismatch",
      "State transition receipt identity does not match its state record.",
      event,
      record.stateId,
    ));
  }
  if (receipt.transition === "prune" || receipt.toStateRevision !== record.stateRevision) {
    diagnostics.push(eventDiagnostic(
      "stream.state-receipt-target-mismatch",
      "State transition receipt does not identify the published state revision.",
      event,
      record.stateId,
    ));
  }
  if (receipt.fromStateRevision !== expectedPreviousRevision) {
    diagnostics.push(eventDiagnostic(
      "stream.state-receipt-precondition-mismatch",
      "State transition receipt does not start from the active state revision.",
      event,
      record.stateId,
    ));
  }
  if (record.stateRevision === expectedPreviousRevision) {
    diagnostics.push(eventDiagnostic(
      "stream.state-revision-not-advanced",
      "State update must publish a revision distinct from the active state revision.",
      event,
      record.stateId,
    ));
  }
  if (receipt.transition === "reset" && definition && canonicalize(record.value) !== canonicalize(definition.initial)) {
    diagnostics.push(eventDiagnostic(
      "stream.state-reset-value-mismatch",
      "A reset transition must publish the state definition's initial value.",
      event,
      record.stateId,
    ));
  }
  if (receipt.transition === "migrate") {
    const migration = receipt.migrationReceiptId === undefined
      ? undefined
      : current.stateMigrationReceipts.find((item) => item.receiptId === receipt.migrationReceiptId);
    if (
      !migration
      || migration.documentId !== record.documentId
      || migration.branchId !== record.branchId
      || migration.stateId !== record.stateId
      || migration.key.schemaId !== record.schemaId
      || migration.key.toVersion !== record.schemaVersion
      || migration.toSchemaHash !== record.schemaHash
    ) {
      diagnostics.push(eventDiagnostic(
        "stream.state-migration-receipt-mismatch",
        "A migration transition must reference a matching state migration receipt.",
        event,
        record.stateId,
      ));
    }
  } else if (receipt.migrationReceiptId !== undefined) {
    diagnostics.push(eventDiagnostic(
      "stream.state-unexpected-migration-receipt",
      "Only a migration transition may reference a state migration receipt.",
      event,
      record.stateId,
    ));
  }
  if (current.stateTransitionReceipts.some((item) => item.receiptId === receipt.receiptId)) {
    diagnostics.push(eventDiagnostic(
      "stream.state-receipt-reused",
      "State transition receipt ID was already used in the active snapshot.",
      event,
      record.stateId,
    ));
  }
  if (current.stateTransitionReceipts.some((item) => item.operationKey === receipt.operationKey)) {
    diagnostics.push(eventDiagnostic(
      "stream.state-operation-reused",
      "State transition operation key was already used in the active snapshot.",
      event,
      record.stateId,
    ));
  }
  if (current.stateMigrationReceipts.length >= DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts) {
    diagnostics.push(eventDiagnostic(
      "stream.state-receipt-capacity-exhausted",
      "State update cannot retain its transition receipt within the active snapshot receipt limit.",
      event,
      record.stateId,
    ));
  }
  if (diagnostics.length > 0) return diagnostics;

  const candidate = cloneSnapshot(current);
  applyStateUpdate(candidate, payload);
  const validation = await validateRuntimeSnapshot(candidate, {
    expectedContractFingerprint: event.contractFingerprint,
    verifyContentHash: true,
    hashProvider,
  });
  return validation.success ? [] : validation.diagnostics;
}

function validateSnapshotContinuity(
  current: RuntimeSnapshot | undefined,
  candidate: RuntimeSnapshot,
  event: ClientArtifactEvent,
): Diagnostic[] {
  if (
    !current
    || (
      current.document.documentId === candidate.document.documentId
      && current.document.revision.branchId === candidate.document.revision.branchId
    )
  ) return [];
  return [eventDiagnostic(
    "stream.document-identity-mismatch",
    "A stream cannot switch to another document or branch without an atomic resume snapshot.",
    event,
  )];
}

function applyStateUpdate(
  snapshot: RuntimeSnapshot,
  payload: Extract<ClientArtifactEventPayload, { type: "state-updated" }>,
): void {
  snapshot.state = [
    ...snapshot.state.filter((record) => record.stateId !== payload.record.stateId),
    payload.record,
  ];
  // Migration and transition receipts share one bounded snapshot budget.
  const maxReceipts = DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts;
  const transitionCapacity = Math.max(0, maxReceipts - snapshot.stateMigrationReceipts.length);
  const transitionReceipts = [
    ...snapshot.stateTransitionReceipts,
    payload.receipt,
  ];
  snapshot.stateTransitionReceipts = transitionCapacity > 0
    ? transitionReceipts.slice(-transitionCapacity)
    : [];
}

function cloneSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return JSON.parse(canonicalize(snapshot)) as RuntimeSnapshot;
}

function withDiagnostics(
  source: ClientReplayState,
  diagnostics: Diagnostic[],
  maxDiagnostics = 200,
): ClientReplayState {
  const next = cloneReplayState(source);
  next.diagnostics.push(...diagnostics);
  trimDiagnostics(next, maxDiagnostics);
  return next;
}

function fatalTransportDiagnostic(code: string, message: string, event: ClientArtifactEvent): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
    location: { streamId: event.streamId, seq: event.seq },
  });
}

function eventDiagnostic(
  code: string,
  message: string,
  event: ClientArtifactEvent,
  stateId?: string,
): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
    location: {
      streamId: event.streamId,
      seq: event.seq,
      ...(stateId ? { entity: { kind: "state" as const, id: stateId } } : {}),
    },
  });
}

function trimRememberedEvents(state: ClientReplayState, max: number): void {
  const eventEntries = Object.entries(state.eventHashes);
  if (eventEntries.length > max) state.eventHashes = Object.fromEntries(eventEntries.slice(-max));
  const sequenceEntries = Object.entries(state.sequenceHashes);
  if (sequenceEntries.length > max) state.sequenceHashes = Object.fromEntries(sequenceEntries.slice(-max));
}

function trimDiagnostics(state: ClientReplayState, max: number): void {
  if (state.diagnostics.length > max) state.diagnostics = state.diagnostics.slice(-max);
}

function cloneReplayState(value: ClientReplayState): ClientReplayState {
  return JSON.parse(canonicalize(value)) as ClientReplayState;
}
