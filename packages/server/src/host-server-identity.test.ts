import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  actionTypeSchema,
  actionIdSchema,
  catalogIdSchema,
  committedRevisionSchema,
  componentTypeSchema,
  correlationIdSchema,
  documentContentSchema,
  eventPortSchema,
  hashCanonical,
  hashDocumentContent,
  hostCommandEnvelopeSchema,
  publisherIdSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  resourceResolutionResultSchema,
  resourceResolutionIdentitySchema,
  resourceVersionIdSchema,
  stateIdSchema,
  stateRevisionIdSchema,
  stateValueSnapshotSchema,
} from "@open-generative/protocol";
import { createActionContract, createComponentContract } from "@open-generative/catalog";
import { EncryptedSurfaceResumeCursorCodec } from "./event-ledger";
import { HostServer } from "./host-server";
import { InMemorySurfaceSessionJournal } from "./surface-journal";
import { createServerFixture, testHash } from "./test-fixtures";

describe("HostServer identity-reference inputs", () => {
  test("requires exact preconditions while materializing only canonical IDs", async () => {
    const fixture = await createServerFixture();
    const publisher = publisherIdSchema.parse("open-generative");
    const catalogId = catalogIdSchema.parse("official");
    const actionContract = await createActionContract({
      ref: {
        publisher,
        catalogId,
        actionType: actionTypeSchema.parse("identity.capture"),
        revision: 1,
      },
      normalizedInputSchema: {
        type: "object",
        properties: {
          stateId: { type: "string" },
          bindingId: { type: "string" },
        },
        required: ["stateId", "bindingId"],
        additionalProperties: false,
      },
      resultSchema: { type: "object" },
      receiptSchema: { type: "object" },
      reads: [
        { source: "state", required: true },
        { source: "resource", required: true },
      ],
      writes: [],
      effectClass: "read",
      risk: "low",
      idempotencyScope: "surface",
      cancellableUntil: "before-dispatch",
      timeoutPolicy: { timeoutMs: 1_000 },
      retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
    });
    const componentContract = await createComponentContract({
      ref: {
        publisher,
        catalogId,
        componentType: componentTypeSchema.parse("control.identity"),
        revision: 1,
      },
      category: "control",
      resolvedPropsSchema: { type: "object", additionalProperties: false },
      authoringBindings: {},
      slots: {},
      events: {
        [eventPortSchema.parse("activate")]: {
          payloadSchema: { type: "object", additionalProperties: false },
          actionContracts: [actionContract.ref],
        },
      },
      trust: "governed",
      commitPolicy: "atomic",
      readiness: {
        strategy: "all-required",
        requiredBindings: [],
        pendingFallback: "loading",
        failureFallback: "error",
      },
      placements: [{ kind: "panel", minWidth: 320 }],
      accessibility: {
        semanticRole: "form",
        accessibleName: { kind: "host", key: "component-label" },
        keyboardInteractions: ["activate"],
        liveRegion: "off",
        equivalentView: "none",
      },
      prompt: {
        summary: "Trigger an identity-reference action.",
        useWhen: ["An action requires canonical state and resource identities."],
        avoidWhen: [],
        examples: [],
      },
      migrations: [],
    });

    const stateId = stateIdSchema.parse("filter.region");
    const bindingId = resourceBindingIdSchema.parse("dataset.sales");
    const actionId = actionIdSchema.parse("action.identity");
    const eventPort = eventPortSchema.parse("activate");
    const stateRevisionId = stateRevisionIdSchema.parse("state-revision-1");
    const resourceVersionId = resourceVersionIdSchema.parse("resource-version-1");
    const base = fixture.record.committedRevision.content;
    const stateDefinition = {
      schema: { type: "object" },
      schemaHash: testHash("c"),
      initial: { secret: "initial-state-value" },
      sensitivity: "private" as const,
      modelVisibility: "descriptor" as const,
      retention: "retain" as const,
      scope: "surface" as const,
      persistence: "session" as const,
    };
    const resourceBinding = {
      resourceKey: "dataset-sales",
      kind: "dataset",
      schemaConstraint: {
        schemaId: "dataset-sales-schema",
        schemaRevision: 1,
        schemaHash: testHash("d"),
        compatibility: "exact" as const,
      },
      selector: {},
      resolution: {
        mode: "pinned" as const,
        versionId: resourceVersionId,
        contentHash: testHash("e"),
      },
    };
    const content = documentContentSchema.parse({
      ...base,
      requirements: { ...base.requirements, capabilities: [actionContract.ref] },
      nodes: {
        ...base.nodes,
        [base.rootNodeId]: {
          ...base.nodes[base.rootNodeId]!,
          contract: componentContract.ref,
          events: { [eventPort]: actionId },
        },
      },
      stateDefinitions: { [stateId]: stateDefinition },
      actions: {
        [actionId]: {
          kind: "host-intent",
          contract: actionContract.ref,
          input: {
            stateId: { kind: "state-id-ref", stateId },
            bindingId: { kind: "resource-id-ref", bindingId },
          },
        },
      },
      resourceBindings: { [bindingId]: resourceBinding },
    });
    fixture.record.committedRevision = committedRevisionSchema.parse({
      ...fixture.record.committedRevision,
      envelope: {
        ...fixture.record.committedRevision.envelope,
        contentHash: await hashDocumentContent(content),
      },
      content,
    });
    fixture.record.state[stateId] = stateValueSnapshotSchema.parse({
      stateId,
      stateRevisionId,
      schemaHash: stateDefinition.schemaHash,
      scope: "surface",
      value: { secret: "runtime-state-value" },
    });
    fixture.record.resources[bindingId] = resourceResolutionResultSchema.parse({
      status: "resolved",
      snapshot: {
        snapshotId: "snapshot-sales",
        bindingId,
        resourceVersionId,
        schemaHash: resourceBinding.schemaConstraint.schemaHash,
        contentHash: resourceBinding.resolution.contentHash,
        observedAt: "2026-08-22T00:00:00.000Z",
        projectionHash: testHash("f"),
        policyProjectionHash: testHash("0"),
        payload: {
          kind: "json",
          value: { secret: "runtime-resource-payload" },
          byteLength: 37,
        },
        evidenceIds: [],
      },
    });
    fixture.record.resourceResolutionIdentities[bindingId] = resourceResolutionIdentitySchema.parse({
      requestId: "request:identity-resource",
      generation: 1,
      bindingId,
      expectedRevisionId: fixture.record.committedRevision.envelope.revisionId,
      expectedResourceVersionId: resourceVersionId,
    });

    let event = 0;
    const journal = new InMemorySurfaceSessionJournal({
      cursors: new EncryptedSurfaceResumeCursorCodec(new Uint8Array(32).fill(4)),
      eventIdFactory: () => `event:identity:${++event}`,
    });
    await journal.create(fixture.record, {
      correlationId: fixture.initialEvent.correlationId,
      payload: {
        ...fixture.initialEvent.payload,
        snapshot: {
          revision: fixture.record.committedRevision,
          state: fixture.record.state,
          resources: fixture.record.resources,
          resourceResolutionIdentities: fixture.record.resourceResolutionIdentities,
          actions: fixture.record.actions,
          approvals: fixture.record.approvals,
        },
      },
    });

    let captured: Record<string, unknown> | undefined;
    const server = new HostServer({
      journal,
      resources: {} as never,
      capabilities: {
        trigger: async (input: Record<string, unknown>) => {
          captured = input;
          throw new Error("Stop after capturing normalized input.");
        },
      } as never,
      documentState: {} as never,
      components: { resolve: async () => componentContract },
      authorityPolicy: { authorize: async () => ({ allowed: true }) },
      now: () => new Date("2026-08-22T00:30:00.000Z"),
    });
    const statePreconditions = { [stateId]: stateRevisionId };
    const resourcePreconditions = { [bindingId]: resourceVersionId };

    const missingState = await server.handleCommand(
      await actionCommand("command:missing-state", {}, resourcePreconditions),
      fixture.record.authority,
      { operationScope: "test", locale: "en-US", timezone: "UTC" },
    );
    expect(rejectionCode(missingState)).toBe("action.state-precondition-missing");

    const missingResource = await server.handleCommand(
      await actionCommand("command:missing-resource", statePreconditions, {}),
      fixture.record.authority,
      { operationScope: "test", locale: "en-US", timezone: "UTC" },
    );
    expect(rejectionCode(missingResource)).toBe("action.resource-precondition-missing");

    await server.handleCommand(
      await actionCommand("command:complete", statePreconditions, resourcePreconditions),
      fixture.record.authority,
      { operationScope: "test", locale: "en-US", timezone: "UTC" },
    );
    expect(captured).toMatchObject({
      normalizedInput: {
        stateId: "filter.region",
        bindingId: "dataset.sales",
      },
      statePreconditions,
      resourcePreconditions,
    });

    async function actionCommand(
      commandIdText: string,
      state: Record<string, string>,
      resources: Record<string, string>,
    ) {
      const commandId = requestIdSchema.parse(commandIdText);
      const payload = {
        type: "action-trigger-request" as const,
        request: {
          requestId: commandId,
          idempotencyKey: `idempotency:${commandIdText}`,
          surfaceSessionId: fixture.record.surfaceSessionId,
          revisionId: fixture.record.committedRevision.envelope.revisionId,
          nodeId: base.rootNodeId,
          eventPort,
          eventPayload: {},
          statePreconditions: state,
          resourcePreconditions: resources,
        },
      };
      return hostCommandEnvelopeSchema.parse({
        protocol: OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL,
        protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
        surfaceSessionId: fixture.record.surfaceSessionId,
        streamId: fixture.record.streamId,
        epoch: fixture.record.epoch,
        commandId,
        correlationId: correlationIdSchema.parse(`correlation:${commandIdText}`),
        payloadHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, payload),
        payload,
      });
    }
  });
});

function rejectionCode(result: Awaited<ReturnType<HostServer["handleCommand"]>>): string | undefined {
  if (result.status !== "events") return undefined;
  const payload = result.events.at(-1)?.payload;
  return payload?.type === "rejected" ? payload.diagnostics[0]?.code : undefined;
}
