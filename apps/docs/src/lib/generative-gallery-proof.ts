import {
  contentCalloutPropsSchema,
  contentEmptyPropsSchema,
  contentTextPropsSchema,
  controlFilterPropsSchema,
  dataMetricAuthoringPropsSchema,
  dataQueryDetailsPropsSchema,
  hashNamespacedCanonical,
  layoutGridPropsSchema,
  layoutSectionPropsSchema,
  layoutStackPropsSchema,
  officialChartSpecFixtures,
  officialComponentFixtures,
  officialComponentTypes,
  createOfficialCatalog,
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
  jsonSchemaSchema,
  jsonValueSchema,
  resourceBindingIdSchema,
  resourceResolutionIdentitySchema,
  resourceWindowRequestSchema,
  sha256HashSchema,
  stateIdSchema,
  surfaceEventEnvelopeSchema,
  surfaceSnapshotSchema,
  valueExprSchema,
  type JSONSchema,
  type JsonObject,
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
  type OfficialComponentType,
  type PreviewDescriptor,
} from "@/components/generative-gallery-model";

type PreviewNode = Readonly<{
  nodeId: string;
  componentType: OfficialComponentType;
  props: JsonObject;
  slots?: Readonly<Record<string, readonly string[]>>;
}>;

type PreviewState = Readonly<{
  stateId: string;
  schema: JSONSchema;
  value: JsonValue;
}>;

type PreviewResource = Readonly<{
  bindingId: string;
  componentType: OfficialComponentType;
  bindingPath: string;
  kind: "dataset" | "record";
  sourceValue: JsonValue;
  filterStateRef?: string;
}>;

type PreviewDefinition = Readonly<{
  key: string;
  rootNodeId: string;
  nodes: readonly PreviewNode[];
  states?: readonly PreviewState[];
  resources?: readonly PreviewResource[];
}>;

export type GalleryResourceSource = Readonly<{
  bindingId: string;
  componentType: OfficialComponentType;
  bindingPath: string;
  sourceValue: JsonValue;
  schema: JSONSchema;
  declaration: ResourceBindingDeclaration;
}>;

export type GenerativeGalleryProofCase = Readonly<{
  descriptor: PreviewDescriptor;
  event: SurfaceEventEnvelope;
  resourceSources: readonly GalleryResourceSource[];
}>;

export type GenerativeGalleryProofOptions = Readonly<{
  filterValue?: "north" | "south";
}>;

const FIXED_TIME = "2026-08-22T01:30:00.000Z";
const ACTOR_BINDING_HASH = sha256HashSchema.parse(`sha256:${"a".repeat(64)}`);
const TENANT_BINDING_HASH = sha256HashSchema.parse(`sha256:${"b".repeat(64)}`);
export const GALLERY_ROW_POLICY_HASH = sha256HashSchema.parse(`sha256:${"c".repeat(64)}`);
export const GALLERY_COLUMN_POLICY_HASH = sha256HashSchema.parse(`sha256:${"d".repeat(64)}`);
const CHART_DATASET_ID = "fixture.chart.dataset";
const CHART_SELECTION_STATE_ID = "fixture.chart.selection";
const CHART_RANGE_STATE_ID = "fixture.chart.range";
const CHART_LEGEND_STATE_ID = "fixture.chart.legend";
const FILTER_STATE_ID = "filter.region";
let catalogPromise: Promise<OfficialCatalogBundle> | undefined;

