import { describe, expect, test } from "bun:test";
import {
  columnIdSchema,
  evidenceIdSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  sliceActionIdSchema,
  sliceComponentIdSchema,
  sliceEvidenceIdSchema,
  sliceResourceIdSchema,
  type ActionContractRef,
  type ContractRef,
} from "@open-generative/protocol";
import {
  CatalogIntegrityError,
  actionContractDefinitionSchema,
  catalogManifestInputSchema,
  catalogSetSliceSchema,
  componentContractDefinitionSchema,
  componentContractSchema,
  createActionContract,
  createCatalogManifest,
  createCatalogSetSlice,
  createComponentContract,
  createModelVisibleEvidenceOffer,
  createModelVisibleResourceOffer,
  createRendererCapabilityManifest,
  negotiateRendererCapabilities,
  verifyCatalogManifest,
  verifyCatalogSetSlice,
  verifyComponentContract,
  verifyRendererCapabilityManifest,
  type ComponentContract,
  type ComponentContractDefinition,
  type RendererCapabilityNegotiationResult,
  type RendererCapabilityManifestDefinition,
} from "./index";

const FIXTURE_HASH = sha256HashSchema.parse(`sha256:${"0".repeat(64)}`);

async function actionContract() {
  return createActionContract(actionContractDefinitionSchema.parse({
    ref: {
      publisher: "open-generative",
      catalogId: "official",
      actionType: "data.export",
      revision: 1,
    },
    normalizedInputSchema: { type: "object", additionalProperties: false },
    resultSchema: { type: "object" },
    receiptSchema: { type: "object" },
    reads: [{ source: "resource", required: true }],
    writes: [],
    effectClass: "read",
    risk: "low",
    idempotencyScope: "actor",
    cancellableUntil: "before-effect",
    timeoutPolicy: { timeoutMs: 10_000 },
    retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
  }));
}

function componentDefinition(
  componentType: "data.metric" | "content.text",
  action?: ActionContractRef,
): ComponentContractDefinition {
  return componentContractDefinitionSchema.parse({
    ref: {
      publisher: "open-generative",
      catalogId: "official",
      componentType,
      revision: 1,
    },
    category: componentType.startsWith("data.") ? "data" : "content",
    resolvedPropsSchema: {
      type: "object",
      properties: { value: { type: ["number", "string"] } },
      required: ["value"],
      additionalProperties: false,
    },
    authoringBindings: {
      "/value": {
        allowedSources: ["literal", "resource"],
        canonicalExprSchema: { type: "object" },
        resolvedValueSchema: { type: ["number", "string"] },
        nullable: false,
        readiness: "required",
        unresolvedFallback: "loading",
        resource: {
          kinds: ["dataset"],
          schemaConstraints: [{
            schemaHash: FIXTURE_HASH,
            resolvedSchema: { type: ["number", "string"] },
          }],
          selector: {
            allowProjection: true,
            maxProjectedColumns: 8,
            allowFilterState: true,
            allowSort: false,
            maxSortKeys: 0,
            maxWindowItems: 100,
          },
          maxSensitivity: "confidential",
        },
      },
    },
    slots: {},
    events: action === undefined ? {} : {
      export: {
        payloadSchema: { type: "object", additionalProperties: false },
        actionContracts: [action],
      },
    },
    trust: "safe",
    commitPolicy: "progressive",
    readiness: {
      strategy: "all-required",
      requiredBindings: ["/value"],
      pendingFallback: "loading",
      failureFallback: "error",
    },
    placements: [
      { kind: "inline", minWidth: 240 },
      { kind: "panel", minWidth: 320 },
    ],
    accessibility: {
      semanticRole: "group",
      accessibleName: { kind: "host", key: "component-label" },
      keyboardInteractions: action === undefined ? [] : ["activate"],
      liveRegion: "off",
      equivalentView: "none",
    },
    prompt: {
      summary: `Render ${componentType}`,
      useWhen: ["The value is backed by a real resource."],
      avoidWhen: ["The value is unavailable."],
      examples: [],
    },
    migrations: [],
  });
}

async function componentContracts(actionRef: ActionContractRef) {
  return Promise.all([
    createComponentContract(componentDefinition("data.metric", actionRef)),
    createComponentContract(componentDefinition("content.text")),
  ]);
}

async function catalogFixture(components: readonly ComponentContract[], actionRef: ActionContractRef) {
  return createCatalogManifest(catalogManifestInputSchema.parse({
    ref: {
      publisher: "open-generative",
      catalogId: "official",
      catalogRevision: "2026-08-22",
    },
    dependencies: [],
    components: components.map((contract) => contract.ref).reverse(),
    actions: [actionRef],
  }));
}

