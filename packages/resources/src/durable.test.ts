import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore, durableStateKey } from "@data-elements/runtime";
import { DurableResourceResolutionStore, type StoredResourceResolution } from "./index";

describe("durable resource stores", () => {
  test("keeps request claims and immutable resolution receipts after a process restart", async () => {
    const state = new InMemoryDurableStateStore();
    const storageKey = durableStateKey("resource-resolutions", "tenant-a");
    const record = pendingRecord();
    const first = new DurableResourceResolutionStore({ state, storageKey });
    expect((await first.claim(record)).status).toBe("claimed");

    const restarted = new DurableResourceResolutionStore({ state, storageKey });
    expect((await restarted.claim(record)).status).toBe("pending");
    await restarted.complete(
      { tenantRef: "tenant-a", actorRef: "actor-1", requestId: "request-1" },
      "payload-hash",
      {
        resolutionId: "resolution-1",
        requestId: "request-1",
        resourceId: "resource-1",
        schemaVersion: 1,
        schemaHash: "schema-hash",
        contentHash: "content-hash",
        status: "resolved",
        evidenceIds: [],
        auditRef: "audit:resource:request-1",
      },
    );
    const later = new DurableResourceResolutionStore({ state, storageKey });
    const replay = await later.claim(record);
    expect(replay.status).toBe("replayed");
    expect((await later.get({ tenantRef: "tenant-a", actorRef: "actor-1", requestId: "request-1" }))?.receipt?.resolutionId).toBe("resolution-1");
  });
});

function pendingRecord(): StoredResourceResolution {
  return {
    payloadHash: "payload-hash",
    actor: {
      tenantRef: "tenant-a",
      actorRef: "actor-1",
      actorContextRef: "actor-context-1",
      allowedScopeRefs: ["scope-1"],
      allowedSensitivity: ["private"],
    },
    request: {
      requestId: "request-1",
      contractFingerprint: "contract-fingerprint",
      documentId: "document-1",
      branchId: "main",
      revisionId: "revision-1",
      resourceId: "resource-1",
      expectedSchemaHash: "schema-hash",
      expectedContentHash: "content-hash",
    },
    status: "pending",
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}
