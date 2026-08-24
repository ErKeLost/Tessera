import { randomBytes, randomUUID } from "node:crypto";
import {
  CapabilityBroker,
  InMemoryCapabilityStore,
} from "@open-generative/capabilities";
import {
  createCatalogSetSlice,
  createModelVisibleResourceOffer,
  negotiateRendererCapabilities,
  type GenerationLimits,
  type CatalogSetSlice,
  type ModelVisibleResourceOffer,
  type PlacementContext,
} from "@open-generative/catalog";
import {
  InMemoryTransactionIdentityAllocator,
  OpenGenerativeLanguageCompilerSession,
  ProposalCompilerTurn,
  compileOpenGenerativeLanguage,
  createCatalogRuntimeValidationPort,
  createCompilerCatalog,
  type CompiledOpenGenerativeLanguage,
  type CompilerAuthority,
  type CompilerWriteScope,
  type OpenGenerativeLanguageSession,
  type OpenGenerativeLanguageSessionContext,
  type OpenGenerativePresentationPolicy,
} from "@open-generative/compiler";
import {
  createOfficialCatalog,
  createOfficialRendererCapabilityManifest,
  createSingleChunkOfficialRendererArtifactSet,
  hashNamespacedCanonical,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  actorAuditRefSchema,
  branchHeadSchema,
  branchIdSchema,
  canonicalStringify,
  columnIdSchema,
  committedRevisionSchema,
  correlationIdSchema,
  documentContentSchema,
  documentIdSchema,
  hashCanonical,
  hashDocumentContent,
  headTokenSchema,
  jsonPointerSchema,
  nodeIdSchema,
  resourceBindingIdSchema,
  resourceDatasetPayloadSchema,
  resourceWindowRequestSchema,
  revisionIdSchema,
  streamIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  type HostCommandEnvelope,
  type JSONSchema,
  type ResourceBindingDeclaration,
  type ResourceBindingId,
  type ResourceDatasetPayload,
  type ResourceResolutionResult,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  EncryptedResourceCursorCodec,
  InMemoryResourceGrantStore,
  InMemoryResourceVersionStore,
  ResourceGateway,
  ResourceSchemaRegistry,
} from "@open-generative/resources";
import {
  DocumentTransactionRuntime,
  InMemoryRuntimeStore,
  computeEntityRevisionIndex,
  type RuntimeTransactionRecord,
} from "@open-generative/runtime";
import {
  EncryptedSurfaceResumeCursorCodec,
  HostServer,
  InMemoryDocumentStateWriter,
  InMemorySurfaceSessionJournal,
  SurfaceTransactionPublisher,
  SurfaceSessionManager,
  createAuthorityContext,
  type AuthorityContext,
  type HostCommandContext,
  type HostCommandResult,
} from "@open-generative/server";

const DEFAULT_GENERATION_LIMITS: GenerationLimits = Object.freeze({
  maxNodes: 64,
  maxDepth: 8,
  maxActions: 16,
  maxResourceBindings: 32,
  maxEvidenceBindings: 64,
  maxTextBytes: 96_000,
  maxOperations: 256,
});
const DEFAULT_PLACEMENT: PlacementContext = Object.freeze({
  kind: "inline",
  width: 720,
  height: 520,
});
const DEFAULT_STREAM_POLICY = Object.freeze({
  maxSequenceGap: 16,
  maxBufferedBytes: 1_000_000,
  ackEveryEvents: 8,
  backpressure: "publish-snapshot" as const,
});
const DEFAULT_TURN_TTL_MS = 60 * 60 * 1_000;

export type OpenGenerativeAuthority = AuthorityContext;

export type OpenGenerativeDatasetResource = Readonly<{
  bindingId: string;
  label: string;
  description?: string;
  dataset: ResourceDatasetPayload;
  classification?: "public" | "internal" | "confidential" | "restricted";
  sensitivity?: "public" | "internal" | "confidential" | "restricted";
}>;

