import { describe, expect, test } from "bun:test";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  authoringSnapshotProposalSchema,
  branchHeadSchema,
  committedRevisionSchema,
  documentContentSchema,
  hashCanonical,
  hashDocumentContent,
  proposalOperationEnvelopeSchema,
  proposalStreamEnvelopeSchema,
  sha256HashSchema,
  transactionIdSchema,
  type AuthoringProposalOperation,
  type DocumentContent,
  type ProposalOperationEnvelope,
} from "@open-generative/protocol";
import {
  catalogManifestInputSchema,
  componentContractDefinitionSchema,
  createCatalogManifest,
  createCatalogSetSlice,
  createComponentContract,
  createModelVisibleResourceOffer,
  createRendererCapabilityManifest,
  negotiateRendererCapabilities,
} from "@open-generative/catalog";
import {
  DocumentTransactionRuntime,
  InMemoryRuntimeStore,
  computeEntityRevisionIndex,
  type RuntimeTransactionRecord,
} from "@open-generative/runtime";
import { createCompilerCatalog } from "./catalog";
import { ProposalStreamDecoder, computeProposalHash, decodePresentUiInput } from "./decoder";
import { InMemoryTransactionIdentityAllocator } from "./identity";
import { ProposalNormalizer, createAuthoringOperationEnvelope } from "./normalize";
import { compilePresentUi } from "./prompt";
import { ProposalCompilerTurn } from "./turn";
import type {
  CompilerAuthority,
  CompilerCatalogLike,
  CompilerWriteScope,
  ProposalNormalizerInput,
} from "./types";

const FIXTURE_HASH = sha256HashSchema.parse(`sha256:${"1".repeat(64)}`);

describe("proposal normalization", () => {
  test("snapshot and equivalent entity operations produce identical canonical content", async () => {
    const fixture = await createFixture();
    const snapshot = authoringSnapshotProposalSchema.parse({
      kind: "snapshot",
      root: {
        localId: "surface-root",
        component: fixture.catalog.slice.components[0]!.sliceComponentId,
        props: { title: "销售趋势" },
      },
      meta: { title: "Sales", tags: ["sales"] },
    });
    const snapshotResult = await createNormalizer(fixture, "transaction-snapshot").normalizeSnapshot(snapshot);

    const operations: ProposalOperationEnvelope[] = [];
    const append = async (operationId: string, operation: AuthoringProposalOperation): Promise<void> => {
      operations.push(await createAuthoringOperationEnvelope({
        operationId: operationId as never,
        sequence: operations.length + 1,
        dependsOn: operations.at(-1) ? [operations.at(-1)!.operationId] : [],
        operation,
      }));
    };
    await append("operation-put-root", {
      op: "put-node",
      target: { kind: "node", localId: "surface-root" as never },
      value: {
        component: fixture.catalog.slice.components[0]!.sliceComponentId,
        props: { title: "销售趋势" },
        slots: {},
        events: {},
        evidence: [],
      },
    });
    await append("operation-set-root", {
      op: "set-root",
      node: { kind: "node", localId: "surface-root" as never },
      expectedRootId: fixture.base.rootNodeId,
    });
    await append("operation-set-meta", {
      op: "set-meta",
      expectedMetaHash: fixture.writeScope.meta!.expectedMetaHash,
      value: { title: "Sales", tags: ["sales"] },
    });
    await append("operation-remove-old-root", {
      op: "remove-node",
      target: {
        kind: "node",
        canonicalId: fixture.base.rootNodeId,
        expectedEntityRevision: fixture.writeScope.writable.node[fixture.base.rootNodeId]!,
      },
    });
    const operationResult = await createNormalizer(fixture, "transaction-operations").normalizeOperations(operations);

    expect(operationResult.document).toEqual(snapshotResult.document);
    expect(operationResult.contentHash).toBe(snapshotResult.contentHash);
    expect(String(operationResult.document.rootNodeId)).toBe("node-surface-root");
  });

  test("rejects unknown Slice IDs and an authority offerHash mismatch", async () => {
    const fixture = await createFixture();
    const unknownComponent = await createAuthoringOperationEnvelope({
      operationId: "operation-unknown-component" as never,
      sequence: 1,
      operation: {
        op: "put-node",
        target: { kind: "node", localId: "unknown-node" as never },
        value: { component: "component-999999" as never, props: { title: "No" }, slots: {}, events: {}, evidence: [] },
      },
    });
    await expect(
      createNormalizer(fixture, "transaction-unknown-component").normalizeOperation(unknownComponent),
    ).rejects.toThrow("outside the frozen CatalogSetSlice");

    const resourceOperation = await createAuthoringOperationEnvelope({
      operationId: "operation-resource" as never,
      sequence: 1,
      operation: {
        op: "put-resource-binding",
        target: { kind: "resource", localId: "sales-binding" as never },
        value: { source: fixture.catalog.slice.resources[0]!.sliceResourceId },
      },
    });
    const mismatchedAuthority: CompilerAuthority = {
      ...fixture.authority,
      resources: [{
        ...fixture.authority.resources[0]!,
        source: {
          ...fixture.authority.resources[0]!.source,
          offerHash: sha256HashSchema.parse(`sha256:${"f".repeat(64)}`),
        },
      }],
    };
    await expect(
      createNormalizer({ ...fixture, authority: mismatchedAuthority }, "transaction-offer-mismatch").normalizeOperation(resourceOperation),
    ).rejects.toThrow("offerHash");
  });
});

