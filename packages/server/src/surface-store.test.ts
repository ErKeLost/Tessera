import { describe, expect, test } from "bun:test";
import type { SurfaceSessionRecord } from "./surface-store";
import { InMemorySurfaceSessionStore } from "./surface-store";

function record(): SurfaceSessionRecord {
  return {
    surfaceSessionId: "surface:test",
    streamId: "stream:test",
    epoch: 1,
    authority: {
      actorAuditRef: "audit:test",
      actorBindingHash: `sha256:${"a".repeat(64)}`,
      tenantBindingHash: `sha256:${"b".repeat(64)}`,
      authorityPolicyRevision: "policy:1",
    },
    audienceBindingHash: `sha256:${"c".repeat(64)}`,
    rendererCapabilityManifest: {} as SurfaceSessionRecord["rendererCapabilityManifest"],
    catalogSlice: { contractSetHash: `sha256:${"d".repeat(64)}` } as SurfaceSessionRecord["catalogSlice"],
    committedRevision: {} as SurfaceSessionRecord["committedRevision"],
    state: {},
    resources: {},
    actions: {},
    approvals: [],
    acknowledgedThrough: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-22T01:00:00.000Z",
  } as unknown as SurfaceSessionRecord;
}

describe("InMemorySurfaceSessionStore", () => {
  test("uses compare-and-set and never leaks mutable store state", async () => {
    const store = new InMemorySurfaceSessionStore();
    const initial = record();
    expect(await store.create(initial)).toBe("created");
    expect(await store.create(initial)).toBe("exists");

    const first = await store.get(initial.surfaceSessionId);
    if (!first) throw new Error("Expected stored session.");
    first.value.acknowledgedThrough = 99;
    expect((await store.get(initial.surfaceSessionId))?.value.acknowledgedThrough).toBe(0);

    const updated = { ...first.value, acknowledgedThrough: 3 };
    expect(await store.compareAndSet(initial.surfaceSessionId, first.version, updated)).toBe("updated");
    expect(await store.compareAndSet(initial.surfaceSessionId, first.version, updated)).toBe("conflict");
    expect((await store.get(initial.surfaceSessionId))?.value.acknowledgedThrough).toBe(3);
  });
});
