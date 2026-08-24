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
  nodeIdSchema,
  proposalOperationEnvelopeSchema,
  proposalStreamEnvelopeSchema,
  sha256HashSchema,
  transactionIdSchema,
  valueExprSchema,
  type AuthoringProposalOperation,
  type DocumentContent,
  type JsonValue,
  type ProposalOperationEnvelope,
  type ValueExpr,
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
import {
  createOfficialCatalog,
  officialChartSpecFixtures,
  officialGoldenPromptCases,
} from "@open-generative/components";
import { createCompilerCatalog } from "./catalog";
import { ProposalStreamDecoder, computeProposalHash } from "./decoder";
import { InMemoryTransactionIdentityAllocator } from "./identity";
import { ProposalNormalizer, createAuthoringOperationEnvelope } from "./normalize";
import { createCatalogRuntimeValidationPort } from "./runtime-validation";
import { ProposalCompilerTurn } from "./turn";
import type {
  CompilerAuthority,
  CompilerCatalogLike,
  CompilerWriteScope,
  ProposalNormalizerInput,
} from "./types";

const FIXTURE_HASH = sha256HashSchema.parse(`sha256:${"1".repeat(64)}`);

describe("proposal normalization", () => {
  test("keeps snapshot and operation normalization equivalent for every supported chart recipe", async () => {
    const fixture = await createFixture();
    expect(officialGoldenPromptCases).toHaveLength(17);

    for (const [index, golden] of officialGoldenPromptCases.entries()) {
      const title = `${golden.caseId}: ${golden.prompt}`;
      const meta = { title: golden.caseId, tags: [golden.family] };
      const snapshot = authoringSnapshotProposalSchema.parse({
        kind: "snapshot",
        root: {
          localId: "surface-root",
          component: fixture.catalog.slice.components[0]!.sliceComponentId,
          props: { title },
        },
        meta,
      });
      const snapshotResult = await createNormalizer(
        fixture,
        `transaction-snapshot-${index + 1}`,
      ).normalizeSnapshot(snapshot);

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
          props: { title },
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
        value: meta,
      });
      await append("operation-remove-old-root", {
        op: "remove-node",
        target: {
          kind: "node",
          canonicalId: fixture.base.rootNodeId,
          expectedEntityRevision: fixture.writeScope.writable.node[fixture.base.rootNodeId]!,
        },
      });
      const operationResult = await createNormalizer(
        fixture,
        `transaction-operations-${index + 1}`,
      ).normalizeOperations(operations);

      expect(operationResult.document).toEqual(snapshotResult.document);
      expect(operationResult.contentHash).toBe(snapshotResult.contentHash);
      expect(String(operationResult.document.rootNodeId)).toBe("node-surface-root");
    }
  }, 20_000);

  test("treats a repeated proposal-local put as a revision-checked update", async () => {
    const fixture = await createFixture();
    const normalizer = createNormalizer(fixture, "transaction-local-update");
    const componentId = fixture.catalog.slice.components[0]!.sliceComponentId;
    const first = await createAuthoringOperationEnvelope({
      operationId: "operation-local-create" as never,
      sequence: 1,
      operation: {
        op: "put-node",
        target: { kind: "node", localId: "streamed-card" as never },
        value: {
          component: componentId,
          props: { title: "Initial" },
          slots: {},
          events: {},
          evidence: [],
        },
      },
    });
    const second = await createAuthoringOperationEnvelope({
      operationId: "operation-local-update" as never,
      sequence: 2,
      dependsOn: [first.operationId],
      operation: {
        op: "put-node",
        target: { kind: "node", localId: "streamed-card" as never },
        value: {
          component: componentId,
          props: { title: "Updated" },
          slots: {},
          events: {},
          evidence: [],
        },
      },
    });

    const created = await normalizer.normalizeOperation(first);
    const updated = await normalizer.normalizeOperation(second);
    expect(created.envelope.operation).not.toHaveProperty("expectedEntityRevision");
    expect(updated.envelope.operation).toHaveProperty("expectedEntityRevision");
    expect(normalizer.document.nodes[nodeIdSchema.parse("node-streamed-card")]?.props.title).toEqual({
      kind: "literal",
      value: "Updated",
    });
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

    const authorityRestrictedToNoColumns: CompilerAuthority = {
      ...fixture.authority,
      resources: [{
        ...fixture.authority.resources[0]!,
        declaration: {
          ...fixture.authority.resources[0]!.declaration,
          selector: { projection: [] },
        },
      }],
    };
    const wideningOperation = await createAuthoringOperationEnvelope({
      operationId: "operation-resource-widening" as never,
      sequence: 1,
      operation: {
        op: "put-resource-binding",
        target: { kind: "resource", localId: "widened-sales" as never },
        value: {
          source: fixture.catalog.slice.resources[0]!.sliceResourceId,
          selector: { projection: ["revenue" as never] },
        },
      },
    });
    await expect(
      createNormalizer(
        { ...fixture, authority: authorityRestrictedToNoColumns },
        "transaction-authority-selector",
      ).normalizeOperation(wideningOperation),
    ).rejects.toThrow("Host-authorized selector");
  });
});

