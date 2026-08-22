import { describe, expect, test } from "bun:test";
import {
  committedRevisionSchema,
  hashDocumentContent,
  verifyHostCommandEnvelope,
  type HostCommandEnvelope,
} from "@open-generative/protocol";
import { SurfaceController } from "./surface-controller";
import {
  AUDIENCE_HASH,
  HIDDEN_RESOURCE_ID,
  HIDDEN_STATE_ID,
  ROOT_NODE_ID,
  SURFACE_ID,
  SUBMIT_PORT,
  VISIBLE_RESOURCE_ID,
  VISIBLE_STATE_ID,
  createClientFixture,
  createDeterministicIdentities,
  createPreviewFixture,
  createRecordingTransport,
  createSnapshotEvent,
  createSurfaceEvent,
  rejectedPayload,
  testHash,
} from "./test-fixtures";

describe("SurfaceController trusted replay", () => {
  test("buffers bounded gaps, drains in order, detects replay, and fails closed on tampering", async () => {
    const fixture = await createClientFixture();
    const transport = createRecordingTransport();
    const controller = controllerFor(fixture, transport);
    let notifications = 0;
    controller.subscribe(() => { notifications += 1; });
    const initial = await createSnapshotEvent(fixture);
    expect((await controller.consume(initial)).status).toBe("applied");

    const previewFixture = await createPreviewFixture(fixture);
    const third = await createSurfaceEvent(fixture, {
      sequence: 3,
      payload: rejectedPayload(),
    });
    expect((await controller.consume(third)).status).toBe("buffered");
    expect(controller.getSnapshot().acceptedThroughSequence).toBe(1);

    const second = await createSurfaceEvent(fixture, {
      sequence: 2,
      payload: { type: "preview-applied", preview: previewFixture.preview },
    });
    expect((await controller.consume(second)).status).toBe("applied");
    expect(controller.getSnapshot().acceptedThroughSequence).toBe(3);
    expect(controller.getSnapshot().preview?.overlayHash).toBe(previewFixture.preview.overlayHash);

    const stableSnapshot = controller.getSnapshot();
    const stableNotifications = notifications;
    expect((await controller.consume(third)).status).toBe("replayed");
    expect(controller.getSnapshot()).toBe(stableSnapshot);
    expect(notifications).toBe(stableNotifications);

    const fourth = await createSurfaceEvent(fixture, {
      sequence: 4,
      payload: {
        type: "preview-invalidated",
        transactionId: previewFixture.preview.transactionId,
        reason: "abort",
      },
    });
    const tampered = {
      ...fourth,
      payload: { ...fourth.payload, reason: "timeout" },
    };
    const result = await controller.consume(tampered);
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.payload-tampered");
    expect(result.snapshot.status).toBe("resync-required");
    expect(result.snapshot.preview).toBeUndefined();
    expect(result.snapshot.committedRevisionId).toBe(fixture.revision.envelope.revisionId);
  });

  test("invalidates previews and atomically promotes commits without exposing an emitter", async () => {
    const fixture = await createClientFixture();
    const transport = createRecordingTransport();
    const controller = controllerFor(fixture, transport);
    await controller.consume(await createSnapshotEvent(fixture));
    const committed = controller.bindNode(ROOT_NODE_ID);
    expect(committed?.projectionMode).toBe("committed");
    expect(committed?.commands?.emit).toBeFunction();

    const projected = await createPreviewFixture(fixture);
    await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 2,
      payload: { type: "preview-applied", preview: projected.preview },
    }));
    const preview = controller.bindNode(ROOT_NODE_ID);
    expect(preview?.projectionMode).toBe("read-only-preview");
    expect(preview?.resolvedProps).toEqual({ value: "preview-value" });
    expect(preview?.commands).toBeUndefined();
    await expect(committed!.commands!.emit!(SUBMIT_PORT, { query: "stale" })).rejects.toMatchObject({
      code: "client.node-preview-read-only",
    });

    await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 3,
      payload: {
        type: "preview-invalidated",
        transactionId: projected.preview.transactionId,
        invalidatedOverlayHash: projected.preview.overlayHash,
        reason: "abort",
      },
    }));
    expect(controller.getSnapshot().preview).toBeUndefined();
    expect(controller.bindNode(ROOT_NODE_ID)?.resolvedProps).toEqual({ value: "trusted-visible" });

    const projectedAgain = await createPreviewFixture(fixture);
    await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 4,
      payload: { type: "preview-applied", preview: projectedAgain.preview },
    }));
    await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 5,
      committedRevisionId: projectedAgain.revision.envelope.revisionId,
      payload: {
        type: "revision-committed",
        transactionId: projectedAgain.preview.transactionId,
        previousRevisionId: fixture.revision.envelope.revisionId,
        consumedOverlayHash: projectedAgain.preview.overlayHash,
        revision: projectedAgain.revision,
      },
    }));
    expect(controller.getSnapshot().preview).toBeUndefined();
    expect(controller.getSnapshot().committedRevisionId).toBe(projectedAgain.revision.envelope.revisionId);
    expect(controller.bindNode(ROOT_NODE_ID)).toMatchObject({
      projectionMode: "committed",
      status: "ready",
      resolvedProps: { value: "preview-value" },
    });
  });

  test("rejects an audience or Contract-set binding change before mounting it", async () => {
    const fixture = await createClientFixture();
    const controller = controllerFor(fixture, createRecordingTransport());
    const wrongAudience = await createSnapshotEvent(fixture, 1, { audienceBindingHash: testHash("f") });
    expect((await controller.consume(wrongAudience)).issues[0]?.code).toBe("client.audience-binding-mismatch");
    expect(controller.getSnapshot().status).toBe("resync-required");

    const recovered = await controller.consume(await createSnapshotEvent(fixture));
    expect(recovered.status).toBe("applied");
    expect(controller.getSnapshot().status).toBe("ready");

    const wrongContracts = await createSurfaceEvent(fixture, {
      sequence: 2,
      contractSetHash: testHash("e"),
      payload: rejectedPayload("test.contract-change"),
    });
    expect((await controller.consume(wrongContracts)).issues[0]?.code).toBe("client.contract-set-mismatch");
    expect(controller.bindNode(ROOT_NODE_ID)).toBeUndefined();
  });

  test("refuses to mount a node whose slots violate the verified browser Contract", async () => {
    const fixture = await createClientFixture();
    const content = structuredClone(fixture.content);
    content.nodes[ROOT_NODE_ID]!.slots.undeclared = [];
    const revision = committedRevisionSchema.parse({
      ...fixture.revision,
      envelope: {
        ...fixture.revision.envelope,
        contentHash: await hashDocumentContent(content),
      },
      content,
    });
    const snapshot = { ...fixture.snapshot, revision };
    const controller = controllerFor(fixture, createRecordingTransport());
    await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 1,
      payload: { type: "snapshot-published", snapshot, streamPolicy: fixture.streamPolicy },
    }));

    expect(controller.bindNode(ROOT_NODE_ID)).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "client.slot-unknown" }],
    });
  });

  test("rejects a trusted snapshot whose state value fails its exact JSON Schema", async () => {
    const fixture = await createClientFixture();
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.state[VISIBLE_STATE_ID]!.value = 42;
    const controller = controllerFor(fixture, createRecordingTransport());
    const result = await controller.consume(await createSurfaceEvent(fixture, {
      sequence: 1,
      payload: { type: "snapshot-published", snapshot, streamPolicy: fixture.streamPolicy },
    }));
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.snapshot-state-schema-invalid");
    expect(controller.bindNode(ROOT_NODE_ID)).toBeUndefined();
  });
});

