import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  correlationIdSchema,
  hashCanonical,
  requestIdSchema,
} from "@open-generative/protocol";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import {
  InMemorySurfaceSessionJournal,
  commandReceipt,
} from "./surface-journal";
import { createServerFixture } from "./test-fixtures";

function rejected(requestId: string) {
  return {
    correlationId: correlationIdSchema.parse(`correlation:${requestId}`),
    payload: {
      type: "rejected" as const,
      requestId: requestIdSchema.parse(requestId),
      diagnostics: [{
        phase: "policy" as const,
        code: "policy.test-rejected",
        severity: "error" as const,
        recoverable: true,
        modelCorrectable: false,
        message: "Rejected by test policy.",
      }],
    },
  };
}

describe("InMemorySurfaceSessionJournal", () => {
  test("atomically creates a session with its trusted initial snapshot", async () => {
    const fixture = await createServerFixture();
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(2)),
      eventIdFactory: () => "event:initial",
    });
    const created = await journal.create(fixture.record, fixture.initialEvent);
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("Expected session creation.");
    expect(created.event.sequence).toBe(1);
    expect(created.event.payload.type).toBe("snapshot-published");
    expect((await journal.get(fixture.record.surfaceSessionId))?.version).toBe(1);
  });

  test("allows only one state-and-event commit for a session version", async () => {
    const fixture = await createServerFixture();
    let event = 0;
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(3)),
      eventIdFactory: () => `event:${++event}`,
    });
    const created = await journal.create(fixture.record, fixture.initialEvent);
    if (created.status !== "created") throw new Error("Expected session creation.");
    const left = structuredClone(created.session.value);
    left.acknowledgedThrough = 1;
    const right = structuredClone(created.session.value);
    right.acknowledgedThrough = 2;

    const results = await Promise.all([
      journal.commit({
        surfaceSessionId: fixture.record.surfaceSessionId,
        expectedVersion: created.session.version,
        next: left,
        events: [rejected("request:left")],
      }),
      journal.commit({
        surfaceSessionId: fixture.record.surfaceSessionId,
        expectedVersion: created.session.version,
        next: right,
        events: [rejected("request:right")],
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["committed", "conflict"]);
    const committed = results.find((result) => result.status === "committed");
    if (committed?.status !== "committed") throw new Error("Expected one committed result.");
    expect(committed.events).toHaveLength(1);
    expect(committed.events[0]?.sequence).toBe(2);
  });

  test("replays the exact retained events recorded for a command", async () => {
    const fixture = await createServerFixture();
    let event = 0;
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(4)),
      eventIdFactory: () => `event:${++event}`,
    });
    const created = await journal.create(fixture.record, fixture.initialEvent);
    if (created.status !== "created") throw new Error("Expected session creation.");
    const payload = { type: "ack" as const, ack: {
      acknowledgedThrough: 1,
      eventId: created.event.eventId,
      cursor: created.event.cursor,
    } };
    const command = {
      protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: fixture.record.surfaceSessionId,
      streamId: fixture.record.streamId,
      epoch: fixture.record.epoch,
      commandId: requestIdSchema.parse("command:test"),
      correlationId: correlationIdSchema.parse("correlation:command"),
      payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, payload),
      payload,
    };
    const next = structuredClone(created.session.value);
    next.commandReceipts[command.commandId] = commandReceipt(command, 2, 1);
    const committed = await journal.commit({
      surfaceSessionId: fixture.record.surfaceSessionId,
      expectedVersion: created.session.version,
      next,
      events: [rejected("request:command")],
    });
    if (committed.status !== "committed") throw new Error("Expected command commit.");

    expect(await journal.eventsForCommand(command)).toEqual([...committed.events]);
    expect(await journal.resume({
      cursor: created.event.cursor,
      surfaceSessionId: fixture.record.surfaceSessionId,
      audienceBindingHash: fixture.record.audienceBindingHash,
      now: new Date("2026-08-22T00:30:00.000Z"),
    })).toEqual({ status: "events", events: [...committed.events] });
  });
});
