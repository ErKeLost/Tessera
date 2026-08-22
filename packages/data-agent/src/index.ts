import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  databaseCapabilitiesSchema,
  databaseExtensionInspectionSchema,
  databaseRlsPolicyInspectionSchema,
  databaseQueryResultSchema,
  findCatalogTable,
  type DatabaseDialect,
  type DatabaseExtensionInspectionInput,
  type DatabaseRlsPolicyInspectionInput,
  type DatabaseQueryResult,
} from "@open-tessera/database";
import {
  AnalysisCompilerError,
  bindAnalysisDraft as bindDraft,
  compileBoundAnalysis,
  compileTypedProbe,
  queryFingerprint,
} from "./compiler";
import { describeSemanticCatalog, sliceSemanticCatalog } from "./catalog-slice";
import { buildSemanticCatalog, type SemanticBindings } from "./semantic";
import {
  DATA_AGENT_DEFAULT_CATALOG_TTL_MS,
  DATA_AGENT_DEFAULT_MAX_ROWS,
  DATA_AGENT_DEFAULT_TIMEOUT_MS,
  DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES,
  DATA_AGENT_RELATION_PREVIEW_LIMIT,
  discoveryProbeRequestSchema,
  planningCatalogDescriptionInputSchema,
  planningCapabilityCompositionInputSchema,
  planningCapabilitySchema,
  planningProbeInputSchema,
  relationPlanningCatalogInputSchema,
  relationPreviewRequestSchema,
  type AnalysisDraft,
  type AnalysisPredicate,
  type AnalysisSpec,
  type CompiledQuery,
  type DataAgent,
  type DataAgentCatalogInput,
  type DataAgentCapabilitiesSnapshot,
  type DataAgentCatalogSnapshot,
  type DataAgentErrorCode,
  type DataAgentExecution,
  type DataAgentOptions,
  type DataAgentPlanningCatalogDescription,
  type DataAgentPlanningCatalogDescriptionInput,
  type DataAgentPlanningCapabilityCompositionInput,
  type DataAgentPlanningCatalogInput,
  type DataAgentPlanningCatalogSnapshot,
  type DataAgentPlanningProbeInput,
  type DataAgentPlanningProbeResult,
  type DataAgentReadSqlInput,
  type DataAgentRelationPlanningCatalogInput,
  type DataAgentRelationPlanningCatalogSnapshot,
  type DataAgentRelationPreview,
  type DataAgentRunInput,
  type DataAgentRunResult,
  type DataAgentStage,
  type DataAgentStageEvent,
  type EntityId,
  type FieldId,
  type RelationPreviewRequest,
  type PlanningCapability,
  type DiscoveryProbeRequest,
  type RelationshipId,
  type SemanticCatalog,
  type TypedProbeRequest,
} from "./contracts";

const PLANNING_CAPABILITY_TTL_MS = 5 * 60 * 1_000;
const COMPOSED_PLANNING_CAPABILITY_TTL_MS = 60 * 1_000;
const MAX_PLANNING_CAPABILITIES = 256;

type PlanningCapabilityRecord = Readonly<{
  connectorId: string;
  catalogFingerprint: string;
  semanticCatalogFingerprint: string;
  entityIds: ReadonlySet<string>;
  fieldIds: ReadonlySet<string>;
  metricIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
  expiresAt: number;
}>;

export {
  DATA_AGENT_DEFAULT_CATALOG_TTL_MS,
  DATA_AGENT_DEFAULT_MAX_ROWS,
  DATA_AGENT_DEFAULT_TIMEOUT_MS,
  DATA_AGENT_DESCRIBE_MAX_ENTITIES,
  DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY,
  DATA_AGENT_DESCRIBE_MAX_METRICS_PER_ENTITY,
  DATA_AGENT_DESCRIBE_MAX_RELATIONSHIPS,
  DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES,
  DATA_AGENT_RELATION_PREVIEW_LIMIT,
  DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS,
  DATA_AGENT_VERSION,
  aggregateAnalysisDraftSchema,
  aggregateSchema,
  analysisDraftSchema,
  analysisPredicateSchema,
  dimensionSchema,
  discoveryProbeRequestSchema,
  entityIdSchema,
  fieldIdSchema,
  measureSchema,
  metricIdSchema,
  planningCapabilityCompositionInputSchema,
  planningCapabilitySchema,
  planningCatalogDescriptionInputSchema,
  planningProbeInputSchema,
  relationPlanningCatalogInputSchema,
  recordsAnalysisDraftSchema,
  relationshipIdSchema,
  relationPreviewRequestSchema,
  semanticCatalogDefinitionSchema,
  semanticCatalogSchema,
} from "./contracts";
// Stable physical-to-semantic id helpers are used by server-side adapters
// when projecting connector metadata into a model-safe schema view.
export { entityIdFor, fieldIdFor } from "./semantic";
export type {
  AnalysisDraft,
  AnalysisPredicate,
  CatalogSnapshotRef,
  CompiledResultColumn,
  DataAgent,
  DataAgentCatalogInput,
  DataAgentCapabilitiesSnapshot,
  DataAgentCatalogSnapshot,
  DataAgentErrorCode,
  DataAgentExecution,
  DataAgentOptions,
  DataAgentPlanningCatalogDescription,
  DataAgentPlanningCatalogDescriptionInput,
  DataAgentPlanningCapabilityCompositionInput,
  DataAgentPlanningCatalogInput,
  DataAgentPlanningCatalogSnapshot,
  DataAgentPlanningProbeInput,
  DataAgentPlanningProbeResult,
  DataAgentReadSqlInput,
  DataAgentRelationPlanningCatalogInput,
  DataAgentRelationPlanningCatalogSnapshot,
  DataAgentRelationPreview,
  DataAgentRunInput,
  DataAgentRunResult,
  DataAgentStage,
  DataAgentStageEvent,
  DataAgentStageStatus,
  Dimension,
  DiscoveryProbeRequest,
  EntityId,
  FieldId,
  Measure,
  MetricId,
  PlanningCapability,
  RecordOrder,
  RecordProjection,
  RelationshipId,
  RelationPreviewRequest,
  SemanticCatalog,
  SemanticCatalogDefinition,
  SemanticCatalogRef,
} from "./contracts";

