import { describe, expect, test } from "bun:test";
import {
  committedRevisionSchema,
  correlationIdSchema,
  hashDocumentContent,
} from "@open-generative/protocol";
import { createRendererCapabilityManifest } from "@open-generative/catalog";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import { InMemorySurfaceSessionJournal } from "./surface-journal";
import { SurfaceSessionError, SurfaceSessionManager } from "./surface-session";
import { createServerFixture, testHash } from "./test-fixtures";

function manager(journal: InMemorySurfaceSessionJournal) {
  return new SurfaceSessionManager({
    journal,
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    surfaceSessionIdFactory: () => "surface:managed",
    streamIdFactory: () => "stream:managed",
  });
}

describe("SurfaceSessionManager", () => {
  test("opens only after renderer negotiation and exact revision lock validation", async () => {
    const fixture = await createServerFixture();
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(5)),
      eventIdFactory: () => "event:managed",
    });
    const opened = await manager(journal).open({
      authority: fixture.record.authority,
      rendererCapabilityManifest: fixture.record.rendererCapabilityManifest,
      catalogs: [fixture.catalog],
      rendererRequirements: [{ contract: fixture.contract, requiredFeatures: [] }],
      actionContracts: [],
      resourceOffers: [],
      evidenceOffers: [],
      placement: { kind: "panel", width: 960, height: 720 },
      generationLimits: fixture.record.catalogSlice.limits,
      providerSchemaProfile: "test",
      committedRevision: fixture.record.committedRevision,
      streamPolicy: {
        maxSequenceGap: 16,
        maxBufferedBytes: 1_000_000,
        ackEveryEvents: 8,
        backpressure: "publish-snapshot",
      },
      expiresAt: "2026-08-22T01:00:00.000Z",
      correlationId: correlationIdSchema.parse("correlation:managed"),
    });
    expect(opened.status).toBe("created");
    if (opened.status !== "created") throw new Error("Expected opened Surface.");
    expect(opened.session.value.catalogSlice.sliceHash).toBe(fixture.record.catalogSlice.sliceHash);
    expect(opened.event.payload.type).toBe("snapshot-published");
  });

  test("rejects a renderer that lacks a required exact Contract", async () => {
    const fixture = await createServerFixture();
    const renderer = await createRendererCapabilityManifest({
      rendererId: "empty-react",
      rendererRevision: "2026-08-22",
      implementationHash: testHash("6"),
      conformanceRevision: "2026-08-22",
      contracts: [],
    });
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(6)),
    });
    await expect(manager(journal).open({
      authority: fixture.record.authority,
      rendererCapabilityManifest: renderer,
      catalogs: [fixture.catalog],
      rendererRequirements: [{ contract: fixture.contract, requiredFeatures: [] }],
      actionContracts: [],
      resourceOffers: [],
      evidenceOffers: [],
      placement: { kind: "panel", width: 960, height: 720 },
      generationLimits: fixture.record.catalogSlice.limits,
      providerSchemaProfile: "test",
      committedRevision: fixture.record.committedRevision,
      streamPolicy: { maxSequenceGap: 16, maxBufferedBytes: 1_000_000, ackEveryEvents: 8, backpressure: "publish-snapshot" },
      expiresAt: "2026-08-22T01:00:00.000Z",
      correlationId: correlationIdSchema.parse("correlation:rejected"),
    })).rejects.toMatchObject({ code: "surface.renderer-incomplete" });
  });

  test("rejects a validly hashed revision whose Contract lock differs from negotiation", async () => {
    const fixture = await createServerFixture();
    const content = structuredClone(fixture.record.committedRevision.content);
    content.contracts.contractSetHash = testHash("9");
    const revision = committedRevisionSchema.parse({
      ...fixture.record.committedRevision,
      envelope: {
        ...fixture.record.committedRevision.envelope,
        contentHash: await hashDocumentContent(content),
      },
      content,
    });
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(7)),
    });
    const opening = manager(journal).open({
      authority: fixture.record.authority,
      rendererCapabilityManifest: fixture.record.rendererCapabilityManifest,
      catalogs: [fixture.catalog],
      rendererRequirements: [{ contract: fixture.contract, requiredFeatures: [] }],
      actionContracts: [],
      resourceOffers: [],
      evidenceOffers: [],
      placement: { kind: "panel", width: 960, height: 720 },
      generationLimits: fixture.record.catalogSlice.limits,
      providerSchemaProfile: "test",
      committedRevision: revision,
      streamPolicy: { maxSequenceGap: 16, maxBufferedBytes: 1_000_000, ackEveryEvents: 8, backpressure: "publish-snapshot" },
      expiresAt: "2026-08-22T01:00:00.000Z",
      correlationId: correlationIdSchema.parse("correlation:lock"),
    });
    await expect(opening).rejects.toBeInstanceOf(SurfaceSessionError);
    await expect(opening).rejects.toMatchObject({ code: "surface.catalog-lock-mismatch" });
  });
});
