import { z } from "zod";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  actionIdSchema,
  actionTypeSchema,
  catalogIdSchema,
  committedRevisionSchema,
  componentTypeSchema,
  documentContentSchema,
  eventPortSchema,
  hashCanonical,
  hashDocumentContent,
  jsonPointerSchema,
  nodeIdSchema,
  publisherIdSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  stateIdSchema,
  surfaceSessionIdSchema,
  surfaceEventEnvelopeSchema,
  surfaceSnapshotSchema,
  transactionIdSchema,
  type CanonicalEntityOperation,
  type CommittedRevision,
  type DocumentContent,
  type SurfaceEventEnvelope,
  type HostCommandEnvelope,
  type SurfaceEventPayload,
  type SurfaceSnapshot,
} from "@open-generative/protocol";
import {
  createActionContract,
  createComponentContract,
  type ActionContract,
  type ComponentContract,
} from "@open-generative/catalog";
import {
  applyCanonicalOperationUnchecked,
  projectValidatedPreview,
  type RuntimeValidationPort,
} from "@open-generative/runtime";
import {
  createBrowserContractRegistry,
  createZodClientValidator,
  type BrowserContractRegistry,
  type HostCommandIdentityFactory,
  type HostCommandTransport,
} from "./index";

export const SURFACE_ID = surfaceSessionIdSchema.parse("surface-client-test");
export const STREAM_ID = "stream-client-test";
export const ROOT_NODE_ID = nodeIdSchema.parse("root");
export const VISIBLE_STATE_ID = stateIdSchema.parse("visible-state");
export const HIDDEN_STATE_ID = stateIdSchema.parse("hidden-state");
export const VISIBLE_RESOURCE_ID = resourceBindingIdSchema.parse("visible-resource");
export const HIDDEN_RESOURCE_ID = resourceBindingIdSchema.parse("hidden-resource");
export const ACTION_ID = actionIdSchema.parse("submit-action");
export const SUBMIT_PORT = eventPortSchema.parse("submit");
const FIXTURE_PUBLISHER = publisherIdSchema.parse("open-generative");
const FIXTURE_CATALOG = catalogIdSchema.parse("fixture");
const VALUE_POINTER = jsonPointerSchema.parse("/value");
export const AUDIENCE_HASH = testHash("a");

export type ClientFixture = Awaited<ReturnType<typeof createClientFixture>>;

export async function createClientFixture(ackEveryEvents = 64) {
  const actionContract = await createFixtureActionContract();
  const componentContract = await createFixtureComponentContract(actionContract);
  const registry = await createFixtureRegistry(componentContract);
  const content = createFixtureDocument(componentContract, actionContract, registry);
  const revision = await createFixtureRevision(content);
  const snapshot = createFixtureSnapshot(revision);
  const streamPolicy = {
    maxSequenceGap: 8,
    maxBufferedBytes: 256_000,
    ackEveryEvents,
    backpressure: "publish-snapshot" as const,
    cursorExpiresAt: "2026-08-23T00:00:00Z",
  };
  return {
    actionContract,
    componentContract,
    registry,
    content,
    revision,
    snapshot,
    streamPolicy,
  };
}

export function createRecordingTransport(): HostCommandTransport & { commands: HostCommandEnvelope[] } {
  const commands: HostCommandEnvelope[] = [];
  return {
    commands,
    send: (command) => {
      commands.push(command);
    },
  };
}

export function createDeterministicIdentities(): HostCommandIdentityFactory {
  let sequence = 0;
  const next = () => String(++sequence).padStart(4, "0");
  return {
    requestId: () => `request-client-${next()}`,
    correlationId: () => `correlation-client-${next()}`,
    idempotencyKey: () => `idempotency-client-fixture-${next()}`,
  } as HostCommandIdentityFactory;
}