describe("present_ui and runtime bridge", () => {
  test("keeps provider lowering separate from strict canonical validation", async () => {
    const fixture = await createFixture();
    const compiled = compilePresentUi({ catalog: fixture.catalog });
    expect(compiled.tool.name).toBe("present_ui");
    expect(compiled.tool.strict).toBe(true);
    const input = {
      kind: "snapshot",
      root: {
        localId: "provider-root",
        component: fixture.catalog.slice.components[0]!.sliceComponentId,
        props: { title: "Revenue" },
      },
      meta: { tags: [] },
    };
    const decoded = await decodePresentUiInput(compiled, input);
    expect(decoded).toMatchObject({ kind: "snapshot" });
    await expect(decodePresentUiInput(compiled, {
      ...input,
      root: { ...input.root, component: "component-999999" },
    })).rejects.toThrow("Invalid input");
    await expect(decodePresentUiInput(compiled, { ...input, legacyTree: {} })).rejects.toThrow("Invalid input");
  });

  test("drives the DocumentTransactionRuntime begin/apply/finalize path", async () => {
    const fixture = await createFixture();
    const revision = committedRevisionSchema.parse({
      envelope: {
        documentId: "document-compiler",
        revisionId: "revision-base",
        parentRevisionIds: [],
        contentHash: await hashDocumentContent(fixture.base),
        hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
        migrationReceiptIds: [],
        createdAt: "2026-08-22T00:00:00Z",
        createdBy: "audit-compiler",
      },
      content: fixture.base,
    });
    const store = new InMemoryRuntimeStore<RuntimeTransactionRecord>();
    store.seedRevision(
      { revision, entityRevisions: fixture.revisions },
      branchHeadSchema.parse({
        documentId: revision.envelope.documentId,
        branchId: "main",
        revisionId: revision.envelope.revisionId,
        headToken: "head-base",
      }),
    );
    const runtime = new DocumentTransactionRuntime({
      store,
      validation: {
        validateNode: () => [],
        validateDocument: () => [],
        commitPolicy: () => "progressive",
        isNodeReady: () => true,
      },
    });
    const snapshot = authoringSnapshotProposalSchema.parse({
      kind: "snapshot",
      root: {
        localId: "committed-root",
        component: fixture.catalog.slice.components[0]!.sliceComponentId,
        props: { title: "Committed" },
      },
      meta: { title: "Committed", tags: [] },
    });
    const previews: unknown[] = [];
    const turn = new ProposalCompilerTurn({
      catalog: fixture.catalog,
      authority: fixture.authority,
      runtime,
      identityAllocator: new InMemoryTransactionIdentityAllocator({
        mint: ({ kind, localId }) => `${kind}-${localId}`,
      }),
      baseDocument: fixture.base,
      baseEntityRevisions: fixture.revisions,
      writeScope: fixture.writeScope,
      begin: {
        transactionId: "transaction-commit" as never,
        surfaceSessionId: "surface-compiler" as never,
        documentId: revision.envelope.documentId,
        branchId: "main" as never,
        baseRevisionId: revision.envelope.revisionId,
        expectedHeadToken: "head-base" as never,
        targetRevisionId: "revision-next" as never,
        nextHeadToken: "head-next" as never,
        createdAt: "2026-08-22T00:01:00Z",
        createdBy: "audit-compiler" as never,
      },
      authorityContextHash: FIXTURE_HASH,
      writeScopeHash: sha256HashSchema.parse(`sha256:${"3".repeat(64)}`),
      correlationId: "correlation-compiler" as never,
      onPreview: (preview) => { previews.push(preview); },
    });
    const outcome = await turn.runDecoded({ kind: "snapshot", proposal: snapshot });

    expect(outcome.status).toBe("committed");
    expect(turn.commands.map((command) => command.payload.type)).toEqual([
      "begin",
      "apply",
      "apply",
      "apply",
      "apply",
      "finalize",
    ]);
    expect(previews.length).toBeGreaterThan(0);
    const committed = await store.getRevision(revision.envelope.documentId, "revision-next" as never);
    expect(String(committed?.revision.content.rootNodeId)).toBe("node-committed-root");
  });
});

