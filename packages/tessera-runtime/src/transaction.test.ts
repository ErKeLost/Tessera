import { describe, expect, test } from "bun:test";
import {
  ArtifactTransactionRuntime,
  canonicalHash,
  createClientReplayState,
  DEFAULT_PROTOCOL_LIMITS,
  InMemoryArtifactRuntimeStore,
  reduceClientArtifactEvent,
  replayClientArtifactEvents,
  type ClientArtifactEvent,
  type DraftOperation,
} from "./index";
import {
  createCommittedFixture,
  createContext,
  rootNodeOperation,
  TEST_FINGERPRINT,
  TEST_TIME,
} from "./test-fixtures";

describe("transactional runtime", () => {
  test("buffers gaps, drains in order, previews progressive nodes, and commits atomically", async () => {
    const store = new InMemoryArtifactRuntimeStore({ now: () => TEST_TIME });
    const runtime = new ArtifactTransactionRuntime({
      store,
      streamId: "stream-gap",
      catalog: { id: "catalog:test", version: "1", contractFingerprint: TEST_FINGERPRINT, nodeVersions: { "layout.stack": 1 } },
      now: () => TEST_TIME,
      nodeCommitPolicy: () => "progressive",
    });
    await runtime.initialize();
    expect((await runtime.begin("tx-gap", createContext())).status).toBe("begun");
    const setRoot: DraftOperation = { op: "set-root", nodeId: "root" };
    const gap = await runtime.apply({
      type: "apply",
      transactionId: "tx-gap",
      seq: 2,
      opId: "op-2",
      payloadHash: await canonicalHash(setRoot),
      operation: setRoot,
    });
    expect(gap.status).toBe("buffered");
    if (gap.status === "buffered") expect(gap.acceptedThroughSeq).toBe(0);

    const node = rootNodeOperation();
    const drained = await runtime.apply({
      type: "apply",
      transactionId: "tx-gap",
      seq: 1,
      opId: "op-1",
      payloadHash: await canonicalHash(node),
      operation: node,
    });
    expect(drained.status).toBe("accepted");
    if (drained.status === "accepted") {
      expect(drained.acceptedThroughSeq).toBe(2);
      expect(drained.events.some((event) => event.payload.type === "draft-preview")).toBe(true);
    }

    const hash = await runtime.computeDraftHash("tx-gap");
    const committed = await runtime.finalize("tx-gap", hash);
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;
    expect(committed.snapshot.document.root).toBe("root");
    expect((await store.getBranchHead("document-1", "main"))?.revisionId).toBe("revision:tx-gap");

    const replayed = await runtime.finalize("tx-gap", hash);
    expect(replayed.status).toBe("replayed");
    expect(await store.listRevisions("document-1")).toHaveLength(1);
  });

  test("aborts a stale edit and preserves the newer last-good revision", async () => {
    const fixture = await createCommittedFixture();
    const head = fixture.snapshot.branchHead;
    const target = {
      mode: "edit" as const,
      documentId: "document-1",
      branchId: "main",
      parentRevisionIds: [fixture.snapshot.document.revision.revisionId] as [string],
      headPreconditions: [head],
      statePreconditions: {},
    };
    const first = new ArtifactTransactionRuntime({
      store: fixture.store,
      catalog: { id: "catalog:test", version: "1.0.0", contractFingerprint: TEST_FINGERPRINT, nodeVersions: { "layout.stack": 1 } },
      now: () => TEST_TIME,
    });
    const second = new ArtifactTransactionRuntime({
      store: fixture.store,
      catalog: { id: "catalog:test", version: "1.0.0", contractFingerprint: TEST_FINGERPRINT, nodeVersions: { "layout.stack": 1 } },
      now: () => TEST_TIME,
    });
    await first.begin("tx-edit-a", createContext(target));
    await second.begin("tx-edit-b", createContext(target));
    const opA: DraftOperation = { op: "set-meta", value: { title: "A" } };
    const opB: DraftOperation = { op: "set-meta", value: { title: "B" } };
    await first.apply({ type: "apply", transactionId: "tx-edit-a", seq: 1, opId: "a", payloadHash: await canonicalHash(opA), operation: opA });
    await second.apply({ type: "apply", transactionId: "tx-edit-b", seq: 1, opId: "b", payloadHash: await canonicalHash(opB), operation: opB });
    const committed = await first.finalize("tx-edit-a", await first.computeDraftHash("tx-edit-a"));
    expect(committed.status).toBe("committed");
    const stale = await second.finalize("tx-edit-b", await second.computeDraftHash("tx-edit-b"));
    expect(stale.status).toBe("aborted");
    if (stale.status === "aborted") {
      expect(stale.diagnostics[0]?.code).toBe("commit.branch-conflict");
      expect(stale.lastGood?.document.meta.title).toBe("A");
    }
    expect((await fixture.store.listRevisions("document-1"))).toHaveLength(2);
  });

  test("preserves user state across a compatible document edit", async () => {
    const fixture = await createCommittedFixture({ withState: true });
    const original = fixture.snapshot.state[0]!;
    fixture.store.seedRuntimeAuxiliary("document-1", "main", {
      state: [{ ...original, stateRevision: "state-user-2", value: "enterprise" }],
    });
    const head = await fixture.store.getBranchHead("document-1", "main");
    if (!head) throw new Error("missing head");
    const runtime = new ArtifactTransactionRuntime({
      store: fixture.store,
      catalog: { id: "catalog:test", version: "1.0.0", contractFingerprint: TEST_FINGERPRINT, nodeVersions: { "layout.stack": 1 } },
      now: () => TEST_TIME,
    });
    const context = createContext({
      mode: "edit",
      documentId: "document-1",
      branchId: "main",
      parentRevisionIds: [head.revisionId],
      headPreconditions: [head],
      statePreconditions: { filter: "state-user-2" },
    });
    await runtime.begin("tx-state-edit", context);
    const meta: DraftOperation = { op: "set-meta", value: { title: "Edited" } };
    await runtime.apply({ type: "apply", transactionId: "tx-state-edit", seq: 1, opId: "meta", payloadHash: await canonicalHash(meta), operation: meta });
    const result = await runtime.finalize("tx-state-edit", await runtime.computeDraftHash("tx-state-edit"));
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.snapshot.state[0]?.value).toBe("enterprise");
      expect(result.snapshot.state[0]?.stateRevision).toBe("state-user-2");
    }
  });
});

