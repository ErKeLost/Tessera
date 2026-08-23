import { randomBytes, randomUUID } from "node:crypto";
import {
  CapabilityBroker,
  InMemoryCapabilityStore,
} from "@open-generative/capabilities";
import {
  createOfficialCatalog,
  createOfficialRendererCapabilityManifest,
  createSingleChunkOfficialRendererArtifactSet,
  dataChartAuthoringPropsSchema,
  hashNamespacedCanonical,
  type DataChartAuthoringProps,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  hashCanonical,
  hashDocumentContent,
  committedRevisionSchema,
  correlationIdSchema,
  documentContentSchema,
  jsonObjectSchema,
  jsonPointerSchema,
  resourceDatasetPayloadSchema,
  resourceBindingIdSchema,
  resourceWindowRequestSchema,
  valueExprSchema,
  type CommittedRevision,
  type HostCommandEnvelope,
  type JsonObject,
  type JsonValue,
  type ResourceBindingDeclaration,
  type ResourceDatasetPayload,
  type SurfaceSessionId,
  type SurfaceEventEnvelope,
  type ValueExpr,
} from "@open-generative/protocol";
import {
  EncryptedResourceCursorCodec,
  InMemoryResourceGrantStore,
  InMemoryResourceVersionStore,
  ResourceGateway,
  ResourceSchemaRegistry,
} from "@open-generative/resources";
import {
  EncryptedSurfaceResumeCursorCodec,
  HostServer,
  InMemoryDocumentStateWriter,
  InMemorySurfaceSessionJournal,
  SurfaceSessionManager,
  createAuthorityContext,
  type AuthorityContext,
  type HostCommandContext,
  type HostCommandResult,
} from "@open-generative/server";

const DATA_BINDING_ID = resourceBindingIdSchema.parse("data");
const DATA_BINDING_PATH = jsonPointerSchema.parse("/spec/data");
const DEFAULT_GENERATION_LIMITS = Object.freeze({
  maxNodes: 16,
  maxDepth: 4,
  maxActions: 0,
  maxResourceBindings: 1,
  maxEvidenceBindings: 0,
  maxTextBytes: 16_384,
  maxOperations: 64,
});
const DEFAULT_STREAM_POLICY = Object.freeze({
  maxSequenceGap: 16,
  maxBufferedBytes: 1_000_000,
  ackEveryEvents: 8,
  backpressure: "publish-snapshot" as const,
});

export type OpenGenerativeAuthority = AuthorityContext;

type WithoutData<TSpec> = TSpec extends { data: unknown }
  ? Omit<TSpec, "data">
  : never;

export type DataChartSpecInput = WithoutData<DataChartAuthoringProps["spec"]>;

export type PresentDataChartInput = Readonly<{
  authority: OpenGenerativeAuthority;
  /** The chart contract accepts a strict resource binding; raw data never becomes model props. */
  dataset: ResourceDatasetPayload;
  /** A validated semantic data.chart grammar with `data` bound by the host. */
  spec: DataChartSpecInput;
  title?: string;
  correlationId?: string;
  expiresAt?: Date;
}>;

export type PresentedSurface = Readonly<{
  event: SurfaceEventEnvelope;
  surfaceSessionId: SurfaceSessionId;
  revisionId: string;
}>;

export type OpenGenerativeHost = Readonly<{
  catalog: OfficialCatalogBundle;
  presentDataChart(input: PresentDataChartInput): Promise<PresentedSurface>;
  handleCommand(
    command: HostCommandEnvelope,
    authority: OpenGenerativeAuthority,
    context: HostCommandContext,
  ): Promise<HostCommandResult>;
}>;

/**
 * Creates a complete, in-process governed host. Embedders only publish a
 * validated presentation; sessions, grants, resource windows and commands
 * remain owned by this facade.
 */