export class DataAgentError extends Error {
  readonly code: DataAgentErrorCode;
  readonly reasonCode?: string;

  constructor(code: DataAgentErrorCode, message = "The structured data analysis could not be completed.", options?: { cause?: unknown; reasonCode?: string }) {
    super(message, options);
    this.name = "DataAgentError";
    this.code = code;
    this.reasonCode = options?.reasonCode;
  }
}

/**
 * The vNext server runtime accepts structured drafts only. SQL is created by
 * compiler.ts and never appears in a model input or public tool contract.
 */
export function createDataAgent(options: DataAgentOptions): DataAgent {
  const now = options.now ?? (() => new Date());
  const requestIdFactory = options.requestIdFactory ?? defaultRequestId;
  const ttlMs = boundedInteger(options.catalog?.ttlMs, DATA_AGENT_DEFAULT_CATALOG_TTL_MS, 0, 24 * 60 * 60 * 1_000);
  const maxRows = boundedInteger(options.query?.maxRows, DATA_AGENT_DEFAULT_MAX_ROWS, 1, 10_000);
  const timeoutMs = boundedInteger(options.query?.timeoutMs, DATA_AGENT_DEFAULT_TIMEOUT_MS, 250, 120_000);
  type RuntimeCatalogSnapshot = Readonly<{
    snapshot: DataAgentCatalogSnapshot;
    bindings: SemanticBindings;
  }>;
  let cached: { value: RuntimeCatalogSnapshot; expiresAt: number } | undefined;
  let load: Promise<RuntimeCatalogSnapshot> | undefined;
  const capabilitySecret = randomBytes(32);
  const planningCapabilities = new Map<string, PlanningCapabilityRecord>();
  let cachedCapabilities: { value: DataAgentCapabilitiesSnapshot; expiresAt: number } | undefined;
  let capabilityLoad: Promise<DataAgentCapabilitiesSnapshot> | undefined;

  async function inspectCapabilities(signal?: AbortSignal): Promise<DataAgentCapabilitiesSnapshot> {
    throwIfAborted(signal);
    const cachedValue = cachedCapabilities;
    if (cachedValue && cachedValue.expiresAt > now().getTime()) {
      return { capabilities: cachedValue.value.capabilities, cacheStatus: "hit" };
    }
    const task = capabilityLoad ?? (capabilityLoad = Promise.resolve().then(async () => {
      if (options.connector.inspectCapabilities) {
        const capabilities = await options.connector.inspectCapabilities();
        return { capabilities: databaseCapabilitiesSchema.parse(capabilities), cacheStatus: "loaded" as const };
      }
      return {
        capabilities: databaseCapabilitiesSchema.parse({
          kind: "database-capabilities",
          connectorId: options.connector.id,
          dialect: options.connector.dialect,
          availability: "unavailable",
          components: [],
          truncated: false,
          warnings: ["This connector does not expose runtime capability inspection."],
        }),
        cacheStatus: "unavailable" as const,
      };
    }).then((value) => {
      cachedCapabilities = { value, expiresAt: now().getTime() + Math.min(ttlMs, 60_000) };
      capabilityLoad = undefined;
      return value;
    }, (error) => {
      capabilityLoad = undefined;
      throw toDataAgentError(error);
    }));
    return waitForAbort(task, signal);
  }

  async function inspectExtensions(
    input: DatabaseExtensionInspectionInput = {},
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    if (!options.connector.inspectExtensions) {
      return databaseExtensionInspectionSchema.parse({
        kind: "database-extensions",
        connectorId: options.connector.id,
        dialect: options.connector.dialect,
        extensions: [],
        truncated: false,
        warnings: ["This connector does not expose database extension inspection."],
      });
    }
    return databaseExtensionInspectionSchema.parse(await options.connector.inspectExtensions(input, signal));
  }

  async function inspectRlsPolicies(
    input: DatabaseRlsPolicyInspectionInput = {},
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    if (!options.connector.inspectRlsPolicies) {
      return databaseRlsPolicyInspectionSchema.parse({
        kind: "database-rls-policies",
        connectorId: options.connector.id,
        dialect: options.connector.dialect,
        relations: [],
        policyCount: 0,
        truncated: false,
        warnings: ["This connector does not expose row-level security inspection."],
      });
    }
    return databaseRlsPolicyInspectionSchema.parse(await options.connector.inspectRlsPolicies(input, signal));
  }

  async function inspectCatalog(
    input: DataAgentCatalogInput = {},
    signal?: AbortSignal,
  ): Promise<DataAgentCatalogSnapshot> {
    const loaded = await getRuntimeCatalog(input, signal);
    return { ...loaded.value.snapshot, cacheStatus: loaded.cacheStatus };
  }

  async function inspectPlanningCatalog(
    input: DataAgentPlanningCatalogInput = {},
    signal?: AbortSignal,
  ): Promise<DataAgentPlanningCatalogSnapshot> {
    const loaded = await getRuntimeCatalog({ refresh: input.refresh }, signal);
    const semantic = sliceSemanticCatalog(loaded.value.snapshot.semanticCatalog, { query: input.query });
    return {
      ref: loaded.value.snapshot.ref,
      capability: issuePlanningCapability(loaded.value.snapshot, semantic.catalog),
      semanticCatalog: semantic.catalog,
      cacheStatus: loaded.cacheStatus,
      entityCount: loaded.value.snapshot.semanticCatalog.entities.length,
      truncated: semantic.truncated,
      omitted: semantic.omitted,
    };
  }

  async function inspectRelationPlanningCatalog(
    input: DataAgentRelationPlanningCatalogInput,
    signal?: AbortSignal,
  ): Promise<DataAgentRelationPlanningCatalogSnapshot> {
    const parsed = relationPlanningCatalogInputSchema.safeParse(input);
    if (!parsed.success) throw unavailableRelationContext();

    // The host supplies a physical relation only inside server code. Refresh
    // before binding so a tab cannot turn a stale page fingerprint into a
    // planning scope for a changed live catalog.
    const loaded = await getRuntimeCatalog({ refresh: true }, signal);
    const snapshot = loaded.value.snapshot;
    if (parsed.data.catalogFingerprint !== snapshot.ref.catalogFingerprint) {
      throw unavailableRelationContext();
    }
    const relation = findCatalogTable(snapshot.catalog, parsed.data.schema, parsed.data.table);
    if (!relation) throw unavailableRelationContext();

    const entity = Array.from(loaded.value.bindings.entities.values()).find((candidate) => (
      candidate.source === relation
    ));
    if (!entity) throw unavailableRelationContext();

    const semantic = describeSemanticCatalog(snapshot.semanticCatalog, [entity.id]);
    if (semantic.catalog.entities.length !== 1) throw unavailableRelationContext();
    return {
      ref: snapshot.ref,
      capability: issuePlanningCapability(snapshot, semantic.catalog),
      semanticCatalog: semantic.catalog,
      cacheStatus: loaded.cacheStatus,
      truncated: semantic.truncated,
      omitted: semantic.omitted,
    };
  }

  async function describePlanningCatalog(
    input: DataAgentPlanningCatalogDescriptionInput,
    signal?: AbortSignal,
  ): Promise<DataAgentPlanningCatalogDescription> {
    const parsed = planningCatalogDescriptionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new DataAgentError("invalid_analysis_spec", "Inspect the current data catalog before describing an entity.");
    }
    const loaded = await getRuntimeCatalog({}, signal);
    const snapshot = loaded.value.snapshot;
    const capability = resolvePlanningCapability(parsed.data.capability, snapshot);
    for (const entityId of parsed.data.entityIds) {
      if (!capability.entityIds.has(entityId)) {
        throw new DataAgentError("invalid_analysis_spec", "The selected entity is outside the current catalog scope.");
      }
    }
    const semantic = describeSemanticCatalog(snapshot.semanticCatalog, parsed.data.entityIds);
    if (semantic.catalog.entities.length !== parsed.data.entityIds.length) {
      throw new DataAgentError("invalid_semantic_catalog", "The selected entity is no longer available in the governed catalog.");
    }
    return {
      ref: snapshot.ref,
      capability: issuePlanningCapability(snapshot, semantic.catalog),
      semanticCatalog: semantic.catalog,
      cacheStatus: loaded.cacheStatus,
      truncated: semantic.truncated,
      omitted: semantic.omitted,
    };
  }

  async function probePlanningData(
    input: DataAgentPlanningProbeInput,
    signal?: AbortSignal,
  ): Promise<DataAgentPlanningProbeResult> {
    const parsed = planningProbeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new DataAgentError("invalid_analysis_spec", "The governed discovery probe is not valid.");
    }
    const loaded = await getRuntimeCatalog({}, signal);
    const snapshot = loaded.value.snapshot;
    const capability = resolvePlanningCapability(parsed.data.capability, snapshot);
    const spec = bindDiscoveryProbeSpec(parsed.data.probe, snapshot, loaded.value.bindings, capability);
    const probe = typedDiscoveryProbe(parsed.data.probe, spec.specId);
    let compiled: CompiledQuery;
    try {
      compiled = compileTypedProbe({
        catalog: snapshot.catalog,
        semanticCatalog: snapshot.semanticCatalog,
        spec,
        probe,
      });
    } catch (error) {
      throw toDataAgentError(error);
    }
    const result = await runConnectorQuery(
      compiled,
      "Tessera governed discovery probe",
      signal,
      parsed.data.probe.kind === "value-domain" ? DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES : 1,
    );
    return {
      catalog: snapshot.ref,
      semanticCatalog: snapshot.semanticCatalog.ref,
      probe: parsed.data.probe,
      columns: compiled.resultColumns,
      execution: {
        specId: spec.specId,
        probeId: probe.id,
        queryFingerprint: queryFingerprint(compiled),
        result,
        resultScope: result.truncated ? "returned-rows" : "complete-result",
      },
    };
  }

  function issuePlanningCapability(
    snapshot: DataAgentCatalogSnapshot,
    semanticCatalog: SemanticCatalog,
  ): PlanningCapability {
    return issuePlanningCapabilityRecord({
      connectorId: snapshot.ref.connectorId,
      catalogFingerprint: snapshot.ref.catalogFingerprint,
      semanticCatalogFingerprint: snapshot.semanticCatalog.ref.fingerprint,
      entityIds: new Set(semanticCatalog.entities.map((entity) => entity.id)),
      fieldIds: new Set(semanticCatalog.entities.flatMap((entity) => entity.fields.map((field) => field.id))),
      metricIds: new Set(semanticCatalog.entities.flatMap((entity) => entity.metrics.map((metric) => metric.id))),
      relationshipIds: new Set(semanticCatalog.relationships.map((relationship) => relationship.id)),
      expiresAt: now().getTime() + PLANNING_CAPABILITY_TTL_MS,
    });
  }

  function issuePlanningCapabilityRecord(record: PlanningCapabilityRecord): PlanningCapability {
    prunePlanningCapabilities();
    const id = `cap_${randomBytes(24).toString("base64url")}`;
    planningCapabilities.set(id, record);
    return { token: `${id}.${signCapability(id)}` };
  }

  async function composePlanningCapabilities(
    input: DataAgentPlanningCapabilityCompositionInput,
    signal?: AbortSignal,
  ): Promise<PlanningCapability> {
    const parsed = planningCapabilityCompositionInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new DataAgentError("catalog_stale", "Inspect compatible planning catalogs before composing their scope.");
    }
    const runtime = await getRuntimeCatalog({}, signal);
    const snapshot = runtime.value.snapshot;
    // Resolve every source against the same live snapshot. This prevents a
    // composed token from crossing connectors, catalog versions, or instances.
    const capabilities = parsed.data.capabilities.map((capability) => resolvePlanningCapability(capability, snapshot));
    const currentTime = now().getTime();
    const expiresAt = Math.min(
      currentTime + COMPOSED_PLANNING_CAPABILITY_TTL_MS,
      ...capabilities.map((capability) => capability.expiresAt),
    );
    if (expiresAt <= currentTime) {
      throw new DataAgentError("catalog_stale", "Inspect compatible planning catalogs before composing their scope.");
    }
    return issuePlanningCapabilityRecord({
      connectorId: snapshot.ref.connectorId,
      catalogFingerprint: snapshot.ref.catalogFingerprint,
      semanticCatalogFingerprint: snapshot.semanticCatalog.ref.fingerprint,
      entityIds: unionPlanningScope(capabilities, "entityIds"),
      fieldIds: unionPlanningScope(capabilities, "fieldIds"),
      metricIds: unionPlanningScope(capabilities, "metricIds"),
      relationshipIds: unionPlanningScope(capabilities, "relationshipIds"),
      expiresAt,
    });
  }

  function resolvePlanningCapability(
    value: unknown,
    snapshot: DataAgentCatalogSnapshot,
  ): PlanningCapabilityRecord {
    const parsed = planningCapabilitySchema.safeParse(value);
    if (!parsed.success) {
      throw new DataAgentError("catalog_stale", "Inspect the current data catalog before running an analysis.");
    }
    const [id, signature, extra] = parsed.data.token.split(".");
    if (!id || !signature || extra !== undefined || !safeTokenEquals(signature, signCapability(id))) {
      throw new DataAgentError("catalog_stale", "Inspect the current data catalog before running an analysis.");
    }
    const capability = planningCapabilities.get(id);
    if (!capability || capability.expiresAt <= now().getTime()) {
      planningCapabilities.delete(id);
      throw new DataAgentError("catalog_stale", "Inspect the current data catalog before running an analysis.");
    }
    if (capability.connectorId !== snapshot.ref.connectorId
      || capability.catalogFingerprint !== snapshot.ref.catalogFingerprint
      || capability.semanticCatalogFingerprint !== snapshot.semanticCatalog.ref.fingerprint) {
      throw new DataAgentError("catalog_stale", "The planning catalog is no longer current.");
    }
    return capability;
  }

  function assertSpecWithinPlanningCapability(
    spec: AnalysisSpec,
    capability: PlanningCapabilityRecord,
  ): void {
    const requireAllowed = (ids: ReadonlySet<string>, id: string, kind: string) => {
      if (!ids.has(id)) throw new DataAgentError("invalid_analysis_spec", `The selected ${kind} is outside the current catalog scope.`);
    };
    const requireField = (id: string) => requireAllowed(capability.fieldIds, id, "field");

    requireAllowed(capability.entityIds, spec.primaryEntityId, "entity");
    spec.relationshipIds.forEach((id) => requireAllowed(capability.relationshipIds, id, "relationship"));
    if (spec.mode === "records") {
      spec.fields.forEach((field) => requireField(field.fieldId));
      spec.orderBy.forEach((order) => requireField(order.fieldId));
    } else {
      spec.dimensions.forEach((dimension) => requireField(dimension.fieldId));
      spec.measures.forEach((measure) => {
        if (measure.kind === "metric") requireAllowed(capability.metricIds, measure.metricId, "metric");
        else if (measure.fieldId !== undefined) requireField(measure.fieldId);
      });
    }
    if (spec.filter !== undefined) assertPredicateWithinPlanningCapability(spec.filter, requireField);
  }

  function bindDiscoveryProbeSpec(
    probe: DiscoveryProbeRequest,
    snapshot: DataAgentCatalogSnapshot,
    bindings: SemanticBindings,
    capability: PlanningCapabilityRecord,
  ): AnalysisSpec {
    const requireAllowedField = (fieldId: FieldId) => {
      if (!capability.fieldIds.has(fieldId)) {
        throw new DataAgentError("invalid_analysis_spec", "The selected field is outside the current catalog scope.");
      }
      const field = bindings.fields.get(fieldId);
      if (!field) throw new DataAgentError("invalid_semantic_catalog", "The selected field is no longer available in the governed catalog.");
      return field;
    };
    let primaryEntityId: EntityId;
    let relationshipIds: RelationshipId[] = [];
    if (probe.kind === "join-coverage") {
      if (!capability.relationshipIds.has(probe.relationshipId)) {
        throw new DataAgentError("invalid_analysis_spec", "The selected relationship is outside the current catalog scope.");
      }
      const relationship = bindings.relationships.get(probe.relationshipId);
      if (!relationship) throw new DataAgentError("invalid_semantic_catalog", "The selected relationship is no longer available in the governed catalog.");
      if (!capability.entityIds.has(relationship.fromEntityId) || !capability.entityIds.has(relationship.toEntityId)) {
        throw new DataAgentError("invalid_analysis_spec", "The selected relationship is outside the current catalog scope.");
      }
      primaryEntityId = relationship.fromEntityId;
      relationshipIds = [relationship.id];
    } else {
      const fieldIds = probe.kind === "field-profile" ? probe.fieldIds : [probe.fieldId];
      const fields = fieldIds.map(requireAllowedField);
      const owner = fields[0]?.entityId;
      if (!owner || fields.some((field) => field.entityId !== owner)) {
        throw new DataAgentError("invalid_analysis_spec", "A discovery field probe must target fields from one entity.");
      }
      if (!capability.entityIds.has(owner)) {
        throw new DataAgentError("invalid_analysis_spec", "The selected entity is outside the current catalog scope.");
      }
      primaryEntityId = owner;
    }
    try {
      const draft: AnalysisDraft = {
        version: "2",
        mode: "aggregate",
        primaryEntityId,
        relationshipIds,
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_probe_count" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      };
      const spec = bindDraft({
        catalog: snapshot.catalog,
        semanticCatalog: snapshot.semanticCatalog,
        now: now(),
        draft,
      });
      assertSpecWithinPlanningCapability(spec, capability);
      return spec;
    } catch (error) {
      throw toDataAgentError(error);
    }
  }

  function signCapability(id: string): string {
    return createHmac("sha256", capabilitySecret).update(id).digest("base64url");
  }

  function prunePlanningCapabilities(): void {
    const currentTime = now().getTime();
    for (const [id, capability] of planningCapabilities) {
      if (capability.expiresAt <= currentTime) planningCapabilities.delete(id);
    }
    while (planningCapabilities.size >= MAX_PLANNING_CAPABILITIES) {
      const id = planningCapabilities.keys().next().value;
      if (id === undefined) break;
      planningCapabilities.delete(id);
    }
  }

  async function getRuntimeCatalog(
    input: DataAgentCatalogInput = {},
    signal?: AbortSignal,
  ): Promise<Readonly<{ value: RuntimeCatalogSnapshot; cacheStatus: "hit" | "loaded" }>> {
    throwIfAborted(signal);
    const cachedValue = cached;
    if (!input.refresh && cachedValue && cachedValue.expiresAt > now().getTime()) {
      return { value: cachedValue.value, cacheStatus: "hit" };
    }
    const task = load ?? startCatalogLoad();
    return { value: await waitForAbort(task, signal), cacheStatus: "loaded" };
  }

  function startCatalogLoad(): Promise<RuntimeCatalogSnapshot> {
    // The catalog is shared server state. Its lifecycle must not inherit a
    // single HTTP request's cancellation signal, otherwise a cancelled tab
    // would both poison the cache and trigger duplicate cold introspections.
    const task = Promise.resolve().then(async () => {
      try {
        const catalog = await options.connector.introspect(options.catalog?.introspection);
        // Connector ids identify catalog snapshots, not necessarily the host's
        // connector instance. The dialect, however, must match the executor or
        // generated quoting and binding semantics would be invalid.
        if (catalog.dialect !== options.connector.dialect) {
          throw new DataAgentError("invalid_semantic_catalog", "The connector returned a catalog for a different dialect.");
        }
        const semantic = buildSemanticCatalog(catalog, options.semantic);
        const snapshot: DataAgentCatalogSnapshot = {
          catalog,
          ref: {
            connectorId: catalog.connectorId,
            catalogFingerprint: catalog.fingerprint,
            capturedAt: now().toISOString(),
          },
          semanticCatalog: semantic.catalog,
          cacheStatus: "loaded",
        };
        return { snapshot, bindings: semantic.bindings } satisfies RuntimeCatalogSnapshot;
      } catch (error) {
        throw toDataAgentError(error);
      }
    });
    load = task;
    void task.then(
      (value) => {
        cached = { value, expiresAt: now().getTime() + ttlMs };
        if (load === task) load = undefined;
      },
      () => {
        if (load === task) load = undefined;
      },
    );
    return task;
  }

  async function previewRelation(
    input: RelationPreviewRequest,
    signal?: AbortSignal,
  ): Promise<DataAgentRelationPreview> {
    const parsed = relationPreviewRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DataAgentError("invalid_relation_preview", "The relation preview request is not valid.");
    }
    // Preview is a physical, server-only operation. It resolves names only
    // against the current server catalog cache. A host can explicitly refresh
    // that cache before a preview, but opening a table must not trigger an
    // expensive full catalog scan on every click.
    const runtime = await getRuntimeCatalog({ refresh: parsed.data.refresh }, signal);
    const snapshot = runtime.value.snapshot;
    const relation = findCatalogTable(snapshot.catalog, parsed.data.schema, parsed.data.table);
    if (!relation) {
      throw new DataAgentError("invalid_relation_preview", "The requested relation is not readable through this connector.");
    }
    const columnsByName = new Map(relation.columns.map((column) => [column.name, column]));
    const columns = parsed.data.columns.map((name) => columnsByName.get(name));
    if (columns.some((column) => column === undefined)) {
      throw new DataAgentError("invalid_relation_preview", "The requested preview column is not readable through this connector.");
    }
    const dialect = snapshot.catalog.dialect;
    const compiled = dialect === "mongodb"
      ? {
        kind: "mongodb" as const,
        database: relation.schema,
        collection: relation.name,
        pipeline: [{
          $project: {
            _id: 0,
            ...Object.fromEntries(columns.map((column) => [column!.name, `$${column!.name}`])),
          },
        }, { $limit: DATA_AGENT_RELATION_PREVIEW_LIMIT }],
        resultColumns: columns.map((column) => ({ outputId: column!.name, label: column!.name, type: "unknown" as const })),
      }
      : {
        sql: [
          `SELECT ${columns.map((column) => quotePreviewIdentifier(dialect, column!.name)).join(", ")}`,
          `FROM ${quotePreviewIdentifier(dialect, relation.schema)}.${quotePreviewIdentifier(dialect, relation.name)}`,
          `LIMIT ${DATA_AGENT_RELATION_PREVIEW_LIMIT}`,
        ].join("\n"),
        parameters: [],
      };
    const result = await runConnectorQuery(
      compiled,
      "Tessera relation preview",
      signal,
      DATA_AGENT_RELATION_PREVIEW_LIMIT,
    );
    return {
      catalog: snapshot.ref,
      relation: { schema: relation.schema, table: relation.name },
      columns: columns.map((column) => column!.name),
      limit: DATA_AGENT_RELATION_PREVIEW_LIMIT,
      result,
    };
  }

  async function executeCompiled(compiled: CompiledQuery, signal?: AbortSignal): Promise<DataAgentExecution> {
    const result = await runConnectorQuery(compiled, "Tessera structured analysis", signal);
    return {
      queryFingerprint: queryFingerprint(compiled),
      result,
      resultScope: result.truncated ? "returned-rows" : "complete-result",
    };
  }

  async function executeReadSql(input: DataAgentReadSqlInput, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    if (options.connector.dialect === "mongodb") {
      throw new DataAgentError("query_failed", "This connection does not support SQL queries.");
    }
    return runConnectorQuery({
      sql: input.sql,
      parameters: [...(input.parameters ?? [])],
    }, input.purpose ?? "Tessera SQL query", signal);
  }

  async function runConnectorQuery(
    compiled:
      | Readonly<{ sql: string; parameters: readonly (string | number | boolean)[]; resultColumns?: readonly CompiledQuery["resultColumns"][number][] }>
      | Readonly<{ kind: "mongodb"; database: string; collection: string; pipeline: readonly Record<string, unknown>[]; resultColumns?: readonly CompiledQuery["resultColumns"][number][] }>,
    purpose: string,
    signal?: AbortSignal,
    rowLimit = maxRows,
  ) {
    try {
      // Connectors remain the SQL security boundary: every request is parsed,
      // restricted to one read-only statement, bounded, and timed out there.
      const request = "sql" in compiled
        ? {
          sql: compiled.sql,
          parameters: [...compiled.parameters],
          purpose,
          maxRows: rowLimit,
          timeoutMs,
        }
        : {
          kind: "mongodb" as const,
          database: compiled.database,
          collection: compiled.collection,
          pipeline: compiled.pipeline.map((stage) => structuredClone(stage)),
          ...(compiled.resultColumns === undefined ? {} : { columns: compiled.resultColumns.map(({ outputId }) => outputId) }),
          purpose,
          maxRows: rowLimit,
          timeoutMs,
        };
      const result = await options.connector.query(request, signal);
      const parsed = databaseQueryResultSchema.safeParse(result);
      if (!parsed.success) throw new DataAgentError("query_failed");
      // Connectors may fetch one sentinel row to compute `truncated` for bounded
      // previews. Reject anything beyond that contract, but allow the sentinel.
      if (parsed.data.rows.length > rowLimit + 1
        || parsed.data.rowCount < parsed.data.rows.length
        || (!parsed.data.truncated && parsed.data.rowCount !== parsed.data.rows.length)
        || (compiled.resultColumns !== undefined && parsed.data.columns.length !== compiled.resultColumns.length)) {
        throw new DataAgentError("query_failed", "The connector returned inconsistent analysis results.");
      }
      return parsed.data;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DataAgentError) throw error;
      const diagnostic = safeQueryDiagnostic(error);
      if (diagnostic !== undefined) {
        throw new DataAgentError("query_policy_rejected", diagnostic.message, {
          cause: error,
          reasonCode: diagnostic.code,
        });
      }
      throw new DataAgentError("query_failed", undefined, { cause: error });
    }
  }

  async function runAnalysis(input: DataAgentRunInput): Promise<DataAgentRunResult> {
    const requestId = input.requestId ?? requestIdFactory();
    const events: DataAgentStageEvent[] = [];
    const stage = async <T>(name: DataAgentStage, work: () => Promise<T>): Promise<T> => {
      await emitStage(input, events, requestId, name, "started", now());
      const started = now().getTime();
      try {
        const value = await work();
        await emitStage(input, events, requestId, name, "completed", now(), now().getTime() - started);
        return value;
      } catch (error) {
        await emitStage(input, events, requestId, name, "failed", now(), now().getTime() - started);
        throw error;
      }
    };
    const runtime = await stage("catalog", () => getRuntimeCatalog({}, input.signal));
    const snapshot = runtime.value.snapshot;
    await stage("semantic", async () => snapshot.semanticCatalog);
    const spec = await stage("binding", async () => {
      try {
        const capability = resolvePlanningCapability(input.capability, snapshot);
        const bound = bindDraft({
          draft: input.draft,
          catalog: snapshot.catalog,
          semanticCatalog: snapshot.semanticCatalog,
          now: now(),
        });
        assertSpecWithinPlanningCapability(bound, capability);
        return bound;
      } catch (error) {
        throw toDataAgentError(error);
      }
    });
    const compiled = await stage("compiling", async () => {
      try {
        return compileBoundAnalysis({
          catalog: snapshot.catalog,
          semanticCatalog: snapshot.semanticCatalog,
          bindings: runtime.value.bindings,
          spec,
          maxRows,
          maxJoins: 8,
        });
      } catch (error) {
        throw toDataAgentError(error);
      }
    });
    const execution = await stage("executing", () => executeCompiled(compiled, input.signal));
    await stage("verifying", async () => verifyExecution(execution));
    return {
      requestId,
      catalog: snapshot.ref,
      semanticCatalog: snapshot.semanticCatalog.ref,
      columns: compiled.resultColumns,
      execution,
      events,
    };
  }

  return Object.freeze({
    connectorId: options.connector.id,
    dialect: options.connector.dialect,
    inspectCapabilities,
    ...(options.connector.inspectExtensions === undefined ? {} : { inspectExtensions }),
    ...(options.connector.inspectRlsPolicies === undefined ? {} : { inspectRlsPolicies }),
    inspectCatalog,
    inspectPlanningCatalog,
    inspectRelationPlanningCatalog,
    describePlanningCatalog,
    probePlanningData,
    composePlanningCapabilities,
    previewRelation,
    executeReadSql,
    runAnalysis,
  });
}