describe("ProposalStreamDecoder", () => {
  test("preserves complete entity frames across arbitrary byte and UTF-8 boundaries", async () => {
    const transactionId = transactionIdSchema.parse("transaction-stream");
    const catalogSliceHash = sha256HashSchema.parse(`sha256:${"2".repeat(64)}`);
    const operationBody: AuthoringProposalOperation = {
      op: "put-node",
      target: { kind: "node", localId: "stream-node" as never },
      value: {
        component: "component-000001" as never,
        props: { title: "销售趋势" },
        slots: {},
        events: {},
        evidence: [],
      },
    };
    const operation = proposalOperationEnvelopeSchema.parse({
      operationId: "operation-stream",
      sequence: 1,
      dependsOn: [],
      payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operationBody),
      operation: operationBody,
    });
    const operationPayload = { type: "entity-operation" as const, operation };
    const operationFrame = proposalStreamEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      transactionId,
      catalogSliceHash,
      sequence: 1,
      messageId: "message-operation",
      payloadHash: await hashCanonical(HASH_DOMAINS.proposalStreamPayload, operationPayload),
      payload: operationPayload,
    });
    const finishPayload = {
      type: "finish" as const,
      finalOperationSequence: 1,
      proposalHash: await computeProposalHash({ kind: "operations", operations: [operation] }),
    };
    const finishFrame = proposalStreamEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      transactionId,
      catalogSliceHash,
      sequence: 2,
      messageId: "message-finish",
      payloadHash: await hashCanonical(HASH_DOMAINS.proposalStreamPayload, finishPayload),
      payload: finishPayload,
    });
    const bytes = new TextEncoder().encode(`${JSON.stringify(operationFrame)}\n${JSON.stringify(finishFrame)}\n`);
    const chineseStart = bytes.findIndex((byte) => byte >= 0xe0);
    const newline = bytes.indexOf(10);
    const chunks = [
      bytes.slice(0, chineseStart + 1),
      bytes.slice(chineseStart + 1, newline - 3),
      bytes.slice(newline - 3, newline + 1),
      bytes.slice(newline + 1, bytes.length - 2),
      bytes.slice(bytes.length - 2),
    ];
    const decoder = new ProposalStreamDecoder({
      transactionId,
      catalogSliceHash,
      maxOperations: 8,
    });
    const accepted = [];
    for (const chunk of chunks) accepted.push(...await decoder.push(chunk));
    accepted.push(...await decoder.finishInput());

    expect(accepted.map((frame) => frame.payload.type)).toEqual(["entity-operation", "finish"]);
    expect(decoder.result).toEqual({ kind: "operations", operations: [operation] });
  });
});