describe("proposal compiler and runtime bridge", () => {
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
      validation: createCatalogRuntimeValidationPort(fixture.catalog, fixture.authority),
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

  test("rejects duplicate and prototype-polluting keys before envelope parsing", async () => {
    const transactionId = transactionIdSchema.parse("transaction-strict-json");
    const catalogSliceHash = sha256HashSchema.parse(`sha256:${"3".repeat(64)}`);
    const payload = { type: "abort" as const, reason: "strict codec test" };
    const frame = {
      protocol: OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      transactionId,
      catalogSliceHash,
      sequence: 1,
      messageId: "message-strict-json",
      payloadHash: await hashCanonical(HASH_DOMAINS.proposalStreamPayload, payload),
      payload,
    };
    const encoded = JSON.stringify(frame);
    const duplicateKey = encoded.replace(
      '"messageId":"message-strict-json"',
      '"messageId":"message-first","messageId":"message-strict-json"',
    );
    const forbiddenKey = encoded.replace("{", '{"__proto__":{},');
    const createDecoder = () => new ProposalStreamDecoder({
      transactionId,
      catalogSliceHash,
      maxOperations: 1,
    });

    await expect(createDecoder().push(`${duplicateKey}\n`)).rejects.toThrow("Duplicate JSON object key");
    await expect(createDecoder().push(`${forbiddenKey}\n`)).rejects.toThrow("Forbidden JSON object key");
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

describe("Catalog-backed Runtime validation", () => {
  test("compiles and validates a real official ChartSpec with nested resource authority", async () => {
    const fixture = await createOfficialChartCompilerFixture();
    const proposal = authoringSnapshotProposalSchema.parse({
      kind: "snapshot",
      root: {
        localId: "chart-root",
        component: fixture.chartComponentId,
        props: fixture.authoringProps,
      },
      resourceBindings: [{
        localId: "chart-data",
        value: {
          source: fixture.resourceSliceId,
          selector: { projection: ["month", "revenue"], windowLimit: 100 },
        },
      }],
      meta: { title: "Official chart compiler proof", tags: ["chart", "compiler"] },
    });

    const normalized = await createNormalizer(
      fixture,
      "transaction-official-chart",
    ).normalizeSnapshot(proposal);
    const root = normalized.document.nodes[normalized.document.rootNodeId]!;
    const validation = createCatalogRuntimeValidationPort(fixture.catalog, fixture.authority);

    expect(String(root.contract.componentType)).toBe("data.chart");
    expect(root.props.spec).toMatchObject({
      kind: "object",
      entries: {
        data: { kind: "resource-ref", bindingId: "resource-chart-data" },
      },
    });
    expect(validation.isNodeReady({
      nodeId: normalized.document.rootNodeId,
      node: root,
      document: normalized.document,
    })).toBe(true);
    expect(validation.validateNode({
      nodeId: normalized.document.rootNodeId,
      node: root,
      document: normalized.document,
      phase: "commit",
    })).toEqual([]);
    expect(validation.validateDocument({ document: normalized.document, phase: "commit" })).toEqual([]);
  });

  test("rejects undeclared binding sources, slots, and a mismatched Contract lock", async () => {
    const fixture = await createFixture();
    const validation = createCatalogRuntimeValidationPort(fixture.catalog, fixture.authority);
    const nodeId = fixture.base.rootNodeId;
    const node = structuredClone(fixture.base.nodes[nodeId]!);
    node.props.title = { kind: "state-ref", stateId: "state:not-offered" as never };
    node.slots.extra = [];

    const nodeIssues = await validation.validateNode({
      nodeId,
      node,
      document: fixture.base,
      phase: "commit",
    });
    expect(nodeIssues.map((issue) => issue.code)).toContain("component.binding-source-forbidden");
    expect(nodeIssues.map((issue) => issue.code)).toContain("component.slot-unknown");

    const document = structuredClone(fixture.base);
    document.contracts.contractSetHash = sha256HashSchema.parse(`sha256:${"9".repeat(64)}`);
    const documentIssues = await validation.validateDocument({ document, phase: "commit" });
    expect(documentIssues.map((issue) => issue.code)).toContain("catalog.document-lock-mismatch");
  });

  test("accepts Host-minted resource identities and rejects declarations outside turn authority", async () => {
    const fixture = await createFixture();
    const normalized = await createNormalizer(fixture, "transaction-runtime-resource").normalizeSnapshot(
      authoringSnapshotProposalSchema.parse({
        kind: "snapshot",
        root: {
          localId: "surface-root",
          component: fixture.catalog.slice.components[0]!.sliceComponentId,
          props: { title: "Authorized resource" },
        },
        resourceBindings: [{
          localId: "sales-binding",
          value: { source: fixture.catalog.slice.resources[0]!.sliceResourceId },
        }],
        meta: { title: "Authorized resource", tags: ["resource"] },
      }),
    );
    const validation = createCatalogRuntimeValidationPort(fixture.catalog, fixture.authority);
    const accepted = await validation.validateDocument({ document: normalized.document, phase: "commit" });
    expect(accepted.map((issue) => issue.code)).not.toContain("authority.resource-not-authorized");

    const tampered = structuredClone(normalized.document);
    const bindingId = Object.keys(tampered.resourceBindings)[0]! as keyof typeof tampered.resourceBindings;
    tampered.resourceBindings[bindingId]!.resourceKey = "foreign-resource" as never;
    const rejected = await validation.validateDocument({ document: tampered, phase: "commit" });
    expect(rejected.map((issue) => issue.code)).toContain("authority.resource-not-authorized");
  });

  test("normalizes chart Resource identity without embedding its payload", async () => {
    const fixture = await createOfficialChartCompilerFixture();
    const proposal = authoringSnapshotProposalSchema.parse({
      kind: "snapshot",
      root: {
        localId: "identity-root",
        component: fixture.chartComponentId,
        props: fixture.authoringProps,
      },
      resourceBindings: [{
        localId: "chart-data",
        value: { source: fixture.resourceSliceId },
      }],
      meta: { title: "Identity-reference proof", tags: ["resource"] },
    });

    const normalized = await createNormalizer(
      fixture,
      "transaction-identity-inputs",
    ).normalizeSnapshot(proposal);

    expect(normalized.document.resourceBindings["resource-chart-data" as never]).toMatchObject({
      resourceKey: "host-chart-data",
      kind: "dataset",
    });
    expect(normalized.document.actions).toEqual({});
    expect(normalized.document.stateDefinitions).toEqual({});
    expect(JSON.stringify(normalized.document)).not.toContain('"rows"');
    expect(createCatalogRuntimeValidationPort(fixture.catalog, fixture.authority).validateDocument({
      document: normalized.document,
      phase: "commit",
    })).toEqual([]);
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

async function createOfficialChartCompilerFixture() {
  const official = await createOfficialCatalog();
  const chart = official.components.dataChart;
  const dataPolicy = Object.entries(chart.authoringBindings)
    .find(([pointer]) => pointer === "/spec/data")?.[1];
  const schemaConstraint = dataPolicy?.resource?.schemaConstraints[0];
  if (!schemaConstraint) throw new TypeError("The official chart data binding has no resource schema constraint.");
  const chartFixture = officialChartSpecFixtures.find(
    (fixture) => fixture.recipeName === "revenue-smooth-area",
  );
  if (!chartFixture) throw new TypeError("The revenue area fixture is missing.");

  const renderer = await createRendererCapabilityManifest({
    rendererId: "tessera-chart-proof",
    rendererRevision: "2026-08-22",
    implementationHash: FIXTURE_HASH,
    conformanceRevision: "2026-08-22",
    contracts: [chart].map((contract) => ({
      contract: contract.ref,
      placements: [{ kind: "panel" as const, minWidth: 320 }],
      features: [],
      chunkHash: FIXTURE_HASH,
      assetHashes: [],
    })),
  });
  const negotiation = await negotiateRendererCapabilities({
    catalogs: [official.manifest],
    renderer,
    placement: { kind: "panel", width: 960, height: 640 },
    requirements: [{ contract: chart, requiredFeatures: [] }],
  });
  const resourceOffer = await createModelVisibleResourceOffer({
    bindingId: "offered-chart-data" as never,
    descriptor: {
      kind: "dataset",
      label: "Monthly revenue",
      resolvedSchema: schemaConstraint.resolvedSchema,
      columns: [
        { columnId: "month" as never, label: "Month", valueSchema: { type: "string" }, sensitivity: "internal" },
        { columnId: "revenue" as never, label: "Revenue", valueSchema: { type: "number" }, sensitivity: "internal" },
      ],
    },
    selectorPolicy: {
      allowProjection: true,
      maxProjectedColumns: 32,
      allowFilterState: true,
      allowSort: false,
      maxSortKeys: 0,
      maxWindowItems: 10_000,
    },
  });
  const slice = await createCatalogSetSlice({
    catalogs: [official.manifest],
    rendererNegotiation: negotiation,
    components: [chart.ref],
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
  const catalog = await createCompilerCatalog({ slice, components: [chart], actions: [] });
  const authorizedDeclaration = {
    resourceKey: "host-chart-data" as never,
    kind: "dataset" as const,
    schemaConstraint: {
      schemaId: "official-chart-data" as never,
      schemaRevision: 1,
      schemaHash: schemaConstraint.schemaHash,
      compatibility: "exact" as const,
    },
    selector: { projection: ["month" as never, "revenue" as never], windowLimit: 1_000 },
    resolution: {
      mode: "pinned" as const,
      versionId: "chart-data-v1" as never,
      contentHash: FIXTURE_HASH,
    },
  };
  const baseBindingId = "resource-base-chart-data";
  const baseSpec = {
    ...structuredClone(chartFixture.spec),
    data: { kind: "resource-ref" as const, bindingId: baseBindingId },
  };
  const base = documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: { manifestRefs: [official.manifest.ref], contractSetHash: slice.contractSetHash },
    requirements: { dataClassifications: [], evidence: "none", placements: [], capabilities: [] },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: chart.ref,
        props: { spec: toDocumentValueExpr(baseSpec) },
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: { [baseBindingId]: authorizedDeclaration },
    evidenceBindings: {},
    claims: {},
    meta: { title: "Old", tags: [] },
  });
  const revisions = await computeEntityRevisionIndex(base);
  const authority: CompilerAuthority = {
    actions: [],
    resources: [{
      source: resourceOffer.source,
      declaration: authorizedDeclaration,
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
      resource: { [baseBindingId]: revisions.resources[baseBindingId]! },
      evidence: {},
      claim: {},
    },
    root: { expectedRootId: base.rootNodeId },
    meta: { expectedMetaHash: revisions.metaHash },
  };

  const { data: _data, ...literalSpec } = structuredClone(chartFixture.spec);
  const authoringSpec = toCompilerAuthoringLiteral(literalSpec) as { object: Record<string, unknown> };
  authoringSpec.object.data = {
    ref: "resource",
    target: { kind: "resource", localId: "chart-data" },
  };
  const chartComponentId = slice.components.find((entry) => entry.contract.componentType === "data.chart")?.sliceComponentId;
  const resourceSliceId = slice.resources[0]?.sliceResourceId;
  if (!chartComponentId || !resourceSliceId) {
    throw new TypeError("The chart proof Slice is incomplete.");
  }

  return {
    catalog,
    base,
    revisions,
    authority,
    writeScope,
    chartComponentId,
    resourceSliceId,
    authoringProps: { spec: authoringSpec },
  };
}

function toDocumentValueExpr(value: JsonValue): ValueExpr {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.kind === "resource-ref" || value.kind === "state-ref") {
      return valueExprSchema.parse(value);
    }
    return {
      kind: "object",
      entries: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, toDocumentValueExpr(child)]),
      ),
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map(toDocumentValueExpr) };
  }
  return { kind: "literal", value };
}

function toCompilerAuthoringLiteral(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toCompilerAuthoringLiteral);
  if (typeof value === "object") {
    return {
      object: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, toCompilerAuthoringLiteral(child)]),
      ),
    };
  }
  throw new TypeError("Chart fixtures may only contain JSON-compatible values.");
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
