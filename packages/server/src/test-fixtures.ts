import {
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  actorAuditRefSchema,
  committedRevisionSchema,
  correlationIdSchema,
  catalogIdSchema,
  catalogRevisionSchema,
  componentTypeSchema,
  documentContentSchema,
  hashDocumentContent,
  publisherIdSchema,
  sha256HashSchema,
  streamIdSchema,
  surfaceSessionIdSchema,
} from "@open-generative/protocol";
import {
  createCatalogManifest,
  createCatalogSetSlice,
  createComponentContract,
  createRendererCapabilityManifest,
  negotiateRendererCapabilities,
} from "@open-generative/catalog";
import { createAuthorityContext, hashAudienceBinding } from "./authority";
import type { SurfaceSessionRecord } from "./surface-store";

export const testHash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);

export async function createServerFixture(): Promise<{
  record: SurfaceSessionRecord;
  contract: Awaited<ReturnType<typeof createComponentContract>>;
  catalog: Awaited<ReturnType<typeof createCatalogManifest>>;
  initialEvent: {
    correlationId: ReturnType<typeof correlationIdSchema.parse>;
    payload: {
      type: "snapshot-published";
      snapshot: {
        revision: SurfaceSessionRecord["committedRevision"];
        state: SurfaceSessionRecord["state"];
        resources: SurfaceSessionRecord["resources"];
        actions: SurfaceSessionRecord["actions"];
        approvals: SurfaceSessionRecord["approvals"];
      };
      streamPolicy: SurfaceSessionRecord["streamPolicy"];
    };
  };
}> {
  const contract = await createComponentContract({
    ref: {
      publisher: publisherIdSchema.parse("open-generative"),
      catalogId: catalogIdSchema.parse("official"),
      componentType: componentTypeSchema.parse("layout.stack"),
      revision: 1,
    },
    category: "layout",
    resolvedPropsSchema: { type: "object", additionalProperties: false },
    authoringBindings: {},
    slots: {},
    events: {},
    trust: "safe",
    commitPolicy: "progressive",
    readiness: {
      strategy: "all-required",
      requiredBindings: [],
      pendingFallback: "loading",
      failureFallback: "error",
    },
    placements: [{ kind: "panel", minWidth: 320 }],
    accessibility: {
      semanticRole: "group",
      accessibleName: { kind: "host", key: "surface-label" },
      keyboardInteractions: [],
      liveRegion: "off",
      equivalentView: "none",
    },
    prompt: {
      summary: "Arrange content in a vertical stack.",
      useWhen: ["Content has a natural reading order."],
      avoidWhen: [],
      examples: [],
    },
    migrations: [],
  });
  const catalog = await createCatalogManifest({
    ref: {
      publisher: publisherIdSchema.parse("open-generative"),
      catalogId: catalogIdSchema.parse("official"),
      catalogRevision: catalogRevisionSchema.parse("2026-08-22"),
    },
    dependencies: [],
    components: [contract.ref],
    actions: [],
  });
  const rendererCapabilityManifest = await createRendererCapabilityManifest({
    rendererId: "official-react",
    rendererRevision: "2026-08-22",
    implementationHash: testHash("4"),
    conformanceRevision: "2026-08-22",
    contracts: [{
      contract: contract.ref,
      placements: [{ kind: "panel", minWidth: 320 }],
      features: [],
      chunkHash: testHash("5"),
      assetHashes: [],
    }],
  });
  const rendererNegotiation = await negotiateRendererCapabilities({
    catalogs: [catalog],
    renderer: rendererCapabilityManifest,
    placement: { kind: "panel", width: 960, height: 720 },
    requirements: [{ contract, requiredFeatures: [] }],
  });
  const catalogSlice = await createCatalogSetSlice({
    catalogs: [catalog],
    rendererNegotiation,
    components: [contract.ref],
    actions: [],
    resources: [],
    evidence: [],
    limits: {
      maxNodes: 100,
      maxDepth: 16,
      maxActions: 8,
      maxResourceBindings: 8,
      maxEvidenceBindings: 16,
      maxTextBytes: 64_000,
      maxOperations: 1_000,
    },
    providerSchemaProfile: "test",
  });
  const content = documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: catalogSlice.manifests,
      contractSetHash: catalogSlice.contractSetHash,
    },
    requirements: {
      dataClassifications: [],
      evidence: "none",
      placements: [],
      capabilities: [],
    },
    rootNodeId: "node:root",
    nodes: {
      "node:root": {
        contract: contract.ref,
        props: {},
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: {},
    evidenceBindings: {},
    claims: {},
    meta: { title: "Test surface", tags: [] },
  });
  const committedRevision = committedRevisionSchema.parse({
    envelope: {
      documentId: "document:test",
      revisionId: "revision:test",
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      createdBy: actorAuditRefSchema.parse("audit:test"),
    },
    content,
  });
  const authority = createAuthorityContext({
    actorAuditRef: actorAuditRefSchema.parse("audit:test"),
    actorBindingHash: testHash("a"),
    tenantBindingHash: testHash("b"),
    authorityPolicyRevision: "policy:1",
  });
  const record: SurfaceSessionRecord = {
    surfaceSessionId: surfaceSessionIdSchema.parse("surface:test"),
    streamId: streamIdSchema.parse("stream:test"),
    epoch: 1,
    authority,
    audienceBindingHash: hashAudienceBinding(authority),
    rendererCapabilityManifest,
    catalogSlice,
    committedRevision,
    streamPolicy: {
      maxSequenceGap: 16,
      maxBufferedBytes: 1_000_000,
      ackEveryEvents: 8,
      backpressure: "publish-snapshot",
      cursorExpiresAt: "2026-08-22T01:00:00.000Z",
    },
    state: {},
    resources: {},
    actions: {},
    approvals: [],
    commandReceipts: {},
    acknowledgedThrough: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    expiresAt: "2026-08-22T01:00:00.000Z",
  };
  return {
    record,
    contract,
    catalog,
    initialEvent: {
      correlationId: correlationIdSchema.parse("correlation:initial"),
      payload: {
        type: "snapshot-published",
        snapshot: {
          revision: record.committedRevision,
          state: record.state,
          resources: record.resources,
          actions: record.actions,
          approvals: record.approvals,
        },
        streamPolicy: record.streamPolicy,
      },
    },
  };
}
