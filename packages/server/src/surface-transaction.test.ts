import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  actorAuditRefSchema,
  branchIdSchema,
  canonicalOperationEnvelopeSchema,
  committedRevisionSchema,
  correlationIdSchema,
  hashCanonical,
  hashDocumentContent,
  headTokenSchema,
  revisionIdSchema,
  transactionIdSchema,
  validatedPreviewSchema,
  type CommittedRevision,
  type SurfaceSessionId,
  type TransactionId,
  type ValidatedPreview,
} from "@open-generative/protocol";
import type { RuntimeCommitPort } from "@open-generative/compiler";
import {
  computeValidatedPreviewHash,
  type BeginTransactionInput,
  type RuntimeTransactionRecord,
} from "@open-generative/runtime";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import {
  InMemorySurfaceSessionJournal,
  type SurfaceSessionJournal,
} from "./surface-journal";
import {
  SurfaceTransactionPublisher,
  SurfaceTransactionSweeper,
} from "./surface-transaction";
import { createServerFixture } from "./test-fixtures";

describe("SurfaceTransactionPublisher", () => {
  test("publishes a validated preview and atomically promotes its committed revision", async () => {
    const fixture = await createServerFixture();
    const journal = createJournal();
    const created = await journal.create(fixture.record, fixture.initialEvent);
    if (created.status !== "created") throw new Error("Expected Surface creation.");
    const transactionId = transactionIdSchema.parse("transaction:publish");
    const operation = { op: "set-meta" as const, value: { title: "Committed view", tags: [] } };
    const preview = await createPreview(fixture.record.committedRevision, transactionId, operation);
    const revision = await createNextRevision(fixture.record.committedRevision, operation.value.title);
    const fake = createRuntime({ base: fixture.record.committedRevision, preview, revision });
    const publisher = new SurfaceTransactionPublisher({
      journal,
      runtime: fake.runtime,
      surfaceSessionId: fixture.record.surfaceSessionId,
      correlationId: correlationIdSchema.parse("correlation:compiler"),
      now: () => new Date("2026-08-22T00:00:10.000Z"),
    });
    const envelope = await operationEnvelope(transactionId, operation);

    expect((await publisher.begin(transactionBegin(fixture.record.committedRevision, transactionId))).status).toBe("begun");
    const applied = await publisher.apply(envelope, []);
    expect(applied.status).toBe("accepted");
    expect((await journal.get(fixture.record.surfaceSessionId))?.value.activePreview).toEqual({
      transactionId,
      overlayHash: preview.overlayHash,
      overlaySequence: 1,
    });

    const finalized = await publisher.finalize({
      transactionId,
      finalOperationSequence: 1,
      expectedContentHash: revision.envelope.contentHash,
      expectedOverlayHash: preview.overlayHash,
    });
    expect(finalized.status).toBe("committed");
    const session = await journal.get(fixture.record.surfaceSessionId);
    expect(session?.value.committedRevision).toEqual(revision);
    expect(session?.value.activePreview).toBeUndefined();

    const resumed = await journal.resume({
      cursor: created.event.cursor,
      surfaceSessionId: fixture.record.surfaceSessionId,
      audienceBindingHash: fixture.record.audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    });
    expect(resumed.status).toBe("events");
    if (resumed.status !== "events") throw new Error("Expected retained transaction events.");
    expect(resumed.events.map((event) => event.payload.type)).toEqual([
      "preview-applied",
      "revision-committed",
    ]);
    expect(resumed.events[1]?.committedRevisionId).toBe(revision.envelope.revisionId);
  });

  test("allows only one active preview and aborts the losing transaction", async () => {
    const fixture = await createServerFixture();
    const journal = createJournal();
    await journal.create(fixture.record, fixture.initialEvent);
    const firstId = transactionIdSchema.parse("transaction:first");
    const secondId = transactionIdSchema.parse("transaction:second");
    const operation = { op: "set-meta" as const, value: { title: "Preview", tags: [] } };
    const firstPreview = await createPreview(fixture.record.committedRevision, firstId, operation);
    const secondPreview = await createPreview(fixture.record.committedRevision, secondId, operation);
    const revision = await createNextRevision(fixture.record.committedRevision, "Preview");
    const first = createRuntime({ base: fixture.record.committedRevision, preview: firstPreview, revision });
    const second = createRuntime({ base: fixture.record.committedRevision, preview: secondPreview, revision });
    const firstPublisher = publisherFor(journal, fixture.record.surfaceSessionId, first.runtime, "first");
    const secondPublisher = publisherFor(journal, fixture.record.surfaceSessionId, second.runtime, "second");

    expect((await firstPublisher.begin(transactionBegin(fixture.record.committedRevision, firstId))).status).toBe("begun");
    const losing = await secondPublisher.begin(transactionBegin(fixture.record.committedRevision, secondId));
    expect(losing.status).toBe("conflict");
    expect(second.aborted).toEqual([]);
    expect((await firstPublisher.apply(await operationEnvelope(firstId, operation))).status).toBe("accepted");
    expect((await journal.get(fixture.record.surfaceSessionId))?.value.activeTransaction?.transactionId).toBe(firstId);

    await firstPublisher.abort(firstId, "compiler.cancelled");
    expect((await journal.get(fixture.record.surfaceSessionId))?.value.activePreview).toBeUndefined();
  });

  test("durably retries Surface publication after Runtime finalize has committed", async () => {
    const fixture = await createServerFixture();
    const baseJournal = createJournal();
    const created = await baseJournal.create(fixture.record, fixture.initialEvent);
    if (created.status !== "created") throw new Error("Expected Surface creation.");
    const blocked = publicationBlockingJournal(baseJournal);
    const transactionId = transactionIdSchema.parse("transaction:publication-retry");
    const operation = { op: "set-meta" as const, value: { title: "Recovered commit", tags: [] } };
    const preview = await createPreview(fixture.record.committedRevision, transactionId, operation);
    const revision = await createNextRevision(fixture.record.committedRevision, operation.value.title);
    const fake = createRuntime({ base: fixture.record.committedRevision, preview, revision });
    const publisher = publisherFor(
      blocked.journal,
      fixture.record.surfaceSessionId,
      fake.runtime,
      "publication-retry",
    );
    await publisher.begin(transactionBegin(fixture.record.committedRevision, transactionId));
    await publisher.apply(await operationEnvelope(transactionId, operation));
    const finalizeInput = {
      transactionId,
      finalOperationSequence: 1,
      expectedContentHash: revision.envelope.contentHash,
      expectedOverlayHash: preview.overlayHash,
    };

    const interrupted = await publisher.finalize(finalizeInput);
    expect(interrupted.status).toBe("conflict");
    expect(fake.finalizeCalls).toBe(1);
    expect((await baseJournal.get(fixture.record.surfaceSessionId))?.value).toMatchObject({
      committedRevision: fixture.record.committedRevision,
      pendingRevisionPublication: { finalize: finalizeInput },
    });

    blocked.allowPublication();
    const recovered = await publisher.finalize(finalizeInput);
    expect(recovered.status).toBe("replayed");
    expect(fake.finalizeCalls).toBe(2);
    const session = await baseJournal.get(fixture.record.surfaceSessionId);
    expect(session?.value.committedRevision).toEqual(revision);
    expect(session?.value.pendingRevisionPublication).toBeUndefined();
    expect(session?.value.activePreview).toBeUndefined();
  });

  test("deterministically sweeps an expired interrupted stream and cleans Surface state once", async () => {
    const fixture = await createServerFixture();
    const journal = createJournal();
    const created = await journal.create(fixture.record, fixture.initialEvent);
    if (created.status !== "created") throw new Error("Expected Surface creation.");
    const transactionId = transactionIdSchema.parse("transaction:expired-stream");
    const operation = { op: "set-meta" as const, value: { title: "Interrupted preview", tags: [] } };
    const preview = await createPreview(fixture.record.committedRevision, transactionId, operation);
    const revision = await createNextRevision(fixture.record.committedRevision, operation.value.title);
    const fake = createRuntime({ base: fixture.record.committedRevision, preview, revision });
    const publisher = publisherFor(
      journal,
      fixture.record.surfaceSessionId,
      fake.runtime,
      "expired-stream",
    );
    await publisher.begin(transactionBegin(fixture.record.committedRevision, transactionId));
    expect((await publisher.apply(await operationEnvelope(transactionId, operation))).status).toBe("accepted");

    const sweeper = new SurfaceTransactionSweeper({
      journal,
      runtimeFor: () => fake.runtime,
      correlationIdFor: () => correlationIdSchema.parse("correlation:sweeper"),
      now: () => new Date("2026-08-22T00:02:00.000Z"),
    });
    const swept = await sweeper.sweep({ limit: 10 });
    expect(swept.recoveries).toEqual([{
      surfaceSessionId: fixture.record.surfaceSessionId,
      transactionId,
      status: "aborted",
    }]);
    expect(fake.aborted).toEqual([transactionId]);
    const cleaned = (await journal.get(fixture.record.surfaceSessionId))?.value;
    expect(cleaned?.activeTransaction).toBeUndefined();
    expect(cleaned?.activePreview).toBeUndefined();
    expect(cleaned?.pendingRevisionPublication).toBeUndefined();

    expect((await sweeper.sweep({ limit: 10 })).recoveries).toEqual([]);
    expect(fake.aborted).toEqual([transactionId]);
    const resumed = await journal.resume({
      cursor: created.event.cursor,
      surfaceSessionId: fixture.record.surfaceSessionId,
      audienceBindingHash: fixture.record.audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    });
    expect(resumed.status).toBe("events");
    if (resumed.status !== "events") return;
    expect(resumed.events.map((event) => event.payload.type)).toEqual([
      "preview-applied",
      "preview-invalidated",
    ]);
  });
});