async function rendererFixture(components: readonly ComponentContract[]) {
  return createRendererCapabilityManifest({
    rendererId: "official-react",
    rendererRevision: "2026-08-22",
    implementationHash: FIXTURE_HASH,
    conformanceRevision: "2026-08-22",
    contracts: components.map((contract) => ({
      contract: contract.ref,
      placements: [{ kind: "panel", minWidth: 320 }, { kind: "inline", minWidth: 240 }],
      features: contract.ref.componentType === "data.metric" ? ["export"] : [],
      chunkHash: FIXTURE_HASH,
      assetHashes: [],
    })),
  } as RendererCapabilityManifestDefinition);
}

async function acceptedNegotiation(
  catalog: Awaited<ReturnType<typeof catalogFixture>>,
  renderer: Awaited<ReturnType<typeof rendererFixture>>,
  components: readonly ComponentContract[],
): Promise<RendererCapabilityNegotiationResult> {
  return negotiateRendererCapabilities({
    catalogs: [catalog],
    renderer,
    placement: { kind: "panel", width: 900, height: 700 },
    requirements: components.map((contract) => ({
      contract,
      requiredFeatures: contract.ref.componentType === "data.metric" ? ["export"] : [],
    })),
  });
}

describe("ComponentContract", () => {
  test("normalizes set-like fields and hashes the definition without a self-reference", async () => {
    const action = await actionContract();
    const definition = componentDefinition("data.metric", action.ref);
    const reversed = {
      ...definition,
      placements: [...definition.placements].reverse(),
    } as ComponentContractDefinition;

    const [left, right] = await Promise.all([
      createComponentContract(definition),
      createComponentContract(reversed),
    ]);

    expect(left.ref.contractHash).toBe(right.ref.contractHash);
    expect(Object.isFrozen(left)).toBe(true);
    expect((left as unknown as { contractHash?: unknown }).contractHash).toBeUndefined();
    await expect(verifyComponentContract(left)).resolves.toEqual(left);
  });

  test("rejects unknown keys and a BindingPolicy with an undeclared resource policy", () => {
    const definition = componentDefinition("content.text");
    expect(componentContractDefinitionSchema.safeParse({ ...definition, obsoleteKind: "removed" }).success).toBe(false);

    const invalid = structuredClone(definition) as unknown as Record<string, any>;
    invalid.authoringBindings["/value"].resource = undefined;
    expect(componentContractDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  test("detects content changed after the ContractRef hash was issued", async () => {
    const contract = await createComponentContract(componentDefinition("content.text"));
    const tampered = structuredClone(contract);
    tampered.prompt.summary = "Tampered prompt metadata";

    await expect(verifyComponentContract(tampered)).rejects.toMatchObject({
      name: "CatalogIntegrityError",
      code: "catalog.component-contract-hash",
    });
    expect(componentContractSchema.safeParse({ ...contract, unknownRenderer: "removed" }).success).toBe(false);
  });
});

describe("CatalogManifest and renderer negotiation", () => {
  test("canonicalizes manifest order and verifies all integrity fields", async () => {
    const action = await actionContract();
    const components = await componentContracts(action.ref);
    const left = await catalogFixture(components, action.ref);
    const right = await catalogFixture([...components].reverse(), action.ref);

    expect(left.ref.manifestHash).toBe(right.ref.manifestHash);
    expect(left.contractSetHash).toBe(right.contractSetHash);
    await expect(verifyCatalogManifest(left)).resolves.toEqual(left);

    const tampered = structuredClone(left);
    tampered.components.pop();
    await expect(verifyCatalogManifest(tampered)).rejects.toBeInstanceOf(CatalogIntegrityError);
  });

  test("intersects exact contract identity, placement, and renderer features", async () => {
    const action = await actionContract();
    const components = await componentContracts(action.ref);
    const catalog = await catalogFixture(components, action.ref);
    const renderer = await rendererFixture(components);
    const accepted = await acceptedNegotiation(catalog, renderer, components);

    expect(accepted.supported).toEqual(components.map((contract) => contract.ref).sort((a, b) => (
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    )));
    expect(accepted.rejected).toEqual([]);

    const rejected = await negotiateRendererCapabilities({
      catalogs: [catalog],
      renderer,
      placement: { kind: "panel", width: 900, height: 700 },
      requirements: [{ contract: components[0]!, requiredFeatures: ["drilldown"] }],
    });
    expect(rejected.supported).toEqual([]);
    expect(rejected.rejected[0]).toMatchObject({ reason: "feature-missing", missingFeatures: ["drilldown"] });
  });

  test("detects renderer implementation metadata changed after hashing", async () => {
    const action = await actionContract();
    const components = await componentContracts(action.ref);
    const renderer = await rendererFixture(components);
    const tampered = structuredClone(renderer);
    tampered.rendererRevision = "changed";
    await expect(verifyRendererCapabilityManifest(tampered)).rejects.toMatchObject({
      code: "catalog.renderer-capability-manifest-hash",
    });
  });
});

describe("CatalogSetSlice", () => {
  test("assigns four disjoint Slice ID domains and is deterministic across input order", async () => {
    const action = await actionContract();
    const components = await componentContracts(action.ref);
    const catalog = await catalogFixture(components, action.ref);
    const renderer = await rendererFixture(components);
    const negotiation = await acceptedNegotiation(catalog, renderer, components);
    const resource = await createModelVisibleResourceOffer({
      bindingId: resourceBindingIdSchema.parse("query-results"),
      descriptor: {
        kind: "dataset",
        label: "Query results",
        resolvedSchema: { type: "array" },
        columns: [{
          columnId: columnIdSchema.parse("revenue"),
          label: "Revenue",
          valueSchema: { type: "number" },
          sensitivity: "internal",
        }],
        estimatedItems: 42,
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
    const evidence = await createModelVisibleEvidenceOffer({
      evidenceId: evidenceIdSchema.parse("query-execution"),
      descriptor: {
        kind: "query",
        label: "Query execution",
        summary: "A governed query completed successfully.",
      },
    });
    const common = {
      catalogs: [catalog],
      rendererNegotiation: negotiation,
      actions: [action.ref],
      resources: [resource],
      evidence: [evidence],
      limits: {
        maxNodes: 100,
        maxDepth: 16,
        maxActions: 8,
        maxResourceBindings: 8,
        maxEvidenceBindings: 16,
        maxTextBytes: 64_000,
        maxOperations: 1_000,
      },
      providerSchemaProfile: "openai-strict",
    };
    const [left, right] = await Promise.all([
      createCatalogSetSlice({ ...common, components: components.map((contract) => contract.ref) }),
      createCatalogSetSlice({ ...common, components: components.map((contract) => contract.ref).reverse() }),
    ]);

    expect(left.sliceHash).toBe(right.sliceHash);
    expect(left.components.map((entry) => entry.sliceComponentId)).toEqual([
      sliceComponentIdSchema.parse("component-000001"),
      sliceComponentIdSchema.parse("component-000002"),
    ]);
    expect(left.actions[0]?.sliceActionId).toBe(sliceActionIdSchema.parse("action-000001"));
    expect(left.resources[0]?.sliceResourceId).toBe(sliceResourceIdSchema.parse("resource-000001"));
    expect(left.evidence[0]?.sliceEvidenceId).toBe(sliceEvidenceIdSchema.parse("evidence-000001"));
    expect(new Set([
      ...left.components.map((entry) => entry.sliceComponentId),
      ...left.actions.map((entry) => entry.sliceActionId),
      ...left.resources.map((entry) => entry.sliceResourceId),
      ...left.evidence.map((entry) => entry.sliceEvidenceId),
    ]).size).toBe(5);
    await expect(verifyCatalogSetSlice(left)).resolves.toEqual(left);
  });

  test("rejects an unsupported renderer contract and detects offer tampering", async () => {
    const action = await actionContract();
    const components = await componentContracts(action.ref);
    const catalog = await catalogFixture(components, action.ref);
    const renderer = await rendererFixture(components);
    const negotiation = await acceptedNegotiation(catalog, renderer, components);

    await expect(createCatalogSetSlice({
      catalogs: [catalog],
      rendererNegotiation: { ...negotiation, supported: [components[0]!.ref] },
      components: [components[1]!.ref],
      actions: [],
      resources: [],
      evidence: [],
      limits: {
        maxNodes: 10,
        maxDepth: 4,
        maxActions: 0,
        maxResourceBindings: 0,
        maxEvidenceBindings: 0,
        maxTextBytes: 1_000,
        maxOperations: 10,
      },
      providerSchemaProfile: "test",
    })).rejects.toThrow("not accepted by renderer capability negotiation");

    const valid = await createCatalogSetSlice({
      catalogs: [catalog],
      rendererNegotiation: negotiation,
      components: [components[0]!.ref],
      actions: [],
      resources: [],
      evidence: [],
      limits: {
        maxNodes: 10,
        maxDepth: 4,
        maxActions: 0,
        maxResourceBindings: 0,
        maxEvidenceBindings: 0,
        maxTextBytes: 1_000,
        maxOperations: 10,
      },
      providerSchemaProfile: "test",
    });
    expect(catalogSetSliceSchema.safeParse({ ...valid, obsoleteVersion: 2 }).success).toBe(false);

    const tampered = structuredClone(valid);
    tampered.providerSchemaProfile = "different-profile";
    await expect(verifyCatalogSetSlice(tampered)).rejects.toMatchObject({ code: "catalog.slice-hash" });
  });
});