const chartDataset = jsonObjectSchema.parse({
  columns: [
    { columnId: "month", label: "Month", valueType: "date" },
    { columnId: "region", label: "Region", valueType: "string" },
    { columnId: "channel", label: "Channel", valueType: "string" },
    { columnId: "dimension", label: "Dimension", valueType: "string" },
    { columnId: "revenue", label: "Revenue", valueType: "number" },
    { columnId: "cost", label: "Cost", valueType: "number" },
  ],
  rows: [
    { month: "2026-01-01", region: "north", channel: "Direct", dimension: "Activation", revenue: 62, cost: 38 },
    { month: "2026-02-01", region: "south", channel: "Partner", dimension: "Retention", revenue: 74, cost: 44 },
    { month: "2026-03-01", region: "north", channel: "Organic", dimension: "Expansion", revenue: -18, cost: 31 },
    { month: "2026-04-01", region: "south", channel: "Direct", dimension: "Efficiency", revenue: 86, cost: 52 },
    { month: "2026-05-01", region: "north", channel: "Partner", dimension: "Quality", revenue: 71, cost: 41 },
    { month: "2026-06-01", region: "south", channel: "Organic", dimension: "Velocity", revenue: 93, cost: 58 },
  ],
  totalRows: 6,
  hasMore: false,
});

const tableDataset = jsonObjectSchema.parse({
  columns: [
    { columnId: "month", label: "Month", valueType: "date" },
    { columnId: "region", label: "Region", valueType: "string" },
    { columnId: "revenue", label: "Revenue", valueType: "number" },
  ],
  rows: [
    { month: "2026-01-01", region: "north", revenue: 62_400 },
    { month: "2026-02-01", region: "south", revenue: 74_100 },
    { month: "2026-03-01", region: "north", revenue: 66_000 },
    { month: "2026-04-01", region: "south", revenue: 86_200 },
  ],
  totalRows: 4,
  hasMore: false,
});

const chartStateSchemas = {
  selection: jsonSchemaSchema.parse({
    anyOf: [{ type: "null" }, { type: "string", maxLength: 1024 }, { type: "number" }],
  }),
  range: jsonSchemaSchema.parse({
    type: "object",
    properties: { start: { type: "number" }, end: { type: "number" } },
    required: ["start", "end"],
    additionalProperties: false,
  }),
  legend: jsonSchemaSchema.parse({
    type: "array",
    items: { type: "string", maxLength: 256 },
    maxItems: 12,
  }),
} as const;

export async function createGenerativeGalleryEvent(
  descriptor: PreviewDescriptor,
  options: GenerativeGalleryProofOptions = {},
): Promise<SurfaceEventEnvelope> {
  return (await createGenerativeGalleryProofCase(descriptor, options)).event;
}