function createJournal() {
  let event = 0;
  return new InMemorySurfaceSessionJournal({
    cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(8)),
    eventIdFactory: () => `event:transaction:${++event}`,
  });
}

function publisherFor(
  journal: SurfaceSessionJournal,
  surfaceSessionId: SurfaceSessionId,
  runtime: RuntimeCommitPort,
  label: string,
) {
  return new SurfaceTransactionPublisher({
    journal,
    runtime,
    surfaceSessionId,
    correlationId: correlationIdSchema.parse(`correlation:${label}`),
    now: () => new Date("2026-08-22T00:00:10.000Z"),
  });
}

function createRuntime(input: { base: CommittedRevision; preview: ValidatedPreview; revision: CommittedRevision }) {
  const aborted: TransactionId[] = [];
  let finalizeCalls = 0;
  const runtime: RuntimeCommitPort = {
    begin: async (begin) => ({
      status: "begun",
      transaction: {
        input: begin,
        status: "active",
        startedAt: "2026-08-22T00:00:00.000Z",
        deadlineAt: "2026-08-22T00:01:00.000Z",
      } as RuntimeTransactionRecord,
      lastGood: input.base,
    }),
    apply: async () => ({ status: "accepted", acceptedThroughSequence: 1, previews: [input.preview] }),
    finalize: async () => {
      finalizeCalls += 1;
      return {
        status: finalizeCalls === 1 ? "committed" : "replayed",
        revision: input.revision,
        consumedOverlayHash: input.preview.overlayHash,
      };
    },
    abort: async (transactionId) => {
      aborted.push(transactionId);
      return { status: "aborted" };
    },
  };
  return {
    runtime,
    aborted,
    get finalizeCalls() {
      return finalizeCalls;
    },
  };
}