/** Connector policy messages are authored by this repository and safe to show. */
function safeQueryDiagnostic(error: unknown): { code: string; message: string } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  if (!/^(empty_sql|invalid_sql|multiple_statements|statement_not_allowed|write_statement|locking_clause|invalid_relation|schema_not_allowed|relation_not_found|system_relation_not_allowed|invalid_function|function_schema_not_allowed|function_not_allowed|function_not_allowlisted)$/.test(value.code)) return undefined;
  return { code: value.code, message: value.message.slice(0, 500) };
}

function unavailableRelationContext(): DataAgentError {
  return new DataAgentError("invalid_relation_context", "The selected data context is no longer available.");
}

function typedDiscoveryProbe(probe: DiscoveryProbeRequest, specId: string): TypedProbeRequest {
  const id = `probe_${createHash("sha256")
    .update(`${specId}\u0000${JSON.stringify(probe)}`)
    .digest("hex")
    .slice(0, 24)}`;
  switch (probe.kind) {
    case "time-bounds":
      return { kind: "time-bounds", id, fieldId: probe.fieldId };
    case "value-domain":
      return {
        kind: "value-domain",
        id,
        fieldId: probe.fieldId,
        ...(probe.candidates === undefined ? {} : { candidates: probe.candidates }),
        maxValues: DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES,
      };
    case "field-profile":
      return { kind: "field-profile", id, fieldIds: probe.fieldIds };
    case "join-coverage":
      return { kind: "join-coverage", id, relationshipId: probe.relationshipId };
  }
}