export async function createGenerativeGalleryProofCase(
  descriptor: PreviewDescriptor,
  options: GenerativeGalleryProofOptions = {},
): Promise<GenerativeGalleryProofCase> {
  catalogPromise ??= createOfficialCatalog();
  const catalog = await catalogPromise;
  const filterValue = options.filterValue ?? "north";
  const definition = previewDefinition(descriptor, filterValue);
  const slug = definition.key.replace(/[^A-Za-z0-9._-]/g, "-");
  const surfaceSessionId = `surface.${slug}`;
  const revisionId = `revision.${definition.key}.1`;
  const stateEntries = await createStateEntries(definition);
  const stateValues = Object.fromEntries(
    stateEntries.map(entry => [entry.state.stateId, entry.state.value]),
  );

  let activeResource = "unassigned";
  const schemas = new ResourceSchemaRegistry();
  const gateway = new ResourceGateway({
    versions: new InMemoryResourceVersionStore(),
    grants: new InMemoryResourceGrantStore(),
    schemas,
    cursorCodec: new EncryptedResourceCursorCodec(new Uint8Array(32).fill(7)),
    projectionPolicy: {
      authorize: async ({ declaration, stateValues: authorizedState }) => {
        const stateId = declaration.selector.filterStateRef;
        if (stateId === undefined) return { allowed: true };
        const selected = authorizedState[stateId];
        return {
          allowed: true,
          filterRow: row => String(row.region ?? "").toLowerCase() === String(selected ?? "").toLowerCase(),
        };
      },
    },
    now: () => new Date(FIXED_TIME),
    versionIdFactory: () => `resource-version.${slug}.${activeResource}.1`,
    snapshotIdFactory: () => `resource-snapshot.${slug}.${activeResource}.1`,
    grantIdFactory: () => `resource-grant.${slug}.${activeResource}.1`,
  });

  const publications: Array<{
    resource: PreviewResource;
    schema: JSONSchema;
    declaration: ResourceBindingDeclaration;
  }> = [];
  for (const resource of definition.resources ?? []) {
    activeResource = safeIdentity(resource.bindingId);
    const policy = resourcePolicy(catalog, resource);
    const schemaConstraint = schemas.register({
      schemaId: `schema.tessera.${safeIdentity(resource.componentType)}.${safeIdentity(resource.bindingPath)}`,
      schemaRevision: 1,
      schema: policy.schema,
    });
    if (schemaConstraint.schemaHash !== policy.schemaHash) {
      throw new Error(`Resource schema hash drifted for ${resource.componentType}${resource.bindingPath}.`);
    }
    const publication = await gateway.publishPinned({
      resourceKey: `tessera.docs.${resource.bindingId}`,
      kind: resource.kind,
      schemaConstraint,
      selector: {
        windowLimit: resource.kind === "record" ? 1 : 10_000,
        ...(resource.filterStateRef === undefined
          ? {}
          : { filterStateRef: stateIdSchema.parse(resource.filterStateRef) }),
      },
      payload: resource.sourceValue,
      observedAt: FIXED_TIME,
    });
    publications.push({
      resource,
      schema: policy.schema,
      declaration: publication.declaration,
    });
  }

  const actions: Record<string, unknown> = {};
  const nodes = Object.fromEntries(definition.nodes.map(previewNode => {
    const contract = catalog.componentContracts.find(
      candidate => candidate.ref.componentType === previewNode.componentType,
    );
    if (!contract) throw new Error(`Official Contract missing for ${previewNode.componentType}.`);
    const events = Object.fromEntries(Object.keys(contract.events).flatMap(port => {
      const action = actionDefinition(catalog, definition, previewNode, port);
      if (action === undefined) return [];
      const actionId = `action.${previewNode.nodeId}.${port}`;
      actions[actionId] = action;
      return [[port, actionId]];
    }));
    return [previewNode.nodeId, {
      contract: contract.ref,
      props: Object.fromEntries(
        Object.entries(previewNode.props).map(([key, value]) => [key, jsonToValueExpr(value)]),
      ),
      slots: previewNode.slots ?? {},
      events,
      evidence: [],
    }];
  }));

  const capabilities = catalog.actionContracts
    .map(contract => contract.ref)
    .sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
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
    rootNodeId: definition.rootNodeId,
    nodes,
    stateDefinitions: Object.fromEntries(
      stateEntries.map(entry => [entry.state.stateId, entry.definition]),
    ),
    actions,
    resourceBindings: Object.fromEntries(
      publications.map(entry => [entry.resource.bindingId, entry.declaration]),
    ),
    evidenceBindings: {},
    claims: {},
    meta: {
      title: `Tessera Agent ${definition.key}`,
      description: "Trusted Generative UI documentation fixture.",
      locale: "en-US",
      tags: ["data-agent", "generative-ui", "tessera-agent"],
    },
  });
  const revision = committedRevisionSchema.parse({
    envelope: {
      documentId: `document.${definition.key}`,
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

  const resources: Record<string, ResourceResolutionResult> = {};
  const resourceResolutionIdentities: Record<string, ResourceResolutionIdentity> = {};
  for (const publication of publications) {
    activeResource = safeIdentity(publication.resource.bindingId);
    const request = resourceWindowRequestSchema.parse({
      requestId: `request.${slug}.${activeResource}.1`,
      bindingId: publication.resource.bindingId,
      surfaceSessionId,
      expectedRevisionId: revisionId,
      expectedResourceVersionId: publication.declaration.resolution.mode === "pinned"
        ? publication.declaration.resolution.versionId
        : undefined,
    });
    await gateway.createGrant({
      bindingId: resourceBindingIdSchema.parse(publication.resource.bindingId),
      surfaceSessionId,
      authority: {
        actorBindingHash: ACTOR_BINDING_HASH,
        tenantBindingHash: TENANT_BINDING_HASH,
      },
      authorityPolicyRevision: "tessera-docs-policy.1",
      allowedOperations: [
        "filter",
        "read",
        "window",
      ],
      rowPolicyHash: GALLERY_ROW_POLICY_HASH,
      columnPolicyHash: GALLERY_COLUMN_POLICY_HASH,
      expiresAt: "2099-12-31T23:59:59.000Z",
    });
    resources[publication.resource.bindingId] = await gateway.resolve({
      request,
      declaration: publication.declaration,
      authority: {
        actorBindingHash: ACTOR_BINDING_HASH,
        tenantBindingHash: TENANT_BINDING_HASH,
      },
      activeRevisionId: revisionId,
      stateValues,
    });
    resourceResolutionIdentities[publication.resource.bindingId] = resourceResolutionIdentitySchema.parse({
      requestId: request.requestId,
      generation: 0,
      bindingId: request.bindingId,
      expectedRevisionId: request.expectedRevisionId,
      ...(request.expectedResourceVersionId === undefined
        ? {}
        : { expectedResourceVersionId: request.expectedResourceVersionId }),
      ...(request.serverCursor === undefined ? {} : { serverCursor: request.serverCursor }),
    });
  }

  const snapshot = surfaceSnapshotSchema.parse({
    revision,
    state: Object.fromEntries(
      stateEntries.map(entry => [entry.state.stateId, entry.snapshot]),
    ),
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
    streamId: `stream.${slug}`,
    epoch: 1,
    sequence: 1,
    eventId: `event.${slug}.1`,
    cursor: `cursor-gallery-${slug}-0001`,
    committedRevisionId: revisionId,
    audienceBindingHash: ACTOR_BINDING_HASH,
    contractSetHash: catalog.manifest.contractSetHash,
    correlationId: `correlation.${slug}`,
    payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload),
    payload,
  });

  return Object.freeze({
    descriptor,
    event,
    resourceSources: Object.freeze(publications.map(publication => Object.freeze({
      bindingId: publication.resource.bindingId,
      componentType: publication.resource.componentType,
      bindingPath: publication.resource.bindingPath,
      sourceValue: publication.resource.sourceValue,
      schema: publication.schema,
      declaration: publication.declaration,
    }))),
  });
}

async function createStateEntries(definition: PreviewDefinition) {
  return Promise.all((definition.states ?? []).map(async state => {
    const schemaHash = await hashCanonical(HASH_DOMAINS.surfaceEventPayload, state.schema);
    return {
      state,
      definition: {
        schema: state.schema,
        schemaHash,
        initial: state.value,
        sensitivity: "public" as const,
        modelVisibility: "value" as const,
        retention: "retain" as const,
        scope: "surface" as const,
        persistence: "session" as const,
      },
      snapshot: {
        stateId: state.stateId,
        stateRevisionId: `state-revision.${state.stateId}.1`,
        schemaHash,
        scope: "surface" as const,
        value: state.value,
      },
    };
  }));
}

function resourcePolicy(catalog: OfficialCatalogBundle, resource: PreviewResource): {
  schema: JSONSchema;
  schemaHash: Sha256Hash;
} {
  const contract = catalog.componentContracts.find(
    candidate => candidate.ref.componentType === resource.componentType,
  );
  const policy = contract === undefined
    ? undefined
    : Object.entries(contract.authoringBindings).find(
        ([bindingPath]) => bindingPath === resource.bindingPath,
      )?.[1];
  const schemaConstraint = policy?.resource?.schemaConstraints[0];
  if (schemaConstraint === undefined) {
    throw new Error(`Missing resource policy for ${resource.componentType}${resource.bindingPath}.`);
  }
  return { schema: schemaConstraint.resolvedSchema, schemaHash: schemaConstraint.schemaHash };
}

function previewDefinition(
  descriptor: PreviewDescriptor,
  filterValue: "north" | "south",
): PreviewDefinition {
  switch (descriptor.kind) {
    case "analysis": return analysisDefinition();
    case "filter": return filterDefinition(filterValue);
    case "metrics": return metricsDefinition();
    case "component": return componentDefinition(officialComponentType(descriptor.value));
    case "recipe": return recipeDefinition(descriptor.value);
  }
}

function componentDefinition(componentType: OfficialComponentType): PreviewDefinition {
  if (componentType === "data.metric") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [metricNode("root", "Revenue", "metric.revenue.value", "metric.revenue.change")],
      resources: metricResources("metric.revenue", 128_400, 0.084),
    };
  }
  if (componentType === "data.table") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [node("root", componentType, "canonical")],
      resources: [tableResource()],
    };
  }
  if (componentType === "data.chart") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [node("root", componentType, "canonical")],
      states: chartStates(),
      resources: [chartResource()],
    };
  }
  if (componentType === "data.query-details") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [node("root", componentType, "canonical")],
      resources: [queryResource()],
    };
  }
  if (componentType === "control.filter") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [node("root", componentType, "canonical")],
      states: [filterState("north")],
    };
  }
  const root: PreviewNode = {
    nodeId: "root",
    componentType,
    props: fixtureProps(componentType),
  };
  const text: PreviewNode = {
    nodeId: "support-text",
    componentType: "content.text",
    props: jsonObjectSchema.parse(contentTextPropsSchema.parse({
      text: "Verified monthly performance from approved sources.",
      role: "body",
      tone: "muted",
    })),
  };
  const callout: PreviewNode = {
    nodeId: "support-callout",
    componentType: "content.callout",
    props: fixtureProps("content.callout"),
  };
  if (componentType === "layout.stack") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [{ ...root, slots: { children: [text.nodeId, callout.nodeId] } }, text, callout],
    };
  }
  if (componentType === "layout.grid") {
    const secondText: PreviewNode = {
      ...text,
      nodeId: "support-text-2",
      props: jsonObjectSchema.parse(contentTextPropsSchema.parse({
        text: "The grid preserves reading order at narrow placements.",
        role: "body",
        tone: "default",
      })),
    };
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [{ ...root, slots: { children: [callout.nodeId, secondText.nodeId] } }, callout, secondText],
    };
  }
  if (componentType === "layout.section") {
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [{ ...root, slots: { children: [text.nodeId] } }, text],
    };
  }
  if (componentType === "control.group") {
    const filter: PreviewNode = {
      nodeId: "support-filter",
      componentType: "control.filter",
      props: canonicalFilterProps(),
    };
    return {
      key: `component-${componentType}`,
      rootNodeId: "root",
      nodes: [{ ...root, slots: { controls: [filter.nodeId] } }, filter],
      states: [filterState("north")],
    };
  }
  return { key: `component-${componentType}`, rootNodeId: "root", nodes: [root] };
}

