import {
  createOfficialCatalog,
  hashNamespacedCanonical,
  officialChartSpecFixtures,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  canonicalStringify,
  committedRevisionSchema,
  documentContentSchema,
  hashCanonical,
  hashDocumentContent,
  jsonObjectSchema,
  jsonPointerSchema,
  jsonValueSchema,
  resourceBindingIdSchema,
  resourceResolutionIdentitySchema,
  resourceWindowRequestSchema,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
  surfaceSnapshotSchema,
  valueExprSchema,
  type JSONSchema,
  type JsonValue,
  type ResourceBindingDeclaration,
  type ResourceResolutionIdentity,
  type ResourceResolutionResult,
  type Sha256Hash,
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
  descriptorKey,
  type PreviewDescriptor,
} from "@/components/generative-gallery-model";

export type GalleryResourceSource = Readonly<{
  bindingId: string;
  componentType: "data.chart";
  bindingPath: "/spec/data";
  sourceValue: JsonValue;
  schema: JSONSchema;
  declaration: ResourceBindingDeclaration;
}>;

export type GenerativeGalleryProofCase = Readonly<{
  descriptor: PreviewDescriptor;
  event: SurfaceEventEnvelope;
  resourceSources: readonly GalleryResourceSource[];
}>;

const FIXED_TIME = "2026-08-22T01:30:00.000Z";
const ACTOR_BINDING_HASH = sha256HashSchema.parse(`sha256:${"a".repeat(64)}`);
const TENANT_BINDING_HASH = sha256HashSchema.parse(`sha256:${"b".repeat(64)}`);
export const GALLERY_ROW_POLICY_HASH = sha256HashSchema.parse(`sha256:${"c".repeat(64)}`);
export const GALLERY_COLUMN_POLICY_HASH = sha256HashSchema.parse(`sha256:${"d".repeat(64)}`);
let catalogPromise: Promise<OfficialCatalogBundle> | undefined;

export async function createGenerativeGalleryEvent(
  descriptor: PreviewDescriptor,
): Promise<SurfaceEventEnvelope> {
  return (await createGenerativeGalleryProofCase(descriptor)).event;
}

