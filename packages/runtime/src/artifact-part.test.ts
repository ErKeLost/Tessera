import { describe, expect, test } from "bun:test";
import { artifactPartWireSchema, decodeArtifactPart, isArtifactPart } from "./artifact-part";
import { createCommittedFixture, TEST_FINGERPRINT } from "./test-fixtures";

describe("ArtifactPart trust boundary", () => {
  test("accepts only strict wire envelopes", async () => {
    const { snapshot } = await createCommittedFixture();
    expect(artifactPartWireSchema.safeParse({
      kind: "artifact-snapshot",
      snapshot,
      executable: true,
    }).success).toBe(false);
    expect(isArtifactPart({ kind: "artifact-snapshot", snapshot })).toBe(false);
  });

  test("deep-freezes the validated clone", async () => {
    const { snapshot } = await createCommittedFixture();
    const decoded = await decodeArtifactPart(
      { kind: "artifact-snapshot", snapshot },
      { contractFingerprint: TEST_FINGERPRINT },
    );
    expect(decoded.success).toBe(true);
    if (!decoded.success || decoded.part.kind !== "artifact-snapshot") return;
    const part = decoded.part;

    expect(isArtifactPart(part)).toBe(true);
    expect(Object.isFrozen(part)).toBe(true);
    expect(Object.isFrozen(part.snapshot)).toBe(true);
    expect(Object.isFrozen(part.snapshot.document.nodes)).toBe(true);

    const forged = { kind: "artifact-snapshot", snapshot };
    const brand = Object.getOwnPropertySymbols(part)[0];
    if (brand) Object.defineProperty(forged, brand, { value: true });
    expect(isArtifactPart(forged)).toBe(false);

    snapshot.document.meta.title = "mutated source";
    expect(part.snapshot.document.meta.title).not.toBe("mutated source");
    expect(() => {
      part.snapshot.document.meta.title = "mutated trusted part";
    }).toThrow();
  });

  test("rejects a stream whose incremental state update violates its definition", async () => {
    const { snapshot, store } = await createCommittedFixture({ withState: true });
    await store.createStream("stream-invalid-state", TEST_FINGERPRINT);
    const previous = snapshot.state[0];
    if (!previous) throw new Error("missing fixture state");
    const event = await store.appendEvent("stream-invalid-state", {
      type: "state-updated",
      record: { ...previous, stateRevision: "state-invalid", value: 42 },
      receipt: {
        receiptId: "receipt-invalid-state",
        operationKey: "operation-invalid-state",
        documentId: previous.documentId,
        branchId: previous.branchId,
        stateId: previous.stateId,
        transition: "write",
        fromStateRevision: previous.stateRevision,
        toStateRevision: "state-invalid",
        schemaHash: previous.schemaHash,
        policyHash: previous.policyHash,
        recordedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    const decoded = await decodeArtifactPart(
      { kind: "artifact-stream", base: snapshot, events: [event] },
      { contractFingerprint: TEST_FINGERPRINT },
    );
    expect(decoded.success).toBe(false);
    if (!decoded.success) {
      expect(decoded.diagnostics.some(({ code }) => code === "schema.value-invalid")).toBe(true);
    }
  });
});