function analysisDefinition(): PreviewDefinition {
  return {
    key: "composition-analysis-overview",
    rootNodeId: "root",
    nodes: [
      node("root", "layout.stack", "resolved", { children: ["overview"] }),
      node("overview", "layout.section", "resolved", { children: ["metric", "chart", "table", "query"] }),
      metricNode("metric", "Revenue", "metric.revenue.value", "metric.revenue.change"),
      node("chart", "data.chart", "canonical"),
      node("table", "data.table", "canonical"),
      node("query", "data.query-details", "canonical"),
    ],
    resources: analysisResources(),
  };
}

function filterDefinition(filterValue: "north" | "south"): PreviewDefinition {
  const metricValue = filterValue === "north" ? 128_400 : 160_300;
  const metricChange = filterValue === "north" ? 0.124 : 0.087;
  return {
    key: `composition-filterable-breakdown-${filterValue}`,
    rootNodeId: "root",
    nodes: [
      node("root", "layout.stack", "resolved", { children: ["filters", "breakdown"] }),
      node("filters", "control.group", "resolved", { controls: ["region"] }),
      node("region", "control.filter", "canonical"),
      node("breakdown", "layout.grid", "resolved", { children: ["metric", "chart", "table"] }),
      metricNode("metric", "Revenue", "metric.revenue.value", "metric.revenue.change"),
      node("chart", "data.chart", "canonical"),
      node("table", "data.table", "canonical"),
    ],
    states: [filterState(filterValue)],
    resources: [
      ...metricResources("metric.revenue", metricValue, metricChange, FILTER_STATE_ID),
      chartResource(FILTER_STATE_ID),
      tableResource(FILTER_STATE_ID),
    ],
  };
}