describe("SurfaceController node command bridge", () => {
  test("hashes exact commands and enforces node-scoped state, resource, and event access", async () => {
    const fixture = await createClientFixture();
    const transport = createRecordingTransport();
    const controller = controllerFor(fixture, transport);
    await controller.consume(await createSnapshotEvent(fixture));
    const node = controller.bindNode(ROOT_NODE_ID);
    expect(node?.status).toBe("ready");
    expect(Object.keys(node!.stateBindings)).toEqual([VISIBLE_STATE_ID]);
    expect(Object.keys(node!.resourceBindings)).toEqual([]);

    const stateCommand = await node!.commands!.writeState!(VISIBLE_STATE_ID, "next-visible");
    expect(stateCommand.payload).toMatchObject({
      type: "state-write-request",
      request: {
        expectedRevisionId: fixture.revision.envelope.revisionId,
        stateId: VISIBLE_STATE_ID,
        expectedStateRevisionId: "state-revision-visible",
      },
    });
    await expect(node!.commands!.writeState!(HIDDEN_STATE_ID, "forbidden")).rejects.toMatchObject({
      code: "client.state-out-of-scope",
    });

    const resourceCommand = await node!.commands!.requestResource(VISIBLE_RESOURCE_ID);
    expect(resourceCommand.payload).toMatchObject({
      type: "resource-window-request",
      request: {
        bindingId: VISIBLE_RESOURCE_ID,
        expectedResourceVersionId: "resource-version-visible",
      },
    });
    await expect(node!.commands!.requestResource(HIDDEN_RESOURCE_ID)).rejects.toMatchObject({
      code: "client.resource-out-of-scope",
    });

    const actionResult = await node!.commands!.emit!(SUBMIT_PORT, { query: "show me" });
    expect(actionResult.kind).toBe("host-command");
    if (actionResult.kind !== "host-command") throw new Error("Expected Host command.");
    expect(actionResult.command.payload).toMatchObject({
      type: "action-trigger-request",
      request: {
        nodeId: ROOT_NODE_ID,
        eventPort: "submit",
        statePreconditions: { [VISIBLE_STATE_ID]: "state-revision-visible" },
        resourcePreconditions: { [VISIBLE_RESOURCE_ID]: "resource-version-visible" },
      },
    });
    await expect(node!.commands!.emit!(SUBMIT_PORT, { query: 42 } as any)).rejects.toMatchObject({
      code: "client.event-payload-invalid",
    });

    for (const command of transport.commands as HostCommandEnvelope[]) {
      expect(await verifyHostCommandEnvelope(command)).toBe(true);
      expect(command.surfaceSessionId).toBe(SURFACE_ID);
    }
    expect(transport.commands).toHaveLength(3);
  });

  test("orchestrates acknowledgement and resume from the accepted trusted cursor", async () => {
    const fixture = await createClientFixture();
    const transport = createRecordingTransport();
    const controller = controllerFor(fixture, transport);
    await controller.consume(await createSnapshotEvent(fixture));

    const ack = await controller.acknowledge();
    expect(ack?.payload).toMatchObject({
      type: "ack",
      ack: { acknowledgedThrough: 1, eventId: "event-1-1" },
    });
    expect(controller.getSnapshot().acknowledgedThroughSequence).toBe(1);

    const resume = await controller.resume();
    expect(resume.payload).toMatchObject({
      type: "resume-request",
      request: {
        acknowledgedThrough: 1,
        cursor: "cursor-client-0001-0001",
      },
    });
    expect(await verifyHostCommandEnvelope(resume)).toBe(true);
  });
});

function controllerFor(
  fixture: Awaited<ReturnType<typeof createClientFixture>>,
  transport: ReturnType<typeof createRecordingTransport>,
) {
  return new SurfaceController({
    surfaceSessionId: SURFACE_ID,
    audienceBindingHash: AUDIENCE_HASH,
    contracts: fixture.registry,
    transport,
    identities: createDeterministicIdentities(),
    autoAcknowledge: false,
    clock: () => new Date("2026-08-22T01:00:00Z"),
  });
}
