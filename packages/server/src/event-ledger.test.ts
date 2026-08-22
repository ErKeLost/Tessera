import { describe, expect, test } from "bun:test";
import {
  correlationIdSchema,
  requestIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  streamIdSchema,
  surfaceSessionIdSchema,
  verifySurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  EncryptedSurfaceResumeCursorCodec,
  InMemorySurfaceEventStore,
  SurfaceEventLedger,
} from "./event-ledger";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
const surfaceSessionId = surfaceSessionIdSchema.parse("surface:test");
const streamId = streamIdSchema.parse("stream:test");
const audienceBindingHash = hash("a");

function ledger(maxRetainedEvents = 2_000) {
  let event = 0;
  return new SurfaceEventLedger({
    store: new InMemorySurfaceEventStore(maxRetainedEvents),
    cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(7)),
    eventIdFactory: () => `event:${++event}`,
  });
}

function append(instance: SurfaceEventLedger, rejectedRequest = "request:test") {
  return instance.append({
    surfaceSessionId,
    streamId,
    epoch: 1,
    committedRevisionId: revisionIdSchema.parse("revision:test"),
    audienceBindingHash,
    contractSetHash: hash("b"),
    correlationId: correlationIdSchema.parse("correlation:test"),
    payload: {
      type: "rejected",
      requestId: requestIdSchema.parse(rejectedRequest),
      diagnostics: [{
        phase: "transport",
        code: "test.rejected",
        severity: "error",
        recoverable: true,
        modelCorrectable: false,
        message: "Rejected by test policy.",
      }],
    },
    cursorExpiresAt: "2026-08-22T01:00:00.000Z",
  });
}

describe("SurfaceEventLedger", () => {
  test("publishes verified monotonic envelopes and resumes after a cursor", async () => {
    const instance = ledger();
    const first = await append(instance, "request:1");
    const second = await append(instance, "request:2");

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await verifySurfaceEventEnvelope(first)).toBe(true);
    expect(await instance.resume({
      cursor: first.cursor,
      surfaceSessionId,
      streamId,
      epoch: 1,
      audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    })).toEqual({ status: "events", events: [second] });
  });

  test("fails closed for expired, cross-audience, tampered, and stale cursors", async () => {
    const instance = ledger(1);
    const first = await append(instance, "request:1");
    await append(instance, "request:2");
    await append(instance, "request:3");

    expect((await instance.resume({
      cursor: first.cursor,
      surfaceSessionId,
      streamId,
      epoch: 1,
      audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    })).status).toBe("snapshot-required");
    expect(await instance.resume({
      cursor: first.cursor,
      surfaceSessionId,
      streamId,
      epoch: 1,
      audienceBindingHash: hash("f"),
      now: new Date("2026-08-22T00:30:00.000Z"),
    })).toEqual({ status: "snapshot-required", reason: "scope-mismatch" });
    expect(await instance.resume({
      cursor: first.cursor,
      surfaceSessionId,
      streamId,
      epoch: 1,
      audienceBindingHash,
      now: new Date("2026-08-22T02:00:00.000Z"),
    })).toEqual({ status: "snapshot-required", reason: "expired" });

    const changed = first.cursor[3] === "a" ? "b" : "a";
    const tampered = `${first.cursor.slice(0, 3)}${changed}${first.cursor.slice(4)}` as typeof first.cursor;
    expect(await instance.resume({
      cursor: tampered,
      surfaceSessionId,
      streamId,
      epoch: 1,
      audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    })).toEqual({ status: "snapshot-required", reason: "invalid-cursor" });
  });
});