function metricsDefinition(): PreviewDefinition {
  return {
    key: "composition-workspace-health",
    rootNodeId: "root",
    nodes: [
      node("root", "layout.stack", "resolved", { children: ["summary", "metrics"] }),
      {
        nodeId: "summary",
        componentType: "layout.section",
        props: jsonObjectSchema.parse(layoutSectionPropsSchema.parse({
          title: "Workspace health",
          description: "A compact operational snapshot from the current trusted revision.",
          level: 2,
        })),
        slots: { children: ["summary-text"] },
      },
      {
        nodeId: "summary-text",
        componentType: "content.text",
        props: jsonObjectSchema.parse(contentTextPropsSchema.parse({
          text: "All metrics share the same committed Surface revision.",
          role: "caption",
          tone: "muted",
        })),
      },
      {
        nodeId: "metrics",
        componentType: "layout.grid",
        props: jsonObjectSchema.parse(layoutGridPropsSchema.parse({ columns: 3, gap: "md", align: "stretch" })),
        slots: { children: ["revenue", "activation", "runs"] },
      },
      metricNode("revenue", "Monthly revenue", "metric.monthly-revenue.value", "metric.monthly-revenue.change", { kind: "currency", currency: "USD" }, "chart.1"),
      metricNode("activation", "Activation", "metric.activation.value", "metric.activation.change", { kind: "percent", maximumFractionDigits: 1 }, "semantic.positive"),
      metricNode("runs", "Agent runs", "metric.agent-runs.value", "metric.agent-runs.change", { kind: "number", notation: "compact" }, "semantic.warning"),
    ],
    resources: [
      ...metricResources("metric.monthly-revenue", 128_400, 0.124),
      ...metricResources("metric.activation", 0.682, 0.038),
      ...metricResources("metric.agent-runs", 18_420, -0.021),
    ],
  };
}

