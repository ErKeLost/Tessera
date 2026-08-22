import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  committedRevisionSchema,
  documentContentSchema,
  hashCanonical,
  hashDocumentContent,
  hostCommandEnvelopeSchema,
  resourceBindingIdSchema,
  resourceResolutionResultSchema,
  type HostCommandEnvelope,
  type ResourceResolutionResult,
} from "@open-generative/protocol";
import type { ResourceGateway } from "@open-generative/resources";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import { HostServer } from "./host-server";
import { InMemorySurfaceSessionJournal } from "./surface-journal";
import { createServerFixture, testHash } from "./test-fixtures";

const DATASET_BINDING_ID = resourceBindingIdSchema.parse("dataset");

describe("HostServer resource resolution ordering", () => {
  test("rejects an old request that finishes after a newer request has committed", async () => {
    const fixture = await createServerFixture();
    const content = documentContentSchema.parse({
      ...fixture.record.committedRevision.content,
      resourceBindings: {
        dataset: {
          resourceKey: "tessera-dataset",
          kind: "dataset",
          schemaConstraint: {
            schemaId: "schema-dataset",
            schemaRevision: 1,
            schemaHash: testHash("4"),
            compatibility: "exact",
          },
          selector: {},
          resolution: {
            mode: "live",
            channelId: "dataset-live",
            freshness: { maxAgeMs: 1_000, staleIfErrorMs: 5_000 },
            schemaCompatibility: "exact",
          },
        },
      },
    });
    const revision = committedRevisionSchema.parse({
      ...fixture.record.committedRevision,
      envelope: {
        ...fixture.record.committedRevision.envelope,
        contentHash: await hashDocumentContent(content),
      },
      content,
    });
    const record = structuredClone(fixture.record);
    record.committedRevision = revision;
    record.resources = {};
    record.resourceResolutionIdentities = {};

    let eventSequence = 0;
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(7)),
      eventIdFactory: () => `event:resource:${++eventSequence}`,
    });
    const created = await journal.create(record, {
      correlationId: fixture.initialEvent.correlationId,
      payload: {
        type: "snapshot-published",
        snapshot: {
          revision,
          state: record.state,
          resources: record.resources,
          resourceResolutionIdentities: record.resourceResolutionIdentities,
          actions: record.actions,
          approvals: record.approvals,
        },
        streamPolicy: record.streamPolicy,
      },
    });
    if (created.status !== "created") throw new Error("Expected Surface creation.");

    const oldStarted = deferred<void>();
    const newStarted = deferred<void>();
    const oldResult = deferred<ResourceResolutionResult>();
    const newResult = deferred<ResourceResolutionResult>();
    const resources = {
      resolve: async (input: Readonly<{ request: { requestId: string } }>) => {
        if (input.request.requestId === "request:resource:old") {
          oldStarted.resolve(undefined);
          return oldResult.promise;
        }
        if (input.request.requestId === "request:resource:new") {
          newStarted.resolve(undefined);
          return newResult.promise;
        }
        throw new Error("Unexpected resource request.");
      },
    } as unknown as ResourceGateway;
    const server = new HostServer({
      journal,
      resources,
      capabilities: {} as never,
      documentState: {} as never,
      components: { resolve: async () => fixture.contract },
      authorityPolicy: { authorize: async () => ({ allowed: true }) },
      now: () => new Date("2026-08-22T00:30:00.000Z"),
    });
    const context = { operationScope: "test", locale: "en-US", timezone: "UTC" };
    const oldCommand = await resourceCommand(record, "request:resource:old");
    const newCommand = await resourceCommand(record, "request:resource:new");

    const oldRun = server.handleCommand(oldCommand, record.authority, context);
    await oldStarted.promise;
    const newRun = server.handleCommand(newCommand, record.authority, context);
    await newStarted.promise;

    newResult.resolve(resolved("snapshot-resource-new", "new"));
    const newer = await newRun;
    expect(newer.status).toBe("events");
    if (newer.status !== "events") throw new Error("Expected resource event.");
    expect(newer.events[0]?.payload).toMatchObject({
      type: "resource-resolved",
      identity: {
        requestId: "request:resource:new",
        generation: 2,
        bindingId: "dataset",
        expectedRevisionId: revision.envelope.revisionId,
      },
    });

    oldResult.resolve(resolved("snapshot-resource-old", "old"));
    const older = await oldRun;
    expect(older.status).toBe("events");
    if (older.status !== "events") throw new Error("Expected stale rejection event.");
    expect(older.events[0]?.payload).toMatchObject({
      type: "rejected",
      requestId: "request:resource:old",
      diagnostics: [{ code: "resource.resolution-stale" }],
    });

    const stored = await journal.get(record.surfaceSessionId);
    expect(stored?.value.resourceResolutionIdentities[DATASET_BINDING_ID]).toMatchObject({
      requestId: "request:resource:new",
      generation: 2,
    });
    expect(stored?.value.resources[DATASET_BINDING_ID]).toEqual(resolved("snapshot-resource-new", "new"));

    const stalePrecondition = await server.handleCommand(
      await resourceCommand(record, "request:resource:wrong-version", "resource-version-other"),
      record.authority,
      context,
    );
    expect(stalePrecondition.status).toBe("events");
    if (stalePrecondition.status !== "events") throw new Error("Expected version rejection event.");
    expect(stalePrecondition.events[0]?.payload).toMatchObject({
      type: "rejected",
      diagnostics: [{ code: "resource.version-precondition-conflict" }],
    });
  });
});

async function resourceCommand(
  record: Awaited<ReturnType<typeof createServerFixture>>["record"],
  requestId: string,
  expectedResourceVersionId?: string,
): Promise<HostCommandEnvelope> {
  const payload = {
    type: "resource-window-request" as const,
    request: {
      requestId,
      bindingId: "dataset",
      surfaceSessionId: record.surfaceSessionId,
      expectedRevisionId: record.committedRevision.envelope.revisionId,
      ...(expectedResourceVersionId === undefined ? {} : { expectedResourceVersionId }),
    },
  };
  return hostCommandEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: record.surfaceSessionId,
    streamId: record.streamId,
    epoch: record.epoch,
    commandId: requestId,
    correlationId: `correlation:${requestId}`,
    payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, payload),
    payload,
  });
}

function resolved(snapshotId: string, source: string): ResourceResolutionResult {
  return resourceResolutionResultSchema.parse({
    status: "resolved",
    snapshot: {
      snapshotId,
      bindingId: "dataset",
      resourceVersionId: "resource-version-1",
      schemaHash: testHash("4"),
      contentHash: testHash("5"),
      observedAt: "2026-08-22T00:00:00.000Z",
      projectionHash: testHash("6"),
      policyProjectionHash: testHash("7"),
      payload: { kind: "json", value: { source }, byteLength: 16 },
      evidenceIds: [],
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