export async function createOpenGenerativeHost(): Promise<OpenGenerativeHost> {
  const catalog = await createOfficialCatalog();
  const contract = catalog.components.dataChart;
  const policy = contract.authoringBindings[DATA_BINDING_PATH];
  const constraint = policy?.resource?.schemaConstraints[0];
  if (constraint === undefined) {
    throw new Error("The official data.chart contract does not declare its dataset schema.");
  }

  const schemas = new ResourceSchemaRegistry();
  const datasetConstraint = schemas.register({
    schemaId: "open-generative.dataset",
    schemaRevision: 1,
    schema: constraint.resolvedSchema,
  });
  if (datasetConstraint.schemaHash !== constraint.schemaHash) {
    throw new Error("The registered dataset schema does not match the official data.chart contract.");
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
  const components = new Map([[contractKey(contract.ref), contract]]);
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
    components: { resolve: async (ref) => components.get(contractKey(ref)) },
    authorityPolicy: { authorize: async () => ({ allowed: true }) },
  });

  return Object.freeze({
    catalog,
    async presentDataChart(input) {
      const authority = createAuthorityContext(input.authority);
      const surfaceSessionId = `surface:${randomUUID()}`;
      const streamId = `stream:${randomUUID()}`;
      const bindingId = DATA_BINDING_ID;
      const dataset = resourceDatasetPayloadSchema.parse(input.dataset);
      const parsedProps = dataChartAuthoringPropsSchema.parse({
        spec: { ...input.spec, data: { kind: "resource-ref", bindingId } },
      });
      const publication = await resources.publishPinned({
        resourceKey: `surface.${surfaceSessionId}.${bindingId}`,
        kind: "dataset",
        schemaConstraint: datasetConstraint,
        selector: { windowLimit: 10_000 },
        payload: dataset,
      });
      const revision = await createDataChartRevision({
        catalog,
        contract,
        bindingId,
        declaration: publication.declaration,
        spec: parsedProps.spec,
        title: input.title ?? parsedProps.spec.title,
      });
      const expiresAt = (input.expiresAt ?? new Date(Date.now() + 60 * 60 * 1_000)).toISOString();
      await resources.createGrant({
        bindingId,
        surfaceSessionId,
        authority,
        authorityPolicyRevision: authority.authorityPolicyRevision,
        allowedOperations: ["read", "window"],
        rowPolicyHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, { policy: "rows", surfaceSessionId }),
        columnPolicyHash: await hashCanonical(HASH_DOMAINS.hostCommandPayload, { policy: "columns", surfaceSessionId }),
        expiresAt,
      });
      const request = resourceWindowRequestSchema.parse({
        requestId: `resource-initial:${randomUUID()}`,
        bindingId,
        surfaceSessionId,
        expectedRevisionId: revision.envelope.revisionId,
        expectedResourceVersionId: publication.declaration.resolution.versionId,
      });
      const resolved = await resources.resolve({
        request,
        declaration: publication.declaration,
        authority,
        activeRevisionId: revision.envelope.revisionId,
      });
      const manager = new SurfaceSessionManager({
        journal,
        surfaceSessionIdFactory: () => surfaceSessionId,
        streamIdFactory: () => streamId,
      });
      const opened = await manager.open({
        authority,
        rendererCapabilityManifest: rendererManifest,
        catalogs: [catalog.manifest],
        rendererRequirements: [{ contract, requiredFeatures: [] }],
        actionContracts: [],
        resourceOffers: [],
        evidenceOffers: [],
        placement: { kind: "inline", width: 720, height: 520 },
        generationLimits: DEFAULT_GENERATION_LIMITS,
        providerSchemaProfile: "open-generative.host",
        committedRevision: revision,
        resources: { [bindingId]: resolved },
        streamPolicy: DEFAULT_STREAM_POLICY,
        expiresAt,
        correlationId: correlationIdSchema.parse(input.correlationId ?? `correlation:${randomUUID()}`),
      });
      if (opened.status !== "created") {
        throw new Error("Open Generative surface session already exists.");
      }
      return Object.freeze({
        event: opened.event,
        surfaceSessionId: opened.session.value.surfaceSessionId,
        revisionId: revision.envelope.revisionId,
      });
    },
    handleCommand(command, authority, context) {
      return hostServer.handleCommand(command, authority, context);
    },
  });
}

async function createDataChartRevision(input: Readonly<{
  catalog: OfficialCatalogBundle;
  contract: OfficialCatalogBundle["components"]["dataChart"];
  bindingId: string;
  declaration: ResourceBindingDeclaration;
  spec: DataChartAuthoringProps["spec"];
  title: string;
}>): Promise<CommittedRevision> {
  const content = documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [input.catalog.manifest.ref],
      contractSetHash: input.catalog.manifest.contractSetHash,
    },
    requirements: {
      dataClassifications: [],
      evidence: "none" as const,
      placements: [],
      capabilities: [],
    },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: input.contract.ref,
        props: jsonObjectToValueExpr(jsonObjectSchema.parse({ spec: input.spec })),
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: { [input.bindingId]: input.declaration },
    evidenceBindings: {},
    claims: {},
    meta: {
      title: input.title,
      tags: ["data-chart"],
    },
  });
  const documentId = `document:${randomUUID()}`;
  const revisionId = `revision:${randomUUID()}`;
  return committedRevisionSchema.parse({
    envelope: {
      documentId,
      revisionId,
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: new Date().toISOString(),
      createdBy: "open-generative-host",
    },
    content,
  });
}

function jsonObjectToValueExpr(value: JsonObject): Record<string, ValueExpr> {
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonToValueExpr(child)]));
}

function jsonToValueExpr(value: JsonValue): ValueExpr {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.kind === "resource-ref" || value.kind === "state-ref") return valueExprSchema.parse(value);
    return {
      kind: "object",
      entries: jsonObjectToValueExpr(value),
    };
  }
  if (Array.isArray(value)) return { kind: "array", items: value.map(jsonToValueExpr) };
  return { kind: "literal", value };
}

function contractKey(ref: Readonly<{ publisher: string; catalogId: string; componentType: string; revision: number }>): string {
  return `${ref.publisher}/${ref.catalogId}/${ref.componentType}@${ref.revision}`;
}