describe("replay, resume, and idempotency", () => {
  test("replays identical events and keeps last-good on a sequence gap", async () => {
    const fixture = await createCommittedFixture();
    await fixture.store.createStream("stream-replay", TEST_FINGERPRINT);
    const snapshotEvent = await fixture.store.appendEvent("stream-replay", { type: "snapshot", snapshot: fixture.snapshot });
    const state = await reduceClientArtifactEvent(createClientReplayState(), snapshotEvent);
    const replay = await reduceClientArtifactEvent(state, snapshotEvent);
    expect(replay.acceptedThroughSeq).toBe(state.acceptedThroughSeq);
    expect(replay.lastGood?.document.revision.revisionId).toBe(fixture.snapshot.document.revision.revisionId);

    const gap: ClientArtifactEvent = { ...snapshotEvent, seq: snapshotEvent.seq + 2, eventId: "gap", cursor: "gap-cursor" };
    const rejected = await reduceClientArtifactEvent(state, gap);
    expect(rejected.lastGood?.document.revision.revisionId).toBe(fixture.snapshot.document.revision.revisionId);
    expect(rejected.diagnostics.at(-1)?.code).toBe("stream.sequence-gap");
  });

  test("validates incremental state records and receipts before advancing replay", async () => {
    const fixture = await createCommittedFixture({ withState: true });
    await fixture.store.createStream("stream-state-replay", TEST_FINGERPRINT);
    const snapshotEvent = await fixture.store.appendEvent("stream-state-replay", {
      type: "snapshot",
      snapshot: fixture.snapshot,
    });
    const initial = await reduceClientArtifactEvent(createClientReplayState(), snapshotEvent);
    const previous = initial.lastGood?.state[0];
    if (!previous) throw new Error("missing fixture state");
    const record = { ...previous, stateRevision: "state-user-2", value: "enterprise" };
    const receipt = {
      receiptId: "receipt-state-user-2",
      operationKey: "operation-state-user-2",
      documentId: record.documentId,
      branchId: record.branchId,
      stateId: record.stateId,
      transition: "write" as const,
      fromStateRevision: previous.stateRevision,
      toStateRevision: record.stateRevision,
      schemaHash: record.schemaHash,
      policyHash: record.policyHash,
      recordedAt: TEST_TIME,
    };
    const validEvent = await fixture.store.appendEvent("stream-state-replay", {
      type: "state-updated",
      record,
      receipt,
    });
    const updated = await reduceClientArtifactEvent(initial, validEvent);
    expect(updated.acceptedThroughSeq).toBe(validEvent.seq);
    expect(updated.lastGood?.state[0]?.value).toBe("enterprise");

    const receiptMismatch = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-receipt-mismatch",
      cursor: "cursor-receipt-mismatch",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-state-user-3-mismatch",
          operationKey: "operation-state-user-3-mismatch",
          fromStateRevision: "stale-state-revision",
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(receiptMismatch.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(receiptMismatch.lastGood?.state[0]?.value).toBe("enterprise");
    expect(receiptMismatch.diagnostics.at(-1)?.code).toBe("stream.state-receipt-precondition-mismatch");

    const invalidEvent = await fixture.store.appendEvent("stream-state-replay", {
      type: "state-updated",
      record: { ...record, stateRevision: "state-user-3", value: 42 },
      receipt: {
        ...receipt,
        receiptId: "receipt-state-user-3",
        operationKey: "operation-state-user-3",
        fromStateRevision: record.stateRevision,
        toStateRevision: "state-user-3",
      },
    });
    const rejected = await reduceClientArtifactEvent(updated, invalidEvent);
    expect(rejected.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(rejected.lastGood?.state[0]?.value).toBe("enterprise");
    expect(rejected.diagnostics.some(({ code }) => code === "schema.value-invalid")).toBe(true);

    const identityMismatch = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-state-identity-mismatch",
      cursor: "cursor-state-identity-mismatch",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", schemaHash: "wrong-schema-hash", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-state-identity-mismatch",
          operationKey: "operation-state-identity-mismatch",
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
          schemaHash: "wrong-schema-hash",
        },
      },
    });
    expect(identityMismatch.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(identityMismatch.lastGood?.state[0]?.value).toBe("enterprise");
    expect(identityMismatch.diagnostics.some(({ code }) => code === "stream.state-definition-mismatch")).toBe(true);

    const duplicateReceipt = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-duplicate-receipt",
      cursor: "cursor-duplicate-receipt",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(duplicateReceipt.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(duplicateReceipt.lastGood?.state[0]?.value).toBe("enterprise");
    expect(duplicateReceipt.diagnostics.some(({ code }) => code === "stream.state-receipt-reused")).toBe(true);

    const staleRevision = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-stale-state-revision",
      cursor: "cursor-stale-state-revision",
      payload: {
        type: "state-updated",
        record: { ...record, value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-stale-state-revision",
          operationKey: "operation-stale-state-revision",
          fromStateRevision: record.stateRevision,
          toStateRevision: record.stateRevision,
        },
      },
    });
    expect(staleRevision.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(staleRevision.lastGood?.state[0]?.value).toBe("enterprise");
    expect(staleRevision.diagnostics.some(({ code }) => code === "stream.state-revision-not-advanced")).toBe(true);

    const pruneWithRecord = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-prune-with-record",
      cursor: "cursor-prune-with-record",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-prune-with-record",
          operationKey: "operation-prune-with-record",
          transition: "prune",
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(pruneWithRecord.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(pruneWithRecord.lastGood?.state[0]?.value).toBe("enterprise");
    expect(pruneWithRecord.diagnostics.some(({ code }) => code === "stream.state-receipt-target-mismatch")).toBe(true);

    const reusedOperation = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-reused-state-operation",
      cursor: "cursor-reused-state-operation",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-reused-state-operation",
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(reusedOperation.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(reusedOperation.diagnostics.some(({ code }) => code === "stream.state-operation-reused")).toBe(true);

    const invalidReset = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-invalid-state-reset",
      cursor: "cursor-invalid-state-reset",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-invalid-state-reset",
          operationKey: "operation-invalid-state-reset",
          transition: "reset",
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(invalidReset.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(invalidReset.diagnostics.some(({ code }) => code === "stream.state-reset-value-mismatch")).toBe(true);

    const missingMigrationReceipt = await reduceClientArtifactEvent(updated, {
      ...validEvent,
      seq: validEvent.seq + 1,
      eventId: "event-missing-migration-receipt",
      cursor: "cursor-missing-migration-receipt",
      payload: {
        type: "state-updated",
        record: { ...record, stateRevision: "state-user-3", value: "business" },
        receipt: {
          ...receipt,
          receiptId: "receipt-missing-migration-receipt",
          operationKey: "operation-missing-migration-receipt",
          transition: "migrate",
          fromStateRevision: record.stateRevision,
          toStateRevision: "state-user-3",
        },
      },
    });
    expect(missingMigrationReceipt.acceptedThroughSeq).toBe(updated.acceptedThroughSeq);
    expect(missingMigrationReceipt.diagnostics.some(({ code }) => code === "stream.state-migration-receipt-mismatch")).toBe(true);
  });

  test("retains the newest state receipt within the combined snapshot receipt limit", async () => {
    const fixture = await createCommittedFixture({ withState: true });
    const previous = fixture.snapshot.state[0];
    if (!previous) throw new Error("missing fixture state");
    const history = Array.from({ length: DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts - 1 }, (_, index) => ({
      receiptId: `receipt-history-${index}`,
      operationKey: `operation-history-${index}`,
      documentId: previous.documentId,
      branchId: previous.branchId,
      stateId: previous.stateId,
      transition: "write" as const,
      fromStateRevision: "initial",
      toStateRevision: `state-history-${index}`,
      schemaHash: previous.schemaHash,
      policyHash: previous.policyHash,
      recordedAt: TEST_TIME,
    }));
    const seeded = createClientReplayState({
      ...fixture.snapshot,
      stateMigrationReceipts: [{
        receiptId: "migration-history",
        documentId: previous.documentId,
        branchId: previous.branchId,
        stateId: previous.stateId,
        key: { schemaId: previous.schemaId, fromVersion: previous.schemaVersion, toVersion: previous.schemaVersion },
        fromSchemaHash: previous.schemaHash,
        toSchemaHash: previous.schemaHash,
        inputHash: "input-history",
        outputHash: "output-history",
        migrationIds: [],
        appliedAt: TEST_TIME,
      }],
      stateTransitionReceipts: history,
    });
    const record = { ...previous, stateRevision: "state-user-2", value: "enterprise" };
    const updated = await reduceClientArtifactEvent(seeded, {
      streamProtocol: "data-elements.stream/2.0",
      streamId: "stream-bounded-state-replay",
      seq: 1,
      eventId: "event-bounded-state-replay",
      cursor: "cursor-bounded-state-replay",
      contractFingerprint: TEST_FINGERPRINT,
      payload: {
        type: "state-updated",
        record,
        receipt: {
          receiptId: "receipt-bounded-state-replay",
          operationKey: "operation-bounded-state-replay",
          documentId: record.documentId,
          branchId: record.branchId,
          stateId: record.stateId,
          transition: "write",
          fromStateRevision: previous.stateRevision,
          toStateRevision: record.stateRevision,
          schemaHash: record.schemaHash,
          policyHash: record.policyHash,
          recordedAt: TEST_TIME,
        },
      },
    });
    expect(updated.acceptedThroughSeq).toBe(1);
    expect(updated.lastGood?.stateTransitionReceipts).toHaveLength(DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts - 1);
    expect(updated.lastGood?.stateMigrationReceipts).toHaveLength(1);
    expect(
      (updated.lastGood?.stateTransitionReceipts.length ?? 0)
      + (updated.lastGood?.stateMigrationReceipts.length ?? 0),
    ).toBe(DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts);
    expect(updated.lastGood?.stateTransitionReceipts.at(-1)?.receiptId).toBe("receipt-bounded-state-replay");
  });

  test("returns one atomic snapshot when a cursor has expired", async () => {
    const store = new InMemoryArtifactRuntimeStore({ now: () => TEST_TIME, maxRetainedEvents: 1 });
    const fixture = await createCommittedFixture({ store });
    const first = await store.appendEvent("stream-1", { type: "ack", acceptedThroughSeq: 1 });
    await store.appendEvent("stream-1", { type: "ack", acceptedThroughSeq: 2 });
    const resumed = await store.resume("stream-1", first.cursor, TEST_FINGERPRINT, "document-1", "main");
    expect(resumed.status).toBe("snapshot");
    if (resumed.status === "snapshot") {
      expect(resumed.snapshot.branchHead.revisionId).toBe(resumed.snapshot.document.revision.revisionId);
    }
  });

  test("deduplicates request IDs across streams and rejects byte changes", async () => {
    const store = new InMemoryArtifactRuntimeStore();
    const identity = { tenant: "tenant", actor: "actor", requestId: "request-1" };
    expect((await store.claimRequest(identity, "hash-a")).status).toBe("claimed");
    await store.completeRequest(identity, "hash-a", { status: "ok" });
    expect(await store.claimRequest(identity, "hash-a")).toEqual({ status: "replayed", response: { status: "ok" } });
    expect((await store.claimRequest(identity, "hash-b")).status).toBe("payload-conflict");
  });
});