export async function createGenerativeGalleryProofCase(
  descriptor: PreviewDescriptor,
): Promise<GenerativeGalleryProofCase> {
  catalogPromise ??= createOfficialCatalog();
  const catalog = await catalogPromise;
  const fixture = officialChartSpecFixtures.find(
    candidate => candidate.recipeName === descriptor.value,
  );
  if (fixture === undefined) {
    throw new Error(`Missing official chart fixture for ${descriptor.value}.`);
  }

  const contract = catalog.componentContracts.find(
    candidate => candidate.ref.componentType === "data.chart",
  );
  if (contract === undefined) {
    throw new Error("The official Catalog does not contain data.chart.");
  }
  const bindingPolicy = contract.authoringBindings[jsonPointerSchema.parse("/spec/data")];
  const schemaConstraint = bindingPolicy?.resource?.schemaConstraints[0];
  if (schemaConstraint === undefined) {
    throw new Error("The data.chart Contract has no /spec/data Resource policy.");
  }

  const slug = safeIdentity(descriptor.value);
  const surfaceSessionId = `surface.recipe-${slug}`;
  const revisionId = `revision.recipe-${slug}.1`;
  const sourceValue = jsonValueSchema.parse(fixture.dataset);
  const bindingId = resourceBindingIdSchema.parse(fixture.spec.data.bindingId);
  const schemas = new ResourceSchemaRegistry();
  const registeredConstraint = schemas.register({
    schemaId: `schema.tessera.data-chart.${slug}`,
    schemaRevision: 1,
    schema: schemaConstraint.resolvedSchema,
  });
  if (registeredConstraint.schemaHash !== schemaConstraint.schemaHash) {
    throw new Error(`Resource schema hash drifted for ${descriptor.value}.`);
  }

  const gateway = new ResourceGateway({
    versions: new InMemoryResourceVersionStore(),
    grants: new InMemoryResourceGrantStore(),
    schemas,
    cursorCodec: new EncryptedResourceCursorCodec(new Uint8Array(32).fill(7)),
    projectionPolicy: {
      authorize: async () => ({ allowed: true }),
    },
    now: () => new Date(FIXED_TIME),
    versionIdFactory: () => `resource-version.recipe-${slug}.1`,
    snapshotIdFactory: () => `resource-snapshot.recipe-${slug}.1`,
    grantIdFactory: () => `resource-grant.recipe-${slug}.1`,
  });
  const publication = await gateway.publishPinned({
    resourceKey: `tessera.docs.${bindingId}.${slug}`,
    kind: "dataset",
    schemaConstraint: registeredConstraint,
    selector: { windowLimit: 10_000 },
    payload: sourceValue,
    observedAt: FIXED_TIME,
  });

  const capabilities = catalog.actionContracts
    .map(actionContract => actionContract.ref)
    .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
  const props = jsonObjectSchema.parse({ spec: fixture.spec });
  const content = documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [catalog.manifest.ref],
      contractSetHash: catalog.manifest.contractSetHash,
    },
    requirements: {
      dataClassifications: [],
      evidence: "none",
      placements: [],
      capabilities,
    },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: contract.ref,
        props: Object.fromEntries(
          Object.entries(props).map(([key, value]) => [key, jsonToValueExpr(value)]),
        ),
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: { [bindingId]: publication.declaration },
    evidenceBindings: {},
    claims: {},
    meta: {
      title: `Tessera Agent ${fixture.spec.title}`,
      description: "Official data.chart recipe fixture through the trusted render chain.",
      locale: "en-US",
      tags: ["data-agent", "data-chart", "tessera-agent"],
    },
  });
  const revision = committedRevisionSchema.parse({
    envelope: {
      documentId: `document.recipe-${slug}`,
      revisionId,
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: FIXED_TIME,
      createdBy: "tessera-docs-resource-gateway",
    },
    content,
  });

  const request = resourceWindowRequestSchema.parse({
    requestId: `request.recipe-${slug}.1`,
    bindingId,
    surfaceSessionId,
    expectedRevisionId: revisionId,
    expectedResourceVersionId: publication.declaration.resolution.mode === "pinned"
      ? publication.declaration.resolution.versionId
      : undefined,
  });
  await gateway.createGrant({
    bindingId,
    surfaceSessionId,
    authority: {
      actorBindingHash: ACTOR_BINDING_HASH,
      tenantBindingHash: TENANT_BINDING_HASH,
    },
    authorityPolicyRevision: "tessera-docs-policy.1",
    allowedOperations: ["read", "window"],
    rowPolicyHash: GALLERY_ROW_POLICY_HASH,
    columnPolicyHash: GALLERY_COLUMN_POLICY_HASH,
    expiresAt: "2099-12-31T23:59:59.000Z",
  });
  const result = await gateway.resolve({
    request,
    declaration: publication.declaration,
    authority: {
      actorBindingHash: ACTOR_BINDING_HASH,
      tenantBindingHash: TENANT_BINDING_HASH,
    },
    activeRevisionId: revisionId,
    stateValues: {},
  });
  const resolutionIdentity = resourceResolutionIdentitySchema.parse({
    requestId: request.requestId,
    generation: 0,
    bindingId: request.bindingId,
    expectedRevisionId: request.expectedRevisionId,
    ...(request.expectedResourceVersionId === undefined
      ? {}
      : { expectedResourceVersionId: request.expectedResourceVersionId }),
  });
  const resources: Record<string, ResourceResolutionResult> = {
    [bindingId]: result,
  };
  const resourceResolutionIdentities: Record<string, ResourceResolutionIdentity> = {
    [bindingId]: resolutionIdentity,
  };
  const snapshot = surfaceSnapshotSchema.parse({
    revision,
    state: {},
    resources,
    resourceResolutionIdentities,
    actions: {},
    approvals: [],
  });
  const payload = {
    type: "snapshot-published" as const,
    snapshot,
    streamPolicy: {
      maxSequenceGap: 8,
      maxBufferedBytes: 256_000,
      ackEveryEvents: 64,
      backpressure: "publish-snapshot" as const,
      cursorExpiresAt: "2099-12-31T23:59:59Z",
    },
  };
  const event = surfaceEventEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId,
    streamId: `stream.recipe-${slug}`,
    epoch: 1,
    sequence: 1,
    eventId: `event.recipe-${slug}.1`,
    cursor: `cursor-gallery-${slug}-0001`,
    committedRevisionId: revisionId,
    audienceBindingHash: ACTOR_BINDING_HASH,
    contractSetHash: catalog.manifest.contractSetHash,
    correlationId: `correlation.recipe-${slug}`,
    payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload),
    payload,
  });

  return Object.freeze({
    descriptor,
    event,
    resourceSources: Object.freeze([Object.freeze({
      bindingId,
      componentType: "data.chart" as const,
      bindingPath: "/spec/data" as const,
      sourceValue,
      schema: schemaConstraint.resolvedSchema,
      declaration: publication.declaration,
    })]),
  });
}

function jsonToValueExpr(value: JsonValue): ValueExpr {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (value.kind === "resource-ref" || value.kind === "state-ref") {
      return valueExprSchema.parse(value);
    }
    return {
      kind: "object",
      entries: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, jsonToValueExpr(child)]),
      ),
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", items: value.map(jsonToValueExpr) };
  }
  return { kind: "literal", value };
}

function safeIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export async function expectedResourceContentHash(value: JsonValue): Promise<Sha256Hash> {
  return hashNamespacedCanonical("open-generative.resource-content", value);
}

export function proofDescriptorKey(descriptor: PreviewDescriptor): string {
  return descriptorKey(descriptor);
}