export async function createSnapshotEvent(
  fixture: ClientFixture,
  sequence = 1,
  input: Partial<Pick<SurfaceEventEnvelope, "epoch" | "streamId" | "audienceBindingHash" | "contractSetHash">> = {},
): Promise<SurfaceEventEnvelope> {
  return createSurfaceEvent(fixture, {
    sequence,
    payload: {
      type: "snapshot-published",
      snapshot: fixture.snapshot,
      streamPolicy: fixture.streamPolicy,
    },
    committedRevisionId: fixture.revision.envelope.revisionId,
    ...input,
  });
}

export async function createSurfaceEvent(
  fixture: ClientFixture,
  input: Readonly<{
    sequence: number;
    payload: SurfaceEventPayload;
    committedRevisionId?: string;
    epoch?: number;
    streamId?: string;
    audienceBindingHash?: ReturnType<typeof testHash>;
    contractSetHash?: ReturnType<typeof testHash>;
  }>,
): Promise<SurfaceEventEnvelope> {
  const payloadHash = await hashCanonical(HASH_DOMAINS.surfaceEventPayload, input.payload);
  return surfaceEventEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: SURFACE_ID,
    streamId: input.streamId ?? STREAM_ID,
    epoch: input.epoch ?? 1,
    sequence: input.sequence,
    eventId: `event-${input.epoch ?? 1}-${input.sequence}`,
    cursor: `cursor-client-${String(input.epoch ?? 1).padStart(4, "0")}-${String(input.sequence).padStart(4, "0")}`,
    committedRevisionId: input.committedRevisionId ?? fixture.revision.envelope.revisionId,
    audienceBindingHash: input.audienceBindingHash ?? AUDIENCE_HASH,
    contractSetHash: input.contractSetHash ?? fixture.registry.contractSetHash,
    correlationId: "correlation-stream-test",
    payloadHash,
    payload: input.payload,
  });
}

export async function createPreviewFixture(fixture: ClientFixture, transactionId = "transaction-preview") {
  const operation: CanonicalEntityOperation = {
    op: "put-node",
    nodeId: ROOT_NODE_ID,
    value: {
      ...fixture.content.nodes[ROOT_NODE_ID]!,
      props: { value: { kind: "literal", value: "preview-value" } },
    },
  };
  const draft = documentContentSchema.parse(applyCanonicalOperationUnchecked(fixture.content, operation));
  const projected = await projectValidatedPreview({
    surfaceSessionId: SURFACE_ID,
    transactionId: transactionIdSchema.parse(transactionId),
    baseRevisionId: fixture.revision.envelope.revisionId,
    overlaySequence: 1,
    identityMapDelta: [],
    operations: [operation],
    document: draft,
  }, acceptingValidation);
  if (!projected.ok) throw new Error("Expected preview projection to pass.");
  const revision = await createFixtureRevision(draft, {
    revisionId: "revision-preview-committed",
    parentRevisionIds: [fixture.revision.envelope.revisionId],
  });
  return { operation, draft, preview: projected.preview, revision };
}

export function rejectedPayload(code = "test.rejected"): SurfaceEventPayload {
  return {
    type: "rejected",
    diagnostics: [{
      phase: "validate",
      code,
      severity: "warning",
      recoverable: true,
      modelCorrectable: false,
      message: "Fixture rejection.",
    }],
  };
}

export function testHash(character = "0") {
  return sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
}

async function createFixtureActionContract(): Promise<ActionContract> {
  return createActionContract({
    ref: {
      publisher: FIXTURE_PUBLISHER,
      catalogId: FIXTURE_CATALOG,
      actionType: actionTypeSchema.parse("fixture.submit"),
      revision: 1,
    },
    normalizedInputSchema: { type: "object", additionalProperties: false },
    resultSchema: { type: "object" },
    receiptSchema: { type: "object" },
    reads: [
      { source: "resource", required: true },
      { source: "state", required: true },
    ],
    writes: [],
    effectClass: "read",
    risk: "low",
    idempotencyScope: "surface",
    cancellableUntil: "before-effect",
    timeoutPolicy: { timeoutMs: 10_000 },
    retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
  });
}