describe("transaction identity allocation", () => {
  test("never aliases two proposal-local IDs to one canonical entity", async () => {
    const allocator = new InMemoryTransactionIdentityAllocator({ mint: () => "node-fixed" });
    await allocator.claim({
      transactionId: "transaction-identities" as never,
      operationId: "operation-identity-a" as never,
      entities: [{ kind: "node", localId: "local-a" }],
    });
    await expect(allocator.claim({
      transactionId: "transaction-identities" as never,
      operationId: "operation-identity-b" as never,
      entities: [{ kind: "node", localId: "local-b" }],
    })).rejects.toThrow("another proposal-local entity");
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const component = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: "open-generative", catalogId: "official", componentType: "data.chart", revision: 1 },
    category: "data",
    resolvedPropsSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    authoringBindings: {
      "/title": {
        allowedSources: ["literal"],
        canonicalExprSchema: { type: "object" },
        resolvedValueSchema: { type: "string" },
        nullable: false,
        readiness: "required",
        unresolvedFallback: "loading",
      },
    },
    slots: {},
    events: {},
    trust: "safe",
    commitPolicy: "progressive",
    readiness: {
      strategy: "all-required",
      requiredBindings: ["/title"],
      pendingFallback: "loading",
      failureFallback: "error",
    },
    placements: [{ kind: "panel", minWidth: 320 }],
    accessibility: {
      semanticRole: "img",
      accessibleName: { kind: "prop", path: "/title" },
      keyboardInteractions: [],
      liveRegion: "off",
      equivalentView: "table",
    },
    prompt: {
      summary: "Render a Tessera data chart.",
      useWhen: ["The user needs to compare data."],
      avoidWhen: [],
      examples: [],
    },
    migrations: [],
  }));
  const manifest = await createCatalogManifest(catalogManifestInputSchema.parse({
    ref: { publisher: "open-generative", catalogId: "official", catalogRevision: "2026-08-22" },
    dependencies: [],
    components: [component.ref],
    actions: [],
  }));
  const renderer = await createRendererCapabilityManifest({
    rendererId: "tessera-react",
    rendererRevision: "2026-08-22",
    implementationHash: FIXTURE_HASH,
    conformanceRevision: "2026-08-22",
    contracts: [{
      contract: component.ref,
      placements: [{ kind: "panel", minWidth: 320 }],
      features: [],
      chunkHash: FIXTURE_HASH,
      assetHashes: [],
    }],
  });
  const negotiation = await negotiateRendererCapabilities({
    catalogs: [manifest],
    renderer,
    placement: { kind: "panel", width: 960, height: 640 },
    requirements: [{ contract: component, requiredFeatures: [] }],
  });
  const resourceOffer = await createModelVisibleResourceOffer({
    bindingId: "offered-sales" as never,
    descriptor: {
      kind: "dataset",
      label: "Sales",
      resolvedSchema: { type: "array" },
      columns: [{ columnId: "revenue" as never, label: "Revenue", valueSchema: { type: "number" }, sensitivity: "internal" }],
    },
    selectorPolicy: {
      allowProjection: true,
      maxProjectedColumns: 8,
      allowFilterState: true,
      allowSort: true,
      maxSortKeys: 2,
      maxWindowItems: 100,
    },
  });
  const slice = await createCatalogSetSlice({
    catalogs: [manifest],
    rendererNegotiation: negotiation,
    components: [component.ref],
    actions: [],
    resources: [resourceOffer],
    evidence: [],
    limits: {
      maxNodes: 100,
      maxDepth: 16,
      maxActions: 16,
      maxResourceBindings: 16,
      maxEvidenceBindings: 16,
      maxTextBytes: 64_000,
      maxOperations: 100,
    },
    providerSchemaProfile: "canonical",
  });
  const catalog = await createCompilerCatalog({ slice, components: [component], actions: [] });
  const base = documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: { manifestRefs: [manifest.ref], contractSetHash: slice.contractSetHash },
    requirements: { dataClassifications: [], evidence: "none", placements: [], capabilities: [] },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: component.ref,
        props: { title: { kind: "literal", value: "Old" } },
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
    meta: { title: "Old", tags: [] },
  });
  const revisions = await computeEntityRevisionIndex(base);
  const authority: CompilerAuthority = {
    actions: [],
    resources: [{
      source: resourceOffer.source,
      declaration: {
        resourceKey: "host-sales" as never,
        kind: "dataset",
        schemaConstraint: {
          schemaId: "sales-schema" as never,
          schemaRevision: 1,
          schemaHash: FIXTURE_HASH,
          compatibility: "exact",
        },
        selector: {},
        resolution: { mode: "pinned", versionId: "sales-v1" as never, contentHash: FIXTURE_HASH },
      },
      classification: "internal",
    }],
    evidence: [],
    statePolicy: {
      decide: () => ({
        scope: "surface",
        persistence: "session",
        sensitivity: "private",
        modelVisibility: "descriptor",
        retention: "retain",
        classification: "internal",
      }),
    },
    informationFlow: { maxDocumentClassification: "restricted" },
  };
  const writeScope: CompilerWriteScope = {
    creatable: ["node", "state", "action", "resource", "evidence", "claim"],
    readable: { node: [], state: [], action: [], resource: [], evidence: [], claim: [] },
    writable: {
      node: { [base.rootNodeId]: revisions.nodes[base.rootNodeId]! },
      state: {},
      action: {},
      resource: {},
      evidence: {},
      claim: {},
    },
    root: { expectedRootId: base.rootNodeId },
    meta: { expectedMetaHash: revisions.metaHash },
  };
  return { catalog, base, revisions, authority, writeScope };
}

function createNormalizer(
  fixture: Pick<Fixture, "catalog" | "base" | "revisions" | "authority" | "writeScope">,
  transactionId: string,
): ProposalNormalizer {
  const input: ProposalNormalizerInput = {
    catalog: fixture.catalog as CompilerCatalogLike,
    authority: fixture.authority,
    transactionId: transactionIdSchema.parse(transactionId),
    baseDocument: fixture.base as DocumentContent,
    baseEntityRevisions: fixture.revisions,
    writeScope: fixture.writeScope,
    identityAllocator: new InMemoryTransactionIdentityAllocator({
      mint: ({ kind, localId }) => `${kind}-${localId}`,
    }),
  };
  return new ProposalNormalizer(input);
}
