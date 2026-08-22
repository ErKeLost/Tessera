import { describe, expect, test } from "bun:test";
import {
  actionStatusSchema,
  documentContentSchema,
  effectReceiptSchema,
  nodeIdSchema,
  resourceBindingIdSchema,
  resourceResolutionIdentitySchema,
  resourceResolutionResultSchema,
  revisionIdSchema,
  surfaceSnapshotSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  type CanonicalEntityOperation,
  type DocumentContent,
  type SurfaceEventPayload,
} from "@open-generative/protocol";
import { applyCanonicalOperationUnchecked } from "./document-operations";
import { computeValidatedPreviewHash, projectValidatedPreview } from "./preview";
import {
  createSurfaceReplayState,
  reduceTrustedSurfaceEvent,
  renderableRootNodeId,
  resolveRenderableNode,
} from "./replay";
import {
  acceptingValidationPort,
  createCommittedRevision,
  createDocumentContent,
  createSurfaceEvent,
  createSurfaceSnapshot,
  defaultStreamPolicy,
  testHash,
} from "./test-fixtures";

const DATASET_BINDING_ID = resourceBindingIdSchema.parse("dataset");

describe("trusted Surface replay", () => {
  test("buffers bounded gaps, drains in order, and replays identical events idempotently", async () => {
    const fixture = await replayFixture();
    const snapshotEvent = await snapshotPublishedEvent(fixture.base, 1);
    const snapshot = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), snapshotEvent);
    expect(snapshot.status).toBe("applied");

    const previewEvent = await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 3,
      committedRevisionId: fixture.base.envelope.revisionId,
    });
    const buffered = await reduceTrustedSurfaceEvent(snapshot.state, previewEvent);
    expect(buffered.status).toBe("buffered");
    expect(buffered.state.acceptedThroughSequence).toBe(1);

    const middleEvent = await createSurfaceEvent({
      payload: {
        type: "rejected",
        diagnostics: [{
          phase: "validate",
          code: "validate.noop",
          severity: "warning",
          recoverable: true,
          modelCorrectable: false,
          message: "No-op diagnostic.",
        }],
      },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    });
    const drained = await reduceTrustedSurfaceEvent(buffered.state, middleEvent);
    expect(drained.status).toBe("applied");
    expect(drained.state.acceptedThroughSequence).toBe(3);
    expect(drained.state.overlays[fixture.preview.transactionId]?.overlayHash).toBe(fixture.preview.overlayHash);
    expect((await reduceTrustedSurfaceEvent(drained.state, previewEvent)).status).toBe("replayed");
  });

  test("atomically promotes a commit and consumes its only active overlay", async () => {
    const fixture = await replayFixture();
    const initial = await reduceTrustedSurfaceEvent(
      createSurfaceReplayState(),
      await snapshotPublishedEvent(fixture.base, 1),
    );
    const withPreview = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    const committedContent = documentContentSchema.parse(
      applyCanonicalOperationUnchecked(fixture.base.content, fixture.operation),
    );
    const committedRevision = await createCommittedRevision({
      revisionId: "revision-committed",
      parentRevisionIds: [fixture.base.envelope.revisionId],
      content: committedContent,
    });
    const commit = await reduceTrustedSurfaceEvent(withPreview.state, await createSurfaceEvent({
      payload: {
        type: "revision-committed",
        transactionId: fixture.preview.transactionId,
        previousRevisionId: fixture.base.envelope.revisionId,
        consumedOverlayHash: fixture.preview.overlayHash,
        revision: committedRevision,
      },
      sequence: 3,
      committedRevisionId: committedRevision.envelope.revisionId,
      contractSetHash: committedRevision.content.contracts.contractSetHash,
    }));
    expect(commit.status).toBe("applied");
    expect(commit.state.lastGood?.revision.envelope.revisionId).toBe(committedRevision.envelope.revisionId);
    expect(commit.state.overlayOrder).toEqual([]);
    expect(commit.state.overlays).toEqual({});
  });

  test("drops overlays and requires a snapshot on epoch changes or tampering", async () => {
    const fixture = await replayFixture();
    const initial = await reduceTrustedSurfaceEvent(
      createSurfaceReplayState(),
      await snapshotPublishedEvent(fixture.base, 1),
    );
    const withPreview = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    const epochEvent = await createSurfaceEvent({
      payload: { type: "preview-invalidated", transactionId: fixture.preview.transactionId, reason: "epoch-change" },
      sequence: 1,
      epoch: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    });
    const changed = await reduceTrustedSurfaceEvent(withPreview.state, epochEvent);
    expect(changed.status).toBe("resync-required");
    expect(changed.state.requiresSnapshot).toBe(true);
    expect(changed.state.overlays).toEqual({});
    expect(changed.state.lastGood?.revision.envelope.revisionId).toBe(fixture.base.envelope.revisionId);

    const replacement = await reduceTrustedSurfaceEvent(changed.state, await snapshotPublishedEvent(fixture.base, 1, 2));
    expect(replacement.status).toBe("applied");
    expect(replacement.state.epoch).toBe(2);
    expect(replacement.state.requiresSnapshot).toBe(false);

    const valid = await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 2,
      epoch: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    });
    const tampered = {
      ...valid,
      payload: {
        type: "preview-invalidated",
        transactionId: fixture.preview.transactionId,
        reason: "abort",
      },
    };
    const first = await reduceTrustedSurfaceEvent(replacement.state, tampered);
    const second = await reduceTrustedSurfaceEvent(replacement.state, tampered);
    expect(first.status).toBe("resync-required");
    expect(second.state).toEqual(first.state);
    expect(first.issues[0]?.code).toBe("stream.payload-tampered");
  });

  test("rejects broken overlay chains and concurrent transaction overlays", async () => {
    const fixture = await replayFixture();
    const initial = await reduceTrustedSurfaceEvent(
      createSurfaceReplayState(),
      await snapshotPublishedEvent(fixture.base, 1),
    );
    const first = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    const otherPreviewResult = await projectValidatedPreview({
      surfaceSessionId: surfaceSessionIdSchema.parse("surface-test"),
      transactionId: transactionIdSchema.parse("transaction-other"),
      baseRevisionId: fixture.base.envelope.revisionId,
      overlaySequence: 1,
      identityMapDelta: [],
      operations: [fixture.operation],
      document: fixture.draft,
    }, acceptingValidationPort);
    if (!otherPreviewResult.ok) throw new Error("expected preview");
    const concurrent = await reduceTrustedSurfaceEvent(first.state, await createSurfaceEvent({
      payload: { type: "preview-applied", preview: otherPreviewResult.preview },
      sequence: 3,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    expect(concurrent.status).toBe("resync-required");
    expect(concurrent.issues[0]?.code).toBe("stream.preview-concurrent-forbidden");
  });

  test("resolves only explicitly renderable preview nodes and roots", async () => {
    const fixture = await replayFixture();
    const initial = await reduceTrustedSurfaceEvent(
      createSurfaceReplayState(),
      await snapshotPublishedEvent(fixture.base, 1),
    );
    const committed = resolveRenderableNode(initial.state, nodeIdSchema.parse("root"));
    expect(committed?.projectionMode).toBe("committed");
    expect(committed?.node.props.gap).toEqual({ kind: "literal", value: "md" });

    const withPreview = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: { type: "preview-applied", preview: fixture.preview },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    const preview = resolveRenderableNode(withPreview.state, nodeIdSchema.parse("root"));
    expect(preview?.projectionMode).toBe("read-only-preview");
    expect(preview?.node.props.gap).toEqual({ kind: "literal", value: "xl" });
    expect(renderableRootNodeId(withPreview.state)).toBe(nodeIdSchema.parse("root"));

    const { overlayHash: _overlayHash, ...previewWithoutHash } = fixture.preview;
    const hiddenPreview = {
      ...previewWithoutHash,
      renderableNodeIds: [],
      disabledActionIds: [],
    };
    const hiddenState = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "preview-applied",
        preview: {
          ...hiddenPreview,
          overlayHash: await computeValidatedPreviewHash(hiddenPreview),
        },
      },
      sequence: 2,
      committedRevisionId: fixture.base.envelope.revisionId,
    }));
    expect(resolveRenderableNode(hiddenState.state, nodeIdSchema.parse("root"))?.projectionMode).toBe("committed");
    expect(renderableRootNodeId(hiddenState.state)).toBe(fixture.base.content.rootNodeId);
  });

  test("requires the exact disabled action set for every renderable preview node", async () => {
    const original = createDocumentContent();
    const content = documentContentSchema.parse({
      ...original,
      nodes: {
        ...original.nodes,
        root: {
          ...original.nodes[nodeIdSchema.parse("root")]!,
          events: { activate: "action-preview" },
        },
      },
      actions: {
        "action-preview": {
          kind: "local-transition",
          transitions: [{ type: "node.focus", nodeId: "root" }],
        },
      },
    });
    const base = await createCommittedRevision({ content });
    const operation: CanonicalEntityOperation = {
      op: "put-node",
      nodeId: nodeIdSchema.parse("root"),
      value: {
        ...content.nodes[nodeIdSchema.parse("root")]!,
        props: { gap: { kind: "literal", value: "lg" } },
      },
    };
    const draft = documentContentSchema.parse({
      ...content,
      nodes: { ...content.nodes, root: operation.value },
    });
    const projected = await projectValidatedPreview({
      surfaceSessionId: surfaceSessionIdSchema.parse("surface-test"),
      transactionId: transactionIdSchema.parse("transaction-actions"),
      baseRevisionId: base.envelope.revisionId,
      overlaySequence: 1,
      identityMapDelta: [],
      operations: [operation],
      document: draft,
    }, acceptingValidationPort);
    if (!projected.ok) throw new Error("expected preview");
    expect(projected.preview.disabledActionIds.map(String)).toEqual(["action-preview"]);

    const { overlayHash: _overlayHash, ...withoutHash } = projected.preview;
    const incomplete = { ...withoutHash, disabledActionIds: [] };
    const initial = await reduceTrustedSurfaceEvent(
      createSurfaceReplayState(),
      await snapshotPublishedEvent(base, 1),
    );
    const result = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "preview-applied",
        preview: {
          ...incomplete,
          overlayHash: await computeValidatedPreviewHash(incomplete),
        },
      },
      sequence: 2,
      committedRevisionId: base.envelope.revisionId,
    }));
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.preview-disabled-actions-inexact");
  });

  test("rejects exact-schema resource mismatches in trusted full snapshots", async () => {
    const original = createDocumentContent();
    const content = documentContentSchema.parse({
      ...original,
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
            mode: "pinned",
            versionId: "resource-version-1",
            contentHash: testHash("5"),
          },
        },
      },
    });
    const revision = await createCommittedRevision({ content });
    const snapshot = surfaceSnapshotSchema.parse({
      ...createSurfaceSnapshot(revision),
      resources: {
        dataset: {
          status: "resolved",
          snapshot: {
            snapshotId: "snapshot-dataset",
            bindingId: "dataset",
            resourceVersionId: "resource-version-1",
            schemaHash: testHash("6"),
            contentHash: testHash("7"),
            observedAt: "2026-08-22T00:00:00Z",
            projectionHash: testHash("8"),
            policyProjectionHash: testHash("9"),
            payload: { kind: "json", value: [], byteLength: 2 },
            evidenceIds: [],
          },
        },
      },
      resourceResolutionIdentities: {
        dataset: {
          requestId: "request-resource-schema-mismatch",
          generation: 0,
          bindingId: "dataset",
          expectedRevisionId: revision.envelope.revisionId,
        },
      },
    });
    const event = await createSurfaceEvent({
      payload: { type: "snapshot-published", snapshot, streamPolicy: defaultStreamPolicy },
      sequence: 1,
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    });
    const result = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), event);
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.snapshot-resource-schema-mismatch");
  });

  test("accepts only the exact current pending resource identity and rejects stale generations", async () => {
    const revision = await createResourceRevision();
    const pendingIdentity = resourceResolutionIdentitySchema.parse({
      requestId: "request-resource-current",
      generation: 2,
      bindingId: DATASET_BINDING_ID,
      expectedRevisionId: revision.envelope.revisionId,
    });
    const snapshot = surfaceSnapshotSchema.parse({
      ...createSurfaceSnapshot(revision),
      resourceResolutionIdentities: { [DATASET_BINDING_ID]: pendingIdentity },
    });
    const initial = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), await createSurfaceEvent({
      payload: { type: "snapshot-published", snapshot, streamPolicy: defaultStreamPolicy },
      sequence: 1,
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));

    const wrongCurrent = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "resource-resolved",
        identity: resourceResolutionIdentitySchema.parse({
          ...pendingIdentity,
          requestId: "request-resource-other",
        }),
        result: resolvedDataset("snapshot-wrong-current"),
      },
      sequence: 2,
      eventId: "event-resource-wrong-current",
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));
    expect(wrongCurrent.status).toBe("resync-required");
    expect(wrongCurrent.issues[0]?.code).toBe("stream.resource-resolution-identity-not-current");

    const completed = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "resource-resolved",
        identity: pendingIdentity,
        result: resolvedDataset("snapshot-current"),
      },
      sequence: 2,
      eventId: "event-resource-current",
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));
    expect(completed.status).toBe("applied");
    expect(completed.state.lastGood?.resourceResolutionIdentities[DATASET_BINDING_ID]).toEqual(pendingIdentity);

    const stale = await reduceTrustedSurfaceEvent(completed.state, await createSurfaceEvent({
      payload: {
        type: "resource-resolved",
        identity: resourceResolutionIdentitySchema.parse({
          ...pendingIdentity,
          requestId: "request-resource-stale",
          generation: 1,
          expectedResourceVersionId: "resource-version-1",
        }),
        result: resolvedDataset("snapshot-stale"),
      },
      sequence: 3,
      eventId: "event-resource-stale",
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));
    expect(stale.status).toBe("resync-required");
    expect(stale.issues[0]?.code).toBe("stream.resource-resolution-stale");
    expect(stale.state.lastGood?.resources[DATASET_BINDING_ID]).toEqual(resolvedDataset("snapshot-current"));
  });

  test("rejects a newer resource generation whose version precondition is not current", async () => {
    const revision = await createResourceRevision();
    const snapshot = surfaceSnapshotSchema.parse({
      ...createSurfaceSnapshot(revision),
      resources: { [DATASET_BINDING_ID]: resolvedDataset("snapshot-baseline") },
      resourceResolutionIdentities: {
        [DATASET_BINDING_ID]: {
          requestId: "request-resource-baseline",
          generation: 1,
          bindingId: DATASET_BINDING_ID,
          expectedRevisionId: revision.envelope.revisionId,
        },
      },
    });
    const initial = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), await createSurfaceEvent({
      payload: { type: "snapshot-published", snapshot, streamPolicy: defaultStreamPolicy },
      sequence: 1,
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));
    const result = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "resource-resolved",
        identity: resourceResolutionIdentitySchema.parse({
          requestId: "request-resource-wrong-version",
          generation: 2,
          bindingId: DATASET_BINDING_ID,
          expectedRevisionId: revision.envelope.revisionId,
          expectedResourceVersionId: "resource-version-other",
        }),
        result: resolvedDataset("snapshot-wrong-version"),
      },
      sequence: 2,
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    }));
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.resource-resolution-version-precondition-mismatch");
  });

  test("rejects state values that fail their exact schema during trusted snapshot replay", async () => {
    const original = createDocumentContent();
    const content = documentContentSchema.parse({
      ...original,
      stateDefinitions: {
        count: {
          schema: { type: "integer", minimum: 0 },
          schemaHash: testHash("4"),
          initial: 0,
          sensitivity: "public",
          modelVisibility: "value",
          retention: "retain",
          scope: "surface",
          persistence: "session",
        },
      },
    });
    const revision = await createCommittedRevision({ content });
    const snapshot = surfaceSnapshotSchema.parse({
      ...createSurfaceSnapshot(revision),
      state: {
        count: {
          stateId: "count",
          stateRevisionId: "state-revision-invalid-count",
          schemaHash: testHash("4"),
          scope: "surface",
          value: "not-an-integer",
        },
      },
    });
    const event = await createSurfaceEvent({
      payload: { type: "snapshot-published", snapshot, streamPolicy: defaultStreamPolicy },
      sequence: 1,
      committedRevisionId: revision.envelope.revisionId,
      contractSetHash: revision.content.contracts.contractSetHash,
    });
    const result = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), event, {
      stateValidation: {
        validateSurfaceStateValue: ({ value }) => Number.isInteger(value)
          ? []
          : [{ code: "state.integer-required", message: "State value must be an integer." }],
      },
    });
    expect(result.status).toBe("resync-required");
    expect(result.issues[0]?.code).toBe("stream.snapshot-state-schema-invalid");
  });

  test("rejects action status regressions and effect receipt identity reuse", async () => {
    const revision = await createCommittedRevision();
    const invocationId = "invocation-test";
    const snapshot = surfaceSnapshotSchema.parse({
      ...createSurfaceSnapshot(revision),
      actions: {
        [invocationId]: actionStatusSchema.parse({
          invocationId,
          status: "accepted",
          updatedAt: "2026-08-22T00:00:00Z",
        }),
      },
    });
    const initial = await reduceTrustedSurfaceEvent(createSurfaceReplayState(), await createSurfaceEvent({
      payload: { type: "snapshot-published", snapshot, streamPolicy: defaultStreamPolicy },
      sequence: 1,
      committedRevisionId: revision.envelope.revisionId,
    }));
    const running = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: {
        type: "action-status",
        action: actionStatusSchema.parse({
          invocationId,
          status: "running",
          updatedAt: "2026-08-22T00:01:00Z",
        }),
      },
      sequence: 2,
      committedRevisionId: revision.envelope.revisionId,
    }));
    expect(running.status).toBe("applied");
    const regressed = await reduceTrustedSurfaceEvent(running.state, await createSurfaceEvent({
      payload: {
        type: "action-status",
        action: actionStatusSchema.parse({
          invocationId,
          status: "awaiting-approval",
          updatedAt: "2026-08-22T00:02:00Z",
        }),
      },
      sequence: 3,
      committedRevisionId: revision.envelope.revisionId,
    }));
    expect(regressed.status).toBe("resync-required");
    expect(regressed.issues[0]?.code).toBe("stream.action-status-regression");

    const firstReceipt = effectReceiptSchema.parse({
      receiptId: "receipt-one",
      invocationId,
      actionContract: {
        publisher: "open-generative",
        catalogId: "official",
        actionType: "data.export",
        revision: 1,
        contractHash: testHash("3"),
      },
      idempotencyKeyHash: testHash("4"),
      normalizedInputHash: testHash("5"),
      effectSummaryHash: testHash("6"),
      outcome: { status: "succeeded", receipt: {}, result: null, resultHash: testHash("7") },
      resultingStateRevisions: {},
      resultingResourceVersions: {},
      startedAt: "2026-08-22T00:01:00Z",
      completedAt: "2026-08-22T00:02:00Z",
    });
    const withReceipt = await reduceTrustedSurfaceEvent(initial.state, await createSurfaceEvent({
      payload: { type: "effect-receipt", receipt: firstReceipt },
      sequence: 2,
      committedRevisionId: revision.envelope.revisionId,
      eventId: "event-receipt-2",
    }));
    expect(withReceipt.status).toBe("applied");
    const reused = await reduceTrustedSurfaceEvent(withReceipt.state, await createSurfaceEvent({
      payload: {
        type: "effect-receipt",
        receipt: effectReceiptSchema.parse({ ...firstReceipt, receiptId: "receipt-two" }),
      },
      sequence: 3,
      committedRevisionId: revision.envelope.revisionId,
      eventId: "event-receipt-3",
    }));
    expect(reused.status).toBe("resync-required");
    expect(reused.issues[0]?.code).toBe("stream.effect-receipt-invocation-reused");
  });
});