async function createFixtureComponentContract(action: ActionContract): Promise<ComponentContract> {
  return createComponentContract({
    ref: {
      publisher: FIXTURE_PUBLISHER,
      catalogId: FIXTURE_CATALOG,
      componentType: componentTypeSchema.parse("fixture.control"),
      revision: 1,
    },
    category: "control",
    resolvedPropsSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    authoringBindings: {
      [VALUE_POINTER]: {
        allowedSources: ["state"],
        canonicalExprSchema: { type: "object" },
        resolvedValueSchema: { type: "string" },
        nullable: false,
        readiness: "required",
        unresolvedFallback: "loading",
        state: { schema: { type: "string" }, readableScopes: ["surface"] },
      },
    },
    slots: {},
    events: {
      [SUBMIT_PORT]: {
        payloadSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        actionContracts: [action.ref],
      },
    },
    trust: "governed",
    commitPolicy: "progressive",
    readiness: {
      strategy: "all-required",
      requiredBindings: [VALUE_POINTER],
      pendingFallback: "loading",
      failureFallback: "error",
    },
    placements: [{ kind: "panel", minWidth: 240 }],
    accessibility: {
      semanticRole: "form",
      accessibleName: { kind: "host", key: "component-label" },
      keyboardInteractions: ["activate"],
      liveRegion: "off",
      equivalentView: "none",
    },
    prompt: {
      summary: "Fixture control.",
      useWhen: ["Testing client command scope."],
      avoidWhen: [],
      examples: [],
    },
    migrations: [],
  });
}

async function createFixtureRegistry(
  contract: ComponentContract,
): Promise<BrowserContractRegistry> {
  return createBrowserContractRegistry([{
    contract,
    validateResolvedProps: createZodClientValidator(
      z.object({ value: z.string() }).strict(),
    ),
    eventPayloadValidators: {
      [SUBMIT_PORT]: createZodClientValidator(
        z.object({ query: z.string() }).strict(),
      ),
    },
  }]);
}

function createFixtureDocument(
  component: ComponentContract,
  action: ActionContract,
  registry: BrowserContractRegistry,
): DocumentContent {
  const stateDefinition = (scope: "surface" | "document") => ({
    schema: { type: "string" },
    schemaHash: testHash(scope === "surface" ? "1" : "2"),
    initial: scope === "surface" ? "initial-visible" : "initial-hidden",
    sensitivity: "public" as const,
    modelVisibility: "value" as const,
    retention: "retain" as const,
    scope,
    persistence: scope === "surface" ? "session" as const : "host" as const,
  });
  return documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [{
        publisher: "open-generative",
        catalogId: "fixture",
        catalogRevision: "2026-08-22",
        manifestHash: testHash("3"),
      }],
      contractSetHash: registry.contractSetHash,
    },
    requirements: {
      dataClassifications: [],
      evidence: "none",
      placements: [],
      capabilities: [action.ref],
    },
    rootNodeId: ROOT_NODE_ID,
    nodes: {
      [ROOT_NODE_ID]: {
        contract: component.ref,
        props: { value: { kind: "state-ref", stateId: VISIBLE_STATE_ID } },
        slots: {},
        events: { [SUBMIT_PORT]: ACTION_ID },
        evidence: [],
      },
    },
    stateDefinitions: {
      [VISIBLE_STATE_ID]: stateDefinition("surface"),
      [HIDDEN_STATE_ID]: stateDefinition("document"),
    },
    actions: {
      [ACTION_ID]: {
        kind: "host-intent",
        contract: action.ref,
        input: {
          state: { kind: "state-id-ref", stateId: VISIBLE_STATE_ID },
          resource: { kind: "resource-id-ref", bindingId: VISIBLE_RESOURCE_ID },
          query: { kind: "event-ref", port: SUBMIT_PORT, path: ["query"] },
        },
      },
    },
    resourceBindings: {
      [VISIBLE_RESOURCE_ID]: resourceDeclaration("visible", "4"),
      [HIDDEN_RESOURCE_ID]: resourceDeclaration("hidden", "5"),
    },
    evidenceBindings: {},
    claims: {},
    meta: { title: "Client fixture", tags: [] },
  });
}

