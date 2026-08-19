import { describe, expect, test } from "bun:test";
import type { ClientArtifactEvent, RuntimeSnapshot } from "@data-elements/runtime";
import {
  AG_UI_ARTIFACT_EVENT,
  AG_UI_ARTIFACT_SNAPSHOT_EVENT,
  agUiEventToArtifactWire,
  artifactEventToAgUiEvent,
  artifactPartToAgUiEvents,
  artifactSnapshotToAgUiEvent,
  decodeAgUiArtifactEvent,
} from "./index";

describe("AG-UI artifact transport", () => {
  test("maps snapshots and events without changing their payload", () => {
    const snapshot = { document: { id: "doc" } } as unknown as RuntimeSnapshot;
    const event = { streamId: "stream" } as unknown as ClientArtifactEvent;
    expect(artifactSnapshotToAgUiEvent(snapshot)).toEqual({
      type: "CUSTOM", name: AG_UI_ARTIFACT_SNAPSHOT_EVENT, value: snapshot,
    });
    expect(artifactEventToAgUiEvent(event)).toEqual({
      type: "CUSTOM", name: AG_UI_ARTIFACT_EVENT, value: event,
    });
    expect(artifactPartToAgUiEvents({ kind: "artifact-stream", base: snapshot, events: [event] })).toHaveLength(2);
  });

  test("maps only namespaced custom events back to runtime wire values", () => {
    const value = { arbitrary: true } as unknown as RuntimeSnapshot;
    expect(agUiEventToArtifactWire({
      type: "CUSTOM", name: AG_UI_ARTIFACT_SNAPSHOT_EVENT, value,
    })).toEqual({ kind: "artifact-snapshot", snapshot: value });
    expect(agUiEventToArtifactWire({ type: "TEXT_MESSAGE_CONTENT", value })).toBeUndefined();
    expect(agUiEventToArtifactWire({ type: "CUSTOM", name: "other", value })).toBeUndefined();
  });

  test("delegates payload validation to the runtime decoder", async () => {
    const result = await decodeAgUiArtifactEvent({
      type: "CUSTOM",
      name: AG_UI_ARTIFACT_SNAPSHOT_EVENT,
      value: { invalid: true },
    }, { contractFingerprint: "sha256:" + "a".repeat(64) });
    expect(result.success).toBe(false);
    if (!result.success && !("ignored" in result)) {
      expect(result.diagnostics[0]?.phase).toBe("transport");
    }
  });
});