function recipeDefinition(recipeName: string): PreviewDefinition {
  const fixture = officialChartSpecFixtures.find(entry => entry.recipeName === recipeName);
  if (!fixture) throw new Error(`Unknown chart recipe: ${recipeName}`);
  return {
    key: `recipe-${recipeName}`,
    rootNodeId: "root",
    nodes: [{
      nodeId: "root",
      componentType: "data.chart",
      props: jsonObjectSchema.parse({ spec: fixture.spec }),
    }],
    states: chartStates(),
    resources: [chartResource()],
  };
}

function node(
  nodeId: string,
  componentType: OfficialComponentType,
  mode: "authoring" | "canonical" | "resolved",
  slots: Readonly<Record<string, readonly string[]>> = {},
): PreviewNode {
  return {
    nodeId,
    componentType,
    props: mode === "canonical" ? canonicalFixtureProps(componentType) : fixtureProps(componentType, mode),
    slots,
  };
}

function metricNode(
  nodeId: string,
  label: string,
  valueBindingId: string,
  comparisonBindingId: string,
  format: JsonObject = jsonObjectSchema.parse({ kind: "currency", currency: "USD" }),
  tone: "chart.1" | "semantic.positive" | "semantic.warning" = "chart.1",
): PreviewNode {
  return {
    nodeId,
    componentType: "data.metric",
    props: jsonObjectSchema.parse(dataMetricAuthoringPropsSchema.parse({
      label,
      value: { kind: "resource-ref", bindingId: valueBindingId },
      format,
      comparison: {
        value: { kind: "resource-ref", bindingId: comparisonBindingId },
        direction: "higher-is-better",
        format: { kind: "percent", maximumFractionDigits: 1 },
      },
      tone,
    })),
  };
}

