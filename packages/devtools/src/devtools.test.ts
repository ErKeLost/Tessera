import { describe, expect, test } from "bun:test";
import { ArtifactEventBus } from "@data-elements/observability";
import { createArtifactDevtools } from "./index";

const base = {
  type: "transaction.commit",
  stage: "commit" as const,
  timestamp: "2026-08-15T10:00:00.000Z",
  runId: "run-1",
};

describe("artifact devtools", () => {
  test("maintains bounded timeline and diagnostic aggregates", async () => {
    const bus = new ArtifactEventBus({ maxBufferedEvents: 0 });
    const devtools = createArtifactDevtools(bus, { maxTimelineEvents: 2, now: () => "2026-08-15T11:00:00.000Z" });
    await bus.emit({ ...base, eventId: "one", diagnosticCodes: ["commit.conflict"] });
    await bus.emit({ ...base, eventId: "two", diagnosticCodes: ["commit.conflict"] });
    await bus.emit({ ...base, eventId: "three", stage: "render", diagnosticCodes: ["render.failed"] });
    const snapshot = devtools.snapshot();
    expect(snapshot.timeline.map(({ eventId }) => eventId)).toEqual(["two", "three"]);
    expect(snapshot.droppedEvents).toBe(1);
    expect(snapshot.diagnostics.find(({ code }) => code === "commit.conflict")?.count).toBe(2);
    devtools.dispose();
  });

  test("never retains secret-bearing attributes or diagnostic messages", async () => {
    const bus = new ArtifactEventBus();
    const devtools = createArtifactDevtools(bus);
    await bus.emit({
      ...base,
      eventId: "secret",
      diagnosticCodes: ["policy.denied"],
      attributes: {
        token: "top-secret",
        note: "Bearer abcdefghijklmnop",
        profile: "analysis",
        nested: { password: "secret" },
      },
    });
    const serialized = JSON.stringify(devtools.snapshot());
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("password");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("policy.denied");
  });
});
