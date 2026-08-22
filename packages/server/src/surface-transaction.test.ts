import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  canonicalOperationEnvelopeSchema,
  committedRevisionSchema,
  correlationIdSchema,
  hashCanonical,
  hashDocumentContent,
  transactionIdSchema,
  validatedPreviewSchema,
  type CommittedRevision,
  type SurfaceSessionId,
  type TransactionId,
  type ValidatedPreview,
} from "@open-generative/protocol";
import type { RuntimeCommitPort } from "@open-generative/compiler";
import { computeValidatedPreviewHash } from "@open-generative/runtime";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import { InMemorySurfaceSessionJournal } from "./surface-journal";
import { SurfaceTransactionPublisher } from "./surface-transaction";
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
    const fake = createRuntime({ preview, revision });
    const publisher = new SurfaceTransactionPublisher({
      journal,
      runtime: fake.runtime,
      surfaceSessionId: fixture.record.surfaceSessionId,
      correlationId: correlationIdSchema.parse("correlation:compiler"),
    });
    const envelope = await operationEnvelope(transactionId, operation);

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
    const first = createRuntime({ preview: firstPreview, revision });
    const second = createRuntime({ preview: secondPreview, revision });
    const firstPublisher = publisherFor(journal, fixture.record.surfaceSessionId, first.runtime, "first");
    const secondPublisher = publisherFor(journal, fixture.record.surfaceSessionId, second.runtime, "second");

    expect((await firstPublisher.apply(await operationEnvelope(firstId, operation))).status).toBe("accepted");
    const losing = await secondPublisher.apply(await operationEnvelope(secondId, operation));
    expect(losing.status).toBe("conflict");
    expect(second.aborted).toEqual([secondId]);
    expect((await journal.get(fixture.record.surfaceSessionId))?.value.activePreview?.transactionId).toBe(firstId);

    await firstPublisher.abort(firstId, "compiler.cancelled");
    expect((await journal.get(fixture.record.surfaceSessionId))?.value.activePreview).toBeUndefined();
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
  journal: InMemorySurfaceSessionJournal,
  surfaceSessionId: SurfaceSessionId,
  runtime: RuntimeCommitPort,
  label: string,
) {
  return new SurfaceTransactionPublisher({
    journal,
    runtime,
    surfaceSessionId,
    correlationId: correlationIdSchema.parse(`correlation:${label}`),
  });
}

function createRuntime(input: { preview: ValidatedPreview; revision: CommittedRevision }) {
  const aborted: TransactionId[] = [];
  const runtime: RuntimeCommitPort = {
    begin: async () => {
      throw new Error("begin is not used by this test runtime");
    },
    apply: async () => ({ status: "accepted", acceptedThroughSequence: 1, previews: [input.preview] }),
    finalize: async () => ({
      status: "committed",
      revision: input.revision,
      consumedOverlayHash: input.preview.overlayHash,
    }),
    abort: async (transactionId) => {
      aborted.push(transactionId);
      return { status: "aborted" };
    },
  };
  return { runtime, aborted };
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