function transactionBegin(
  base: CommittedRevision,
  transactionId: TransactionId,
): BeginTransactionInput {
  return {
    transactionId,
    surfaceSessionId: "surface:test" as SurfaceSessionId,
    documentId: base.envelope.documentId,
    branchId: branchIdSchema.parse("main"),
    baseRevisionId: base.envelope.revisionId,
    expectedHeadToken: headTokenSchema.parse("head:base"),
    targetRevisionId: revisionIdSchema.parse("revision:next"),
    nextHeadToken: headTokenSchema.parse("head:next"),
    createdAt: "2026-08-22T00:10:00.000Z",
    createdBy: actorAuditRefSchema.parse("audit:test"),
  };
}

function publicationBlockingJournal(base: InMemorySurfaceSessionJournal) {
  let blocked = true;
  const journal: SurfaceSessionJournal = {
    create: (record, event) => base.create(record, event),
    get: (surfaceSessionId) => base.get(surfaceSessionId),
    list: (input) => base.list(input),
    commit: async (input) => {
      if (blocked && input.events.some((event) => event.payload.type === "revision-committed")) {
        const current = await base.get(input.surfaceSessionId);
        if (!current) return { status: "missing" };
        return { status: "conflict", current };
      }
      return base.commit(input);
    },
    resume: (input) => base.resume(input),
    eventsForCommand: (command) => base.eventsForCommand(command),
    acknowledge: (command) => base.acknowledge(command),
  };
  return {
    journal,
    allowPublication() {
      blocked = false;
    },
  };
}

async function createPreview(
  base: CommittedRevision,
  transactionId: TransactionId,
  operation: { op: "set-meta"; value: { title: string; tags: string[] } },
) {
  const value = {
    surfaceSessionId: "surface:test",
    transactionId,
    baseRevisionId: base.envelope.revisionId,
    overlaySequence: 1,
    identityMapDelta: [],
    operations: [operation],
    renderableNodeIds: [],
    disabledActionIds: [],
  };
  return validatedPreviewSchema.parse({
    ...value,
    overlayHash: await computeValidatedPreviewHash(validatedPreviewSchema.omit({ overlayHash: true }).parse(value)),
  });
}

async function operationEnvelope(
  transactionId: TransactionId,
  operation: { op: "set-meta"; value: { title: string; tags: string[] } },
) {
  return canonicalOperationEnvelopeSchema.parse({
    transactionId,
    operationId: `operation:${transactionId}`,
    sequence: 1,
    dependsOn: [],
    payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operation),
    operation,
  });
}

async function createNextRevision(base: CommittedRevision, title: string) {
  const content = { ...base.content, meta: { ...base.content.meta, title } };
  return committedRevisionSchema.parse({
    envelope: {
      documentId: base.envelope.documentId,
      revisionId: "revision:next",
      parentRevisionIds: [base.envelope.revisionId],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:10:00.000Z",
      createdBy: base.envelope.createdBy,
    },
    content,
  });
}