function metricResources(
  prefix: string,
  value: number,
  change: number,
  filterStateRef?: string,
): readonly PreviewResource[] {
  return [
    {
      bindingId: `${prefix}.value`,
      componentType: "data.metric",
      bindingPath: "/value",
      kind: "record",
      sourceValue: value,
      filterStateRef,
    },
    {
      bindingId: `${prefix}.change`,
      componentType: "data.metric",
      bindingPath: "/comparison/value",
      kind: "record",
      sourceValue: change,
      filterStateRef,
    },
  ];
}

function analysisResources(): readonly PreviewResource[] {
  return [
    ...metricResources("metric.revenue", 128_400, 0.084),
    tableResource(),
    chartResource(),
    queryResource(),
  ];
}

function tableResource(filterStateRef?: string): PreviewResource {
  return {
    bindingId: "table.monthly",
    componentType: "data.table",
    bindingPath: "/data",
    kind: "dataset",
    sourceValue: tableDataset,
    filterStateRef,
  };
}

function chartResource(filterStateRef?: string): PreviewResource {
  return {
    bindingId: CHART_DATASET_ID,
    componentType: "data.chart",
    bindingPath: "/spec/data",
    kind: "dataset",
    sourceValue: chartDataset,
    filterStateRef,
  };
}

function queryResource(): PreviewResource {
  return {
    bindingId: "query.details",
    componentType: "data.query-details",
    bindingPath: "/details",
    kind: "record",
    sourceValue: jsonValueSchema.parse(fixtureProps("data.query-details").details),
  };
}

function filterState(value: "north" | "south"): PreviewState {
  return {
    stateId: FILTER_STATE_ID,
    schema: jsonSchemaSchema.parse({
      anyOf: [
        { type: "null" },
        { type: "string", maxLength: 16_384 },
        { type: "number" },
        { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] }, maxItems: 256 },
        {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
          additionalProperties: false,
        },
      ],
    }),
    value,
  };
}

function chartStates(): readonly PreviewState[] {
  return [
    { stateId: CHART_SELECTION_STATE_ID, schema: chartStateSchemas.selection, value: "revenue" },
    { stateId: CHART_RANGE_STATE_ID, schema: chartStateSchemas.range, value: { start: 0, end: 3 } },
    { stateId: CHART_LEGEND_STATE_ID, schema: chartStateSchemas.legend, value: ["revenue", "cost"] },
  ];
}

function fixtureProps(
  componentType: OfficialComponentType,
  mode: "authoring" | "resolved" = "resolved",
): JsonObject {
  const fixture = officialComponentFixtures.find(entry => entry.componentType === componentType);
  if (!fixture) throw new Error(`Missing official fixture for ${componentType}.`);
  return jsonObjectSchema.parse(mode === "authoring" ? fixture.authoringProps : fixture.resolvedProps);
}

function canonicalFixtureProps(componentType: OfficialComponentType): JsonObject {
  const resolved = fixtureProps(componentType, "resolved");
  const authoring = fixtureProps(componentType, "authoring");
  if (componentType === "data.table") {
    return jsonObjectSchema.parse({ ...resolved, data: authoring.data });
  }
  if (componentType === "data.query-details") {
    return jsonObjectSchema.parse({ ...resolved, details: authoring.details });
  }
  if (componentType === "control.filter") return canonicalFilterProps();
  if (componentType === "data.chart") return authoring;
  return resolved;
}