export type PrepareOpenGenerativeTurnInput = Readonly<{
  authority: OpenGenerativeAuthority;
  resources: readonly OpenGenerativeDatasetResource[];
  presentationPolicy?: OpenGenerativePresentationPolicy;
  providerSchemaProfile?: "canonical" | "openai-strict" | "anthropic-json-schema" | "google-json-schema";
  placement?: PlacementContext;
  generationLimits?: GenerationLimits;
  correlationId?: string;
  expiresAt?: Date;
  title?: string;
}>;

export type OpenGenerativeTurn = Readonly<{
  language: CompiledOpenGenerativeLanguage;
  catalogSlice: CatalogSetSlice;
  surfaceSessionId: string;
  createSession(
    context?: OpenGenerativeLanguageSessionContext,
  ): Promise<OpenGenerativeLanguageSession>;
  drainEvents(): readonly SurfaceEventEnvelope[];
}>;

export type OpenGenerativeHost = Readonly<{
  catalog: OfficialCatalogBundle;
  prepareTurn(input: PrepareOpenGenerativeTurnInput): Promise<OpenGenerativeTurn | undefined>;
  handleCommand(
    command: HostCommandEnvelope,
    authority: OpenGenerativeAuthority,
    context: HostCommandContext,
  ): Promise<HostCommandResult>;
}>;

type PublishedTurnResource = Readonly<{
  bindingId: ResourceBindingId;
  offer: ModelVisibleResourceOffer;
  declaration: ResourceBindingDeclaration;
  classification: "public" | "internal" | "confidential" | "restricted";
}>;

export async function createOpenGenerativeHost(): Promise<OpenGenerativeHost> {
  const catalog = await createOfficialCatalog();
  const datasetConstraint = officialDatasetConstraint(catalog);
  const schemas = new ResourceSchemaRegistry();
  const registeredDatasetConstraint = schemas.register({
    schemaId: "open-generative.dataset",
    schemaRevision: 1,
    schema: datasetConstraint.resolvedSchema,
  });
  if (registeredDatasetConstraint.schemaHash !== datasetConstraint.schemaHash) {
    throw new Error("The registered dataset schema does not match the official component contracts.");
  }

  const resources = new ResourceGateway({
    versions: new InMemoryResourceVersionStore(),
    grants: new InMemoryResourceGrantStore(),
    schemas,
    cursorCodec: new EncryptedResourceCursorCodec(randomBytes(32)),
    projectionPolicy: { authorize: async () => ({ allowed: true }) },
  });
  const journal = new InMemorySurfaceSessionJournal({
    cursors: new EncryptedSurfaceResumeCursorCodec(randomBytes(32)),
  });
  const rendererManifest = await createOfficialRendererCapabilityManifest(
    catalog,
    createSingleChunkOfficialRendererArtifactSet({
      chunkHash: await hashNamespacedCanonical("open-generative.host.renderer", { kind: "chunk" }),
      stylesheetHash: await hashNamespacedCanonical("open-generative.host.renderer", { kind: "stylesheet" }),
    }),
  );
  const componentRegistry = new Map(
    catalog.componentContracts.map((contract) => [contractKey(contract.ref), contract]),
  );
  const hostServer = new HostServer({
    journal,
    resources,
    capabilities: new CapabilityBroker({
      store: new InMemoryCapabilityStore(),
      policy: {
        authorize: async () => ({ allowed: false, code: "host.action-unavailable", message: "This surface exposes no actions." }),
        checkPreconditions: async () => false,
      },
    }),
    documentState: new InMemoryDocumentStateWriter({
      policy: { authorize: async () => ({ allowed: false, code: "host.state-unavailable", message: "This surface exposes no document state." }) },
    }),
    components: { resolve: async (ref) => componentRegistry.get(contractKey(ref)) },
    authorityPolicy: { authorize: async () => ({ allowed: true }) },
  });

  return Object.freeze({
    catalog,
    async prepareTurn(input) {
      return createTurn({
        input,
        catalog,
        rendererManifest,
        resources,
        journal,
        registeredDatasetConstraint,
      });
    },
    handleCommand(command, authority, context) {
      return hostServer.handleCommand(command, authority, context);
    },
  });
}