function unionPlanningScope(
  capabilities: readonly PlanningCapabilityRecord[],
  scope: "entityIds" | "fieldIds" | "metricIds" | "relationshipIds",
): Set<string> {
  const result = new Set<string>();
  for (const capability of capabilities) {
    for (const id of capability[scope]) result.add(id);
  }
  return result;
}

async function emitStage(
  input: DataAgentRunInput,
  events: DataAgentStageEvent[],
  requestId: string,
  stage: DataAgentStage,
  status: DataAgentStageEvent["status"],
  now: Date,
  durationMs?: number,
): Promise<void> {
  const event: DataAgentStageEvent = {
    type: "stage",
    requestId,
    stage,
    status,
    at: now.toISOString(),
    ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
  };
  events.push(event);
  try {
    await input.onEvent?.(event);
  } catch {
    // Event transport cannot alter a governed execution.
  }
}

function verifyExecution(execution: DataAgentExecution): DataAgentExecution {
  if (execution.result.rowCount < 0) throw new DataAgentError("query_failed");
  return execution;
}

function defaultRequestId(): string {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) ? Math.max(minimum, Math.min(maximum, Math.floor(candidate))) : fallback;
}

function quotePreviewIdentifier(dialect: Exclude<DatabaseDialect, "mongodb">, identifier: string): string {
  return dialect === "postgres" || dialect === "sqlite" || dialect === "turso"
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll("`", "``")}\``;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The data analysis was aborted.", "AbortError");
}

function waitForAbort<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(new DOMException("The data analysis was aborted.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The data analysis was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function assertPredicateWithinPlanningCapability(
  predicate: AnalysisPredicate,
  requireField: (id: string) => void,
): void {
  switch (predicate.kind) {
    case "all":
    case "any":
      predicate.items.forEach((item) => assertPredicateWithinPlanningCapability(item, requireField));
      return;
    case "not":
      assertPredicateWithinPlanningCapability(predicate.item, requireField);
      return;
    case "null":
    case "comparison":
      requireField(predicate.fieldId);
  }
}

function toDataAgentError(error: unknown): DataAgentError {
  if (error instanceof DataAgentError) return error;
  if (error instanceof AnalysisCompilerError) {
    const code = error.code === "invalid_semantic_catalog"
      ? "invalid_semantic_catalog"
      : error.code === "catalog_stale"
        ? "catalog_stale"
        : error.code === "compile_failed"
          ? "compile_failed"
          : error.code === "query_limit_exceeded"
            ? "query_limit_exceeded"
            : "invalid_analysis_spec";
    return new DataAgentError(code, undefined, { cause: error });
  }
  return new DataAgentError("query_failed", undefined, { cause: error });
}