async function createFixtureRevision(
  content: DocumentContent,
  input: { revisionId?: string; parentRevisionIds?: string[] } = {},
): Promise<CommittedRevision> {
  return committedRevisionSchema.parse({
    envelope: {
      documentId: "document-client-test",
      revisionId: input.revisionId ?? "revision-client-base",
      parentRevisionIds: input.parentRevisionIds ?? [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00Z",
      createdBy: "audit-client-test",
    },
    content,
  });
}

function createFixtureSnapshot(revision: CommittedRevision): SurfaceSnapshot {
  return surfaceSnapshotSchema.parse({
    revision,
    state: {
      [VISIBLE_STATE_ID]: {
        stateId: VISIBLE_STATE_ID,
        stateRevisionId: "state-revision-visible",
        schemaHash: testHash("1"),
        scope: "surface",
        value: "trusted-visible",
      },
      [HIDDEN_STATE_ID]: {
        stateId: HIDDEN_STATE_ID,
        stateRevisionId: "state-revision-hidden",
        schemaHash: testHash("2"),
        scope: "document",
        value: "trusted-hidden",
      },
    },
    resources: {
      [VISIBLE_RESOURCE_ID]: resolvedResource(VISIBLE_RESOURCE_ID, "visible", "4"),
      [HIDDEN_RESOURCE_ID]: resolvedResource(HIDDEN_RESOURCE_ID, "hidden", "5"),
    },
    resourceResolutionIdentities: {
      [VISIBLE_RESOURCE_ID]: {
        requestId: "request-resource-visible-initial",
        generation: 0,
        bindingId: VISIBLE_RESOURCE_ID,
        expectedRevisionId: revision.envelope.revisionId,
      },
      [HIDDEN_RESOURCE_ID]: {
        requestId: "request-resource-hidden-initial",
        generation: 0,
        bindingId: HIDDEN_RESOURCE_ID,
        expectedRevisionId: revision.envelope.revisionId,
      },
    },
    actions: {},
    approvals: [],
  });
}

function resourceDeclaration(name: string, hashCharacter: string) {
  return {
    resourceKey: `resource-key-${name}`,
    kind: "dataset" as const,
    schemaConstraint: {
      schemaId: `schema-${name}`,
      schemaRevision: 1,
      schemaHash: testHash(hashCharacter),
      compatibility: "exact" as const,
    },
    selector: {},
    resolution: {
      mode: "pinned" as const,
      versionId: `resource-version-${name}`,
      contentHash: testHash(hashCharacter),
    },
  };
}

function resolvedResource(bindingId: typeof VISIBLE_RESOURCE_ID, name: string, hashCharacter: string) {
  return {
    status: "resolved" as const,
    snapshot: {
      snapshotId: `resource-snapshot-${name}`,
      bindingId,
      resourceVersionId: `resource-version-${name}`,
      schemaHash: testHash(hashCharacter),
      contentHash: testHash(hashCharacter),
      observedAt: "2026-08-22T00:00:00Z",
      projectionHash: testHash("6"),
      policyProjectionHash: testHash("7"),
      payload: { kind: "json" as const, value: { source: name }, byteLength: 20 },
      evidenceIds: [],
    },
  };
}

const acceptingValidation: RuntimeValidationPort = {
  validateNode: () => [],
  validateDocument: () => [],
  commitPolicy: () => "progressive",
  isNodeReady: () => true,
};