async function createTurn(input: Readonly<{
  input: PrepareOpenGenerativeTurnInput;
  catalog: OfficialCatalogBundle;
  rendererManifest: Awaited<ReturnType<typeof createOfficialRendererCapabilityManifest>>;
  resources: ResourceGateway;
  journal: InMemorySurfaceSessionJournal;
  registeredDatasetConstraint: ReturnType<ResourceSchemaRegistry["register"]>;
}>): Promise<OpenGenerativeTurn> {
  const authority = createAuthorityContext(input.input.authority);
  const placement = input.input.placement ?? DEFAULT_PLACEMENT;
  const generationLimits = input.input.generationLimits ?? DEFAULT_GENERATION_LIMITS;
  const providerSchemaProfile = input.input.providerSchemaProfile ?? "canonical";
  const expiresAt = (input.input.expiresAt ?? new Date(Date.now() + DEFAULT_TURN_TTL_MS)).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw new TypeError("Open Generative turn expiry must be in the future.");
  const correlationId = correlationIdSchema.parse(
    input.input.correlationId ?? `correlation:${randomUUID()}`,
  );
  const surfaceSessionId = surfaceSessionIdSchema.parse(`surface:${randomUUID()}`);
  const streamId = streamIdSchema.parse(`stream:${randomUUID()}`);
  const selectedComponents = [...input.catalog.componentContracts]
    .sort((left, right) => canonicalStringify(left.ref).localeCompare(canonicalStringify(right.ref)));
  const rendererRequirements = selectedComponents.map((contract) => ({
    contract,
    requiredFeatures: [] as string[],
  })).sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  const rendererNegotiation = await negotiateRendererCapabilities({
    catalogs: [input.catalog.manifest],
    renderer: input.rendererManifest,
    placement,
    requirements: rendererRequirements,
  });
  const publishedResources = await Promise.all(input.input.resources.map((resource, index) => (
    publishTurnResource({
      resource,
      index,
      surfaceSessionId,
      resources: input.resources,
      registeredDatasetConstraint: input.registeredDatasetConstraint,
      resolvedSchema: officialDatasetConstraint(input.catalog).resolvedSchema,
    })
  )));
  const slice = await createCatalogSetSlice({
    catalogs: [input.catalog.manifest],
    rendererNegotiation,
    components: selectedComponents.map((contract) => contract.ref),
    actions: [],
    resources: publishedResources.map((resource) => resource.offer),
    evidence: [],
    limits: generationLimits,
    providerSchemaProfile,
  });
  const compilerCatalog = await createCompilerCatalog({
    slice,
    components: selectedComponents,
    actions: [],
  });
  const language = compileOpenGenerativeLanguage({
    catalog: compilerCatalog,
    presentationPolicy: input.input.presentationPolicy ?? "auto",
  });
  const baseDocument = createBaseDocument(
    input.catalog,
    slice.contractSetHash,
    input.input.title,
    publishedResources,
  );
  const baseEntityRevisions = await computeEntityRevisionIndex(baseDocument);
  const baseRevisionId = revisionIdSchema.parse(`revision:${randomUUID()}`);
  const documentId = documentIdSchema.parse(`document:${randomUUID()}`);
  const branchId = branchIdSchema.parse("main");
  const baseHeadToken = headTokenSchema.parse(`head:${randomUUID()}`);
  const baseRevision = committedRevisionSchema.parse({
    envelope: {
      documentId,
      revisionId: baseRevisionId,
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(baseDocument),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: new Date().toISOString(),
      createdBy: authority.actorAuditRef,
    },
    content: baseDocument,
  });
  const store = new InMemoryRuntimeStore<RuntimeTransactionRecord>();
  store.seedRevision(
    { revision: baseRevision, entityRevisions: baseEntityRevisions },
    branchHeadSchema.parse({
      documentId,
      branchId,
      revisionId: baseRevisionId,
      headToken: baseHeadToken,
    }),
  );
  const compilerAuthority = createCompilerAuthority(publishedResources);
  const documentRuntime = new DocumentTransactionRuntime({
    store,
    validation: createCatalogRuntimeValidationPort(compilerCatalog, compilerAuthority),
  });
  const identityAllocator = new InMemoryTransactionIdentityAllocator({
    mint: ({ kind }) => `${kind}:${randomUUID()}`,
  });
  const writeScope = createInitialWriteScope(baseDocument, baseEntityRevisions);
  const [authorityContextHash, writeScopeHash] = await Promise.all([
    hashCanonical(HASH_DOMAINS.operationPayload, authority),
    hashCanonical(HASH_DOMAINS.operationPayload, writeScope),
  ]);
  const resolvedResources = await resolveCommittedResources({
    revision: baseRevision,
    publishedResources,
    resources: input.resources,
    authority,
    surfaceSessionId,
    expiresAt,
  });
  const manager = new SurfaceSessionManager({
    journal: input.journal,
    surfaceSessionIdFactory: () => surfaceSessionId,
    streamIdFactory: () => streamId,
  });
  const opened = await manager.open({
    authority,
    rendererCapabilityManifest: input.rendererManifest,
    catalogs: [input.catalog.manifest],
    rendererRequirements,
    actionContracts: [],
    resourceOffers: publishedResources.map((resource) => resource.offer),
    evidenceOffers: [],
    placement,
    generationLimits,
    providerSchemaProfile,
    committedRevision: baseRevision,
    resources: resolvedResources,
    streamPolicy: DEFAULT_STREAM_POLICY,
    expiresAt,
    correlationId,
  });
  if (opened.status !== "created") throw new Error("Open Generative Surface session already exists.");

  const events: SurfaceEventEnvelope[] = [];
  const bufferedEvents: SurfaceEventEnvelope[] = [];
  let surfaceExposed = false;
  const captureEvents = (next: readonly SurfaceEventEnvelope[]) => {
    if (surfaceExposed) {
      events.push(...next);
      return;
    }
    bufferedEvents.push(...next);
    const becameRenderable = next.some((event) => (
      event.payload.type === "preview-applied"
      && event.payload.preview.operations.some((operation) => operation.op === "set-root")
    ));
    if (!becameRenderable) return;
    surfaceExposed = true;
    events.push(opened.event, ...bufferedEvents);
    bufferedEvents.length = 0;
  };
  const runtime = new SurfaceTransactionPublisher({
    journal: input.journal,
    runtime: documentRuntime,
    surfaceSessionId,
    correlationId,
    onEvents: captureEvents,
  });
  let activeCompilerSession: symbol | undefined;
  let turnCommitted = false;

  return Object.freeze({
    language,
    catalogSlice: slice,
    surfaceSessionId,
    async createSession(context = {}) {
      if (turnCommitted) {
        throw new Error("The Open Generative turn has already committed a Surface revision.");
      }
      if (activeCompilerSession) {
        throw new Error("The Open Generative turn already has an active compiler session.");
      }
      context.abortSignal?.throwIfAborted();
      const sessionToken = Symbol("open-generative-compiler-session");
      activeCompilerSession = sessionToken;
      const transactionId = transactionIdSchema.parse(`transaction:${randomUUID()}`);
      const targetRevisionId = revisionIdSchema.parse(`revision:${randomUUID()}`);
      const turn = new ProposalCompilerTurn({
        catalog: compilerCatalog,
        authority: compilerAuthority,
        runtime,
        identityAllocator,
        baseDocument,
        baseEntityRevisions,
        writeScope,
        begin: {
          transactionId,
          surfaceSessionId,
          documentId,
          branchId,
          baseRevisionId,
          expectedHeadToken: baseHeadToken,
          targetRevisionId,
          nextHeadToken: headTokenSchema.parse(`head:${randomUUID()}`),
          createdAt: new Date().toISOString(),
          createdBy: actorAuditRefSchema.parse(authority.actorAuditRef),
        },
        authorityContextHash,
        writeScopeHash,
        correlationId,
      });
      const session = new OpenGenerativeLanguageCompilerSession({
        compiled: language,
        catalog: compilerCatalog,
        turn,
        expectedRootId: baseDocument.rootNodeId,
        supersededRootRevision: baseEntityRevisions.nodes[baseDocument.rootNodeId],
        context,
      });
      const release = () => {
        if (activeCompilerSession === sessionToken) activeCompilerSession = undefined;
      };
      return Object.freeze({
        async start() {
          try {
            await session.start();
          } catch (error) {
            release();
            throw error;
          }
        },
        async pushTextDelta(delta: string) {
          try {
            const update = await session.pushTextDelta(delta);
            if (update.outcome) {
              if (update.outcome.status === "committed") turnCommitted = true;
              release();
            }
            return update;
          } catch (error) {
            release();
            throw error;
          }
        },
        async finish() {
          try {
            const outcome = await session.finish();
            if (outcome.status === "committed") turnCommitted = true;
            return outcome;
          } finally {
            release();
          }
        },
        async abort(reason?: "timeout" | "cancelled") {
          try {
            const outcome = await session.abort(reason);
            if (outcome.status === "committed") turnCommitted = true;
            return outcome;
          } finally {
            release();
          }
        },
      });
    },
    drainEvents() {
      return Object.freeze(events.splice(0));
    },
  });
}