async function replayFixture() {
  const base = await createCommittedRevision();
  const operation: CanonicalEntityOperation = {
    op: "put-node",
    nodeId: nodeIdSchema.parse("root"),
    value: {
      ...base.content.nodes[nodeIdSchema.parse("root")]!,
      props: { gap: { kind: "literal", value: "xl" } },
    },
  };
  const draft = {
    ...base.content,
    nodes: { ...base.content.nodes, root: operation.value },
  } as DocumentContent;
  const projected = await projectValidatedPreview({
    surfaceSessionId: surfaceSessionIdSchema.parse("surface-test"),
    transactionId: transactionIdSchema.parse("transaction-preview"),
    baseRevisionId: base.envelope.revisionId,
    overlaySequence: 1,
    identityMapDelta: [],
    operations: [operation],
    document: draft,
  }, acceptingValidationPort);
  if (!projected.ok) throw new Error("expected valid preview");
  return { base, operation, draft, preview: projected.preview };
}

async function createResourceRevision() {
  const content = documentContentSchema.parse({
    ...createDocumentContent(),
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
          mode: "pinned",
          versionId: "resource-version-1",
          contentHash: testHash("5"),
        },
      },
    },
  });
  return createCommittedRevision({ content });
}

function resolvedDataset(snapshotId: string) {
  return resourceResolutionResultSchema.parse({
    status: "resolved",
    snapshot: {
      snapshotId,
      bindingId: DATASET_BINDING_ID,
      resourceVersionId: "resource-version-1",
      schemaHash: testHash("4"),
      contentHash: testHash("5"),
      observedAt: "2026-08-22T00:00:00Z",
      projectionHash: testHash("8"),
      policyProjectionHash: testHash("9"),
      payload: { kind: "json", value: [], byteLength: 2 },
      evidenceIds: [],
    },
  });
}

async function snapshotPublishedEvent(
  revision: Awaited<ReturnType<typeof createCommittedRevision>>,
  sequence: number,
  epoch = 1,
) {
  const payload: SurfaceEventPayload = {
    type: "snapshot-published",
    snapshot: createSurfaceSnapshot(revision),
    streamPolicy: defaultStreamPolicy,
  };
  return createSurfaceEvent({
    payload,
    sequence,
    epoch,
    committedRevisionId: revision.envelope.revisionId,
    contractSetHash: revision.content.contracts.contractSetHash,
  });
}