function canonicalFilterProps(): JsonObject {
  const resolved = fixtureProps("control.filter", "resolved");
  return jsonObjectSchema.parse({
    ...resolved,
    value: { kind: "state-ref", stateId: FILTER_STATE_ID },
  });
}

function officialComponentType(value: string): OfficialComponentType {
  if ((officialComponentTypes as readonly string[]).includes(value)) {
    return value as OfficialComponentType;
  }
  throw new Error(`Unknown official component type: ${value}`);
}

function actionDefinition(
  catalog: OfficialCatalogBundle,
  definition: PreviewDefinition,
  previewNode: PreviewNode,
  port: string,
): JsonObject | undefined {
  if (port === "export") {
    const bindingId = firstResourceBindingId(previewNode.props);
    if (bindingId === undefined) return undefined;
    return jsonObjectSchema.parse({
      kind: "host-intent",
      contract: catalog.actions.dataExport.ref,
      input: {
        bindingId: { kind: "resource-id-ref", bindingId },
        format: { kind: "event-ref", port, path: ["format"] },
      },
    });
  }
  if (port === "retry") {
    return jsonObjectSchema.parse({
      kind: "host-intent",
      contract: catalog.actions.surfaceRetry.ref,
      input: {
        target: { kind: "literal", value: "component" },
        targetId: { kind: "literal", value: previewNode.nodeId },
      },
    });
  }
  const stateIds = new Set((definition.states ?? []).map(state => state.stateId));
  if (port === "apply" && stateIds.size > 0) {
    return jsonObjectSchema.parse({
      kind: "host-intent",
      contract: catalog.actions.controlApply.ref,
      input: {
        groupId: { kind: "literal", value: previewNode.nodeId },
        stateIds: {
          kind: "array",
          items: [...stateIds].map(stateId => ({ kind: "state-id-ref", stateId })),
        },
      },
    });
  }
  if (port === "change" && stateIds.has(FILTER_STATE_ID)) {
    return jsonObjectSchema.parse({
      kind: "local-transition",
      transitions: [{
        type: "state.set",
        stateId: FILTER_STATE_ID,
        value: { kind: "event-ref", port, path: ["value"] },
      }],
    });
  }
  if (port === "reset" && stateIds.size > 0) {
    return jsonObjectSchema.parse({
      kind: "local-transition",
      transitions: [...stateIds].map(stateId => ({ type: "state.reset", stateId })),
    });
  }
  if (port === "select" && stateIds.has(CHART_SELECTION_STATE_ID)) {
    return jsonObjectSchema.parse({
      kind: "local-transition",
      transitions: [{
        type: "state.set",
        stateId: CHART_SELECTION_STATE_ID,
        value: { kind: "event-ref", port, path: ["series"] },
      }],
    });
  }
  if (port === "rangeChange" && stateIds.has(CHART_RANGE_STATE_ID)) {
    return jsonObjectSchema.parse({
      kind: "local-transition",
      transitions: [{
        type: "state.set",
        stateId: CHART_RANGE_STATE_ID,
        value: {
          kind: "object",
          entries: {
            start: { kind: "event-ref", port, path: ["start"] },
            end: { kind: "event-ref", port, path: ["end"] },
          },
        },
      }],
    });
  }
  return undefined;
}

function firstResourceBindingId(value: JsonValue): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const bindingId = firstResourceBindingId(child);
      if (bindingId !== undefined) return bindingId;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  if (value.kind === "resource-ref" && typeof value.bindingId === "string") {
    return value.bindingId;
  }
  for (const child of Object.values(value)) {
    const bindingId = firstResourceBindingId(child);
    if (bindingId !== undefined) return bindingId;
  }
  return undefined;
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
  if (Array.isArray(value)) return { kind: "array", items: value.map(jsonToValueExpr) };
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