async function publishTurnResource(input: Readonly<{
  resource: OpenGenerativeDatasetResource;
  index: number;
  surfaceSessionId: string;
  resources: ResourceGateway;
  registeredDatasetConstraint: ReturnType<ResourceSchemaRegistry["register"]>;
  resolvedSchema: JSONSchema;
}>): Promise<PublishedTurnResource> {
  const bindingId = resourceBindingIdSchema.parse(input.resource.bindingId);
  const dataset = resourceDatasetPayloadSchema.parse(input.resource.dataset);
  const publication = await input.resources.publishPinned({
    resourceKey: `turn.${input.surfaceSessionId}.${input.index + 1}`,
    kind: "dataset",
    schemaConstraint: input.registeredDatasetConstraint,
    selector: { windowLimit: Math.min(10_000, Math.max(1, dataset.rows.length)) },
    payload: dataset,
  });
  const sensitivity = input.resource.sensitivity ?? "internal";
  const offer = await createModelVisibleResourceOffer({
    bindingId,
    descriptor: {
      kind: "dataset",
      label: input.resource.label,
      ...(input.resource.description === undefined ? {} : { description: input.resource.description }),
      resolvedSchema: input.resolvedSchema,
      columns: dataset.columns.map((column) => ({
        columnId: columnIdSchema.parse(column.columnId),
        label: column.label,
        valueSchema: datasetColumnSchema(column.valueType),
        sensitivity,
      })),
      estimatedItems: dataset.totalRows,
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
  return Object.freeze({
    bindingId,
    offer,
    declaration: publication.declaration,
    classification: input.resource.classification ?? "internal",
  });
}

function createCompilerAuthority(resources: readonly PublishedTurnResource[]): CompilerAuthority {
  return Object.freeze({
    actions: [],
    resources: resources.map((resource) => ({
      source: resource.offer.source,
      declaration: resource.declaration,
      classification: resource.classification,
      existingBindingIds: [resource.bindingId],
    })),
    evidence: [],
    statePolicy: {
      decide: () => ({
        scope: "surface",
        persistence: "session",
        sensitivity: "private",
        modelVisibility: "descriptor",
        retention: "retain",
        classification: "internal",
      } as const),
    },
    informationFlow: { maxDocumentClassification: "restricted" },
  });
}

function createBaseDocument(
  catalog: OfficialCatalogBundle,
  contractSetHash: string,
  title: string | undefined,
  resources: readonly PublishedTurnResource[],
) {
  const rootNodeId = nodeIdSchema.parse("node:root");
  return documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: { manifestRefs: [catalog.manifest.ref], contractSetHash },
    requirements: { dataClassifications: [], evidence: "none", placements: [], capabilities: [] },
    rootNodeId,
    nodes: {
      [rootNodeId]: {
        contract: catalog.components.layoutStack.ref,
        props: { gap: { kind: "literal", value: "md" } },
        slots: { body: [] },
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: Object.fromEntries(resources.map((resource) => [
      resource.bindingId,
      resource.declaration,
    ])),
    evidenceBindings: {},
    claims: {},
    meta: { title: title?.trim() || "Generative analysis", tags: [] },
  });
}

function createInitialWriteScope(
  document: ReturnType<typeof documentContentSchema.parse>,
  revisions: Awaited<ReturnType<typeof computeEntityRevisionIndex>>,
): CompilerWriteScope {
  return Object.freeze({
    creatable: ["node", "state", "action", "resource", "evidence", "claim"],
    readable: {
      node: [],
      state: [],
      action: [],
      resource: Object.keys(document.resourceBindings).map((id) => resourceBindingIdSchema.parse(id)),
      evidence: [],
      claim: [],
    },
    writable: {
      node: { [document.rootNodeId]: revisions.nodes[document.rootNodeId]! },
      state: {},
      action: {},
      resource: {},
      evidence: {},
      claim: {},
    },
    root: { expectedRootId: document.rootNodeId },
    meta: { expectedMetaHash: revisions.metaHash },
  });
}

async function resolveCommittedResources(input: Readonly<{
  revision: ReturnType<typeof committedRevisionSchema.parse>;
  publishedResources: readonly PublishedTurnResource[];
  resources: ResourceGateway;
  authority: AuthorityContext;
  surfaceSessionId: ReturnType<typeof surfaceSessionIdSchema.parse>;
  expiresAt: string;
}>): Promise<Partial<Record<ResourceBindingId, ResourceResolutionResult>>> {
  const resolved: Partial<Record<ResourceBindingId, ResourceResolutionResult>> = {};
  for (const [bindingIdText, declaration] of Object.entries(input.revision.content.resourceBindings)) {
    const bindingId = resourceBindingIdSchema.parse(bindingIdText);
    const publication = input.publishedResources.find(
      (candidate) => canonicalStringify(candidate.declaration) === canonicalStringify(declaration),
    );
    if (!publication) throw new Error("A committed resource binding does not match a frozen Host offer.");
    await input.resources.createGrant({
      bindingId,
      surfaceSessionId: input.surfaceSessionId,
      authority: input.authority,
      authorityPolicyRevision: input.authority.authorityPolicyRevision,
      allowedOperations: ["read", "window"],
      rowPolicyHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, { policy: "rows", bindingId }),
      columnPolicyHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, { policy: "columns", bindingId }),
      expiresAt: input.expiresAt,
    });
    const request = resourceWindowRequestSchema.parse({
      requestId: `resource-initial:${randomUUID()}`,
      bindingId,
      surfaceSessionId: input.surfaceSessionId,
      expectedRevisionId: input.revision.envelope.revisionId,
      ...(declaration.resolution.mode === "pinned"
        ? { expectedResourceVersionId: declaration.resolution.versionId }
        : {}),
    });
    resolved[bindingId] = await input.resources.resolve({
      request,
      declaration,
      authority: input.authority,
      activeRevisionId: input.revision.envelope.revisionId,
    });
  }
  return resolved;
}

function officialDatasetConstraint(catalog: OfficialCatalogBundle) {
  const policy = catalog.components.dataChart.authoringBindings[jsonPointerSchema.parse("/spec/data")];
  const constraint = policy?.resource?.schemaConstraints[0];
  if (!constraint) throw new Error("The official data.chart contract has no dataset schema constraint.");
  return constraint;
}

function datasetColumnSchema(
  valueType: ResourceDatasetPayload["columns"][number]["valueType"],
): JSONSchema {
  if (valueType === "number") return { type: "number" };
  if (valueType === "boolean") return { type: "boolean" };
  if (valueType === "date") return { type: "string", format: "date" };
  if (valueType === "datetime") return { type: "string", format: "date-time" };
  return { type: "string" };
}

function contractKey(ref: Readonly<{
  publisher: string;
  catalogId: string;
  componentType: string;
  revision: number;
}>): string {
  return `${ref.publisher}/${ref.catalogId}/${ref.componentType}@${ref.revision}`;
}
