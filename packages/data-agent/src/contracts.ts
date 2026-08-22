import type {
  CatalogIntrospectionOptions,
  DatabaseCatalog,
  DatabaseCapabilities,
  DatabaseConnector,
  DatabaseExtensionInspection,
  DatabaseExtensionInspectionInput,
  DatabaseRlsPolicyInspection,
  DatabaseRlsPolicyInspectionInput,
  DatabaseQueryResult,
} from "@data-elements/database";
import { z } from "zod";

export const DATA_AGENT_VERSION = "2" as const;
export const DATA_AGENT_DEFAULT_MAX_ROWS = 500;
export const DATA_AGENT_DEFAULT_TIMEOUT_MS = 15_000;
export const DATA_AGENT_DEFAULT_CATALOG_TTL_MS = 60_000;
export const DATA_AGENT_MAX_PROBES_PER_ANALYSIS = 2;
/** Maximum semantic entities that one discovery describe call can expand. */
export const DATA_AGENT_DESCRIBE_MAX_ENTITIES = 4;
/** Model-context bound for a single described entity; never a query limit. */
export const DATA_AGENT_DESCRIBE_MAX_FIELDS_PER_ENTITY = 128;
export const DATA_AGENT_DESCRIBE_MAX_METRICS_PER_ENTITY = 64;
export const DATA_AGENT_DESCRIBE_MAX_RELATIONSHIPS = 32;
/** A value-domain probe is deliberately small and never caller-configurable. */
export const DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES = 20;
/** Server-owned limit for direct relation previews. It is not caller-controlled. */
export const DATA_AGENT_RELATION_PREVIEW_LIMIT = 100;
export const DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS = 64;

const fingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const opaqueIdentifier = (kind: string) => z.string().regex(new RegExp(`^${kind}_[a-z0-9]{16,64}$`));

/** Opaque identifiers are the only data identifiers accepted from a model. */
export const entityIdSchema = opaqueIdentifier("ent");
export const fieldIdSchema = opaqueIdentifier("fld");
export const metricIdSchema = opaqueIdentifier("met");
export const relationshipIdSchema = opaqueIdentifier("rel");
export const outputIdSchema = z.string().regex(/^out_[A-Za-z0-9_-]{1,64}$/);
const planningCapabilityTokenSchema = z.string().regex(/^cap_[A-Za-z0-9_-]{32,128}\.[A-Za-z0-9_-]{32,128}$/);

export type EntityId = z.infer<typeof entityIdSchema>;
export type FieldId = z.infer<typeof fieldIdSchema>;
export type MetricId = z.infer<typeof metricIdSchema>;
export type RelationshipId = z.infer<typeof relationshipIdSchema>;
export type OutputId = z.infer<typeof outputIdSchema>;

/**
 * Server-only, signed opaque handle for one planning catalog slice. The token
 * carries no catalog data; DataAgent resolves and validates its authority.
 */
export const planningCapabilitySchema = z.object({
  token: planningCapabilityTokenSchema,
}).strict();
export type PlanningCapability = z.infer<typeof planningCapabilitySchema>;

/**
 * Server-side-only input for combining bounded planning scopes already issued
 * by this DataAgent instance. Semantic identifiers are never accepted here.
 */
export const planningCapabilityCompositionInputSchema = z.object({
  capabilities: z.array(planningCapabilitySchema).min(2).max(16),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, capability] of value.capabilities.entries()) {
    if (seen.has(capability.token)) {
      context.addIssue({
        code: "custom",
        message: "Planning capabilities must be unique.",
        path: ["capabilities", index],
      });
    }
    seen.add(capability.token);
  }
});
export type DataAgentPlanningCapabilityCompositionInput = z.input<typeof planningCapabilityCompositionInputSchema>;

export const catalogSnapshotRefSchema = z.object({
  connectorId: z.string().min(1).max(256),
  catalogFingerprint: fingerprintSchema,
  capturedAt: z.iso.datetime(),
}).strict();

export const semanticCatalogRefSchema = z.object({
  manifestId: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
  fingerprint: fingerprintSchema,
  catalogFingerprint: fingerprintSchema,
}).strict();

export type CatalogSnapshotRef = z.infer<typeof catalogSnapshotRefSchema>;
export type SemanticCatalogRef = z.infer<typeof semanticCatalogRefSchema>;

export const dataTypeFamilySchema = z.enum([
  "string",
  "number",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "json",
  "unknown",
]);
export type DataTypeFamily = z.infer<typeof dataTypeFamilySchema>;
export const semanticFieldRoleSchema = z.enum(["identifier", "dimension", "time", "measure", "attribute"]);
export const fieldExposureSchema = z.enum(["never-to-model", "aggregate-only", "bounded-values"]);
export const aggregateSchema = z.enum(["count", "count_distinct", "sum", "avg", "min", "max"]);
export type SemanticFieldRole = z.infer<typeof semanticFieldRoleSchema>;
export type FieldExposure = z.infer<typeof fieldExposureSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;

export const semanticFieldSchema = z.object({
  id: fieldIdSchema,
  label: z.string().min(1).max(256),
  aliases: z.array(z.string().min(1).max(256)).max(32).default([]),
  /** Business meaning from the host manifest or connector metadata. */
  description: z.string().min(1).max(1_000).optional(),
  type: dataTypeFamilySchema,
  role: semanticFieldRoleSchema,
  exposure: fieldExposureSchema,
}).strict();

export const semanticMetricSchema = z.object({
  id: metricIdSchema,
  label: z.string().min(1).max(256),
  /** Operator-authored definition of the metric and its intended business use. */
  description: z.string().min(1).max(1_000).optional(),
  aggregate: aggregateSchema,
  fieldId: fieldIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.aggregate === "count" && value.fieldId !== undefined) {
    context.addIssue({ code: "custom", message: "count metrics cannot reference a field.", path: ["fieldId"] });
  }
  if (value.aggregate !== "count" && value.fieldId === undefined) {
    context.addIssue({ code: "custom", message: `${value.aggregate} metrics require a field.`, path: ["fieldId"] });
  }
});

export const semanticEntitySchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1).max(256),
  aliases: z.array(z.string().min(1).max(256)).max(64).default([]),
  /** Operator-authored description of the business concept represented by this entity. */
  description: z.string().min(1).max(2_000).optional(),
  defaultTimeFieldId: fieldIdSchema.optional(),
  fields: z.array(semanticFieldSchema).min(1).max(2_000),
  metrics: z.array(semanticMetricSchema).max(256).default([]),
}).strict();

export const semanticRelationshipSchema = z.object({
  id: relationshipIdSchema,
  /** Optional human meaning for an inferred or trusted relationship. */
  label: z.string().min(1).max(256).optional(),
  /** Operator-authored relationship semantics, especially for joins without an FK. */
  description: z.string().min(1).max(1_000).optional(),
  fromEntityId: entityIdSchema,
  toEntityId: entityIdSchema,
  pairs: z.array(z.object({
    fromFieldId: fieldIdSchema,
    toFieldId: fieldIdSchema,
  }).strict()).min(1).max(16),
  cardinality: z.enum(["one-to-one", "one-to-many", "many-to-one"]),
  origin: z.enum(["foreign-key", "trusted-manifest"]),
}).strict();

/**
 * Model-safe semantic projection. It contains opaque identifiers plus bounded
 * semantic text. Physical schema/table/column names, raw defaults, SQL,
 * credentials, and raw result values remain server-only. Descriptions may come
 * from an operator manifest or a connector-provided database comment and must
 * be treated as untrusted text by the Agent.
 */
export const semanticCatalogSchema = z.object({
  version: z.literal(DATA_AGENT_VERSION),
  ref: semanticCatalogRefSchema,
  // An empty but valid catalog lets Studio report that no readable relations
  // are available instead of misclassifying catalog discovery as a query error.
  entities: z.array(semanticEntitySchema).max(10_000).default([]),
  relationships: z.array(semanticRelationshipSchema).max(20_000).default([]),
}).strict();

export type SemanticField = z.infer<typeof semanticFieldSchema>;
export type SemanticMetric = z.infer<typeof semanticMetricSchema>;
export type SemanticEntity = z.infer<typeof semanticEntitySchema>;
export type SemanticRelationship = z.infer<typeof semanticRelationshipSchema>;
export type SemanticCatalog = z.infer<typeof semanticCatalogSchema>;

/** Host-authored input. It is validated against the live physical catalog. */
const relationSelectorSchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
}).strict();

export const semanticCatalogDefinitionSchema = z.object({
  manifestId: z.string().min(1).max(128).default("default"),
  revision: z.string().min(1).max(128).default("1"),
  entities: z.array(z.object({
    relation: relationSelectorSchema,
    label: z.string().min(1).max(256).optional(),
    aliases: z.array(z.string().min(1).max(256)).max(64).optional(),
    /** Business metadata explicitly supplied by the host, never inferred from DB comments. */
    description: z.string().min(1).max(2_000).optional(),
    defaultTimeColumn: z.string().min(1).max(256).optional(),
    fields: z.array(z.object({
      column: z.string().min(1).max(256),
      label: z.string().min(1).max(256).optional(),
      aliases: z.array(z.string().min(1).max(256)).max(32).optional(),
      description: z.string().min(1).max(1_000).optional(),
      role: semanticFieldRoleSchema.optional(),
      exposure: fieldExposureSchema.optional(),
    }).strict()).max(2_000).optional(),
    metrics: z.array(z.object({
      key: z.string().min(1).max(128),
      label: z.string().min(1).max(256).optional(),
      description: z.string().min(1).max(1_000).optional(),
      aggregate: aggregateSchema,
      column: z.string().min(1).max(256).optional(),
    }).strict()).max(256).optional(),
  }).strict()).max(10_000).default([]),
  relationships: z.array(z.object({
    from: relationSelectorSchema,
    to: relationSelectorSchema,
    /** Meaning of an explicit relation when the database has no foreign key. */
    label: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(1_000).optional(),
    pairs: z.array(z.object({
      fromColumn: z.string().min(1).max(256),
      toColumn: z.string().min(1).max(256),
    }).strict()).min(1).max(16),
    cardinality: z.enum(["one-to-one", "one-to-many", "many-to-one"]),
  }).strict()).max(20_000).default([]),
}).strict();

export type SemanticCatalogDefinition = z.input<typeof semanticCatalogDefinitionSchema>;

const scalarValueSchema = z.union([
  z.string().min(1).max(1_024),
  z.number().finite(),
  z.boolean(),
]);
const predicateValueSchema = z.union([
  scalarValueSchema,
  z.array(scalarValueSchema).min(1).max(64),
]);

export type AnalysisPredicate =
  | Readonly<{ kind: "all"; items: readonly AnalysisPredicate[] }>
  | Readonly<{ kind: "any"; items: readonly AnalysisPredicate[] }>
  | Readonly<{ kind: "not"; item: AnalysisPredicate }>
  | Readonly<{ kind: "null"; fieldId: FieldId; isNull: boolean }>
  | Readonly<{
      kind: "comparison";
      fieldId: FieldId;
      op: "eq" | "neq" | "in" | "between" | "gt" | "gte" | "lt" | "lte" | "contains";
      value: string | number | boolean | readonly (string | number | boolean)[];
    }>;

export const analysisPredicateSchema: z.ZodType<AnalysisPredicate> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), items: z.array(analysisPredicateSchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("any"), items: z.array(analysisPredicateSchema).min(1).max(64) }).strict(),
  z.object({ kind: z.literal("not"), item: analysisPredicateSchema }).strict(),
  z.object({ kind: z.literal("null"), fieldId: fieldIdSchema, isNull: z.boolean() }).strict(),
  z.object({
    kind: z.literal("comparison"),
    fieldId: fieldIdSchema,
    op: z.enum(["eq", "neq", "in", "between", "gt", "gte", "lt", "lte", "contains"]),
    value: predicateValueSchema,
  }).strict(),
]));

export const measureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metric"), metricId: metricIdSchema, outputId: outputIdSchema }).strict(),
  z.object({
    kind: z.literal("aggregate"),
    aggregate: aggregateSchema,
    fieldId: fieldIdSchema.optional(),
    outputId: outputIdSchema,
  }).strict().superRefine((value, context) => {
    if (value.aggregate === "count" && value.fieldId !== undefined) {
      context.addIssue({ code: "custom", message: "count cannot reference a field.", path: ["fieldId"] });
    }
    if (value.aggregate !== "count" && value.fieldId === undefined) {
      context.addIssue({ code: "custom", message: `${value.aggregate} requires a field.`, path: ["fieldId"] });
    }
  }),
]);

export const dimensionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field"), fieldId: fieldIdSchema, outputId: outputIdSchema }).strict(),
  z.object({
    kind: z.literal("time"),
    fieldId: fieldIdSchema,
    grain: z.enum(["hour", "day", "week", "month", "quarter", "year"]),
    outputId: outputIdSchema,
  }).strict(),
]);

export const recordProjectionSchema = z.object({
  fieldId: fieldIdSchema,
  outputId: outputIdSchema,
}).strict();

export const recordOrderSchema = z.object({
  fieldId: fieldIdSchema,
  direction: z.enum(["asc", "desc"]),
}).strict();

const analysisDraftCommonShape = {
  version: z.literal(DATA_AGENT_VERSION),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  primaryEntityId: entityIdSchema,
  relationshipIds: z.array(relationshipIdSchema).max(16).default([]),
  filter: analysisPredicateSchema.optional(),
  limit: z.number().int().min(1).max(10_000).default(100),
};

/**
 * Aggregated analytical query. `mode` defaults for the legacy structured
 * draft shape, while new producers should always send it explicitly.
 */
export const aggregateAnalysisDraftSchema = z.object({
  ...analysisDraftCommonShape,
  mode: z.literal("aggregate").default("aggregate"),
  measures: z.array(measureSchema).min(1).max(16),
  dimensions: z.array(dimensionSchema).max(8).default([]),
  orderBy: z.array(z.object({
    outputId: outputIdSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()).max(8).default([]),
  output: z.enum(["scalar", "table", "series", "ranking"]),
}).strict();

/**
 * Row-level query. It deliberately has no aggregate measures or dimensions:
 * fields are projected directly and orderBy is mandatory so "latest" and
 * ranking requests never depend on a compiler guess.
 */
export const recordsAnalysisDraftSchema = z.object({
  ...analysisDraftCommonShape,
  mode: z.literal("records"),
  fields: z.array(recordProjectionSchema).min(1).max(32),
  orderBy: z.array(recordOrderSchema).min(1).max(8),
}).strict();

export const analysisDraftSchema = z.union([
  aggregateAnalysisDraftSchema,
  recordsAnalysisDraftSchema,
]);

const analysisSpecExtension = {
  catalog: catalogSnapshotRefSchema,
  semanticCatalog: semanticCatalogRefSchema,
  specId: z.string().regex(/^spec_[a-z0-9]{16,64}$/),
  createdAt: z.iso.datetime(),
};

export const aggregateAnalysisSpecSchema = aggregateAnalysisDraftSchema.extend(analysisSpecExtension).strict();
export const recordsAnalysisSpecSchema = recordsAnalysisDraftSchema.extend(analysisSpecExtension).strict();
export const analysisSpecSchema = z.union([
  aggregateAnalysisSpecSchema,
  recordsAnalysisSpecSchema,
]);

export type Measure = z.infer<typeof measureSchema>;
export type Dimension = z.infer<typeof dimensionSchema>;
export type RecordProjection = z.infer<typeof recordProjectionSchema>;
export type RecordOrder = z.infer<typeof recordOrderSchema>;
export type AnalysisDraft = z.infer<typeof analysisDraftSchema>;
export type AnalysisSpec = z.infer<typeof analysisSpecSchema>;

export const typedProbeRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("time-bounds"),
    id: z.string().regex(/^probe_[a-z0-9]{16,64}$/),
    fieldId: fieldIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("value-domain"),
    id: z.string().regex(/^probe_[a-z0-9]{16,64}$/),
    fieldId: fieldIdSchema,
    candidates: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
    maxValues: z.number().int().min(1).max(50).default(20),
  }).strict(),
  z.object({
    kind: z.literal("field-profile"),
    id: z.string().regex(/^probe_[a-z0-9]{16,64}$/),
    fieldIds: z.array(fieldIdSchema).min(1).max(8),
  }).strict(),
  z.object({
    kind: z.literal("join-coverage"),
    id: z.string().regex(/^probe_[a-z0-9]{16,64}$/),
    relationshipId: relationshipIdSchema,
  }).strict(),
]);

export const typedProbePlanSchema = z.object({
  version: z.literal(DATA_AGENT_VERSION),
  specId: z.string().regex(/^spec_[a-z0-9]{16,64}$/),
  probes: z.array(typedProbeRequestSchema).max(DATA_AGENT_MAX_PROBES_PER_ANALYSIS),
}).strict();

export type TypedProbeRequest = z.infer<typeof typedProbeRequestSchema>;
export type TypedProbePlan = z.infer<typeof typedProbePlanSchema>;

export const compiledResultColumnSchema = z.object({
  outputId: outputIdSchema,
  label: z.string().min(1).max(256),
  type: dataTypeFamilySchema,
}).strict();

/** Server-only SQL compiler output. Never pass this type to a model or browser. */
export const compiledSqlQuerySchema = z.object({
  sql: z.string().min(1).max(100_000),
  parameters: z.array(z.union([z.string(), z.number().finite(), z.boolean()])).max(256),
  sourceRelationIds: z.array(z.string().min(1).max(256)).min(1).max(32),
  resultColumns: z.array(compiledResultColumnSchema).min(1).max(32),
}).strict();

/** Server-only MongoDB aggregation output. */
export const compiledMongoQuerySchema = z.object({
  kind: z.literal("mongodb"),
  database: z.string().min(1).max(256),
  collection: z.string().min(1).max(256),
  pipeline: z.array(z.record(z.string(), z.unknown())).max(128),
  sourceRelationIds: z.array(z.string().min(1).max(256)).min(1).max(32),
  resultColumns: z.array(compiledResultColumnSchema).min(1).max(32),
}).strict();

export const compiledQuerySchema = z.union([
  compiledSqlQuerySchema,
  compiledMongoQuerySchema,
]);

export type CompiledResultColumn = z.infer<typeof compiledResultColumnSchema>;
export type CompiledSqlQuery = z.infer<typeof compiledSqlQuerySchema> & Readonly<{
  kind?: never;
  database?: never;
  collection?: never;
  pipeline?: never;
}>;
export type CompiledMongoQuery = z.infer<typeof compiledMongoQuerySchema> & Readonly<{
  sql?: never;
  parameters?: never;
}>;
export type CompiledQuery = CompiledSqlQuery | CompiledMongoQuery;

export type CompileLimits = Readonly<{
  maxRows?: number;
  maxJoins?: number;
}>;

export type CompileAnalysisSpecInput = Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  spec: AnalysisSpec;
  limits?: CompileLimits;
}>;

export type CompileTypedProbeInput = Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog: SemanticCatalog;
  spec: AnalysisSpec;
  probe: TypedProbeRequest;
}>;

export type DataAgentCatalogInput = Readonly<{ refresh?: boolean }>;

export type DataAgentCapabilitiesSnapshot = Readonly<{
  capabilities: DatabaseCapabilities;
  cacheStatus: "hit" | "loaded" | "unavailable";
}>;

/**
 * Planner-only catalog access. It deliberately returns no physical catalog,
 * relation name, column name, SQL, or connector metadata.
 */
export type DataAgentPlanningCatalogInput = Readonly<{
  query?: string;
  refresh?: boolean;
}>;

/**
 * Server-only binding for a relation selected in a trusted host view. Physical
 * identifiers never become model input or model-visible tool output. The
 * catalog fingerprint binds that view to the catalog version that rendered it.
 * The runtime refreshes the catalog during binding; callers cannot opt out.
 */
export const relationPlanningCatalogInputSchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
  catalogFingerprint: fingerprintSchema,
}).strict();

export type DataAgentRelationPlanningCatalogInput = z.input<typeof relationPlanningCatalogInputSchema>;

export type DataAgentPlanningCatalogSnapshot = Readonly<{
  ref: CatalogSnapshotRef;
  /** Never pass this opaque server capability to a model or browser. */
  capability: PlanningCapability;
  semanticCatalog: SemanticCatalog;
  cacheStatus: "hit" | "loaded";
  entityCount: number;
  truncated: boolean;
  omitted: Readonly<{
    entities: number;
    fields: number;
    metrics: number;
    relationships: number;
  }>;
}>;

/**
 * A server-bound, single-relation planning scope. Only `semanticCatalog` is
 * model-safe; `capability` remains in the server orchestration layer.
 */
export type DataAgentRelationPlanningCatalogSnapshot = Readonly<{
  ref: CatalogSnapshotRef;
  /** Never pass this opaque server capability to a model or browser. */
  capability: PlanningCapability;
  semanticCatalog: SemanticCatalog;
  cacheStatus: "hit" | "loaded";
  truncated: boolean;
  omitted: Readonly<{
    entities: number;
    fields: number;
    metrics: number;
    relationships: number;
  }>;
}>;

/**
 * Server-only expansion of an already-issued planning scope. Entity IDs must
 * have been returned by a previous catalog inspection; the capability itself
 * never crosses the model or browser boundary.
 */
export const planningCatalogDescriptionInputSchema = z.object({
  capability: planningCapabilitySchema,
  entityIds: z.array(entityIdSchema).min(1).max(DATA_AGENT_DESCRIBE_MAX_ENTITIES),
}).strict().superRefine((value, context) => {
  if (new Set(value.entityIds).size !== value.entityIds.length) {
    context.addIssue({ code: "custom", message: "Described entities must be unique.", path: ["entityIds"] });
  }
});

export type DataAgentPlanningCatalogDescriptionInput = z.input<typeof planningCatalogDescriptionInputSchema>;

export type DataAgentPlanningCatalogDescription = Readonly<{
  ref: CatalogSnapshotRef;
  /** New, strictly expanded authority for exactly the returned semantic slice. */
  capability: PlanningCapability;
  semanticCatalog: SemanticCatalog;
  cacheStatus: "hit" | "loaded";
  truncated: boolean;
  omitted: Readonly<{
    entities: number;
    fields: number;
    metrics: number;
    relationships: number;
  }>;
}>;

/**
 * The only discovery probes available to a model. These are intentionally
 * narrower than `TypedProbeRequest`: the server supplies probe IDs and limits,
 * so an Agent cannot turn probing into an arbitrary query surface.
 */
export const discoveryProbeRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("time-bounds"),
    fieldId: fieldIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("value-domain"),
    fieldId: fieldIdSchema,
    candidates: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
  }).strict(),
  z.object({
    kind: z.literal("field-profile"),
    fieldIds: z.array(fieldIdSchema).min(1).max(8),
  }).strict().superRefine((value, context) => {
    if (new Set(value.fieldIds).size !== value.fieldIds.length) {
      context.addIssue({ code: "custom", message: "Profiled fields must be unique.", path: ["fieldIds"] });
    }
  }),
  z.object({
    kind: z.literal("join-coverage"),
    relationshipId: relationshipIdSchema,
  }).strict(),
]);

export type DiscoveryProbeRequest = z.infer<typeof discoveryProbeRequestSchema>;

export const planningProbeInputSchema = z.object({
  capability: planningCapabilitySchema,
  probe: discoveryProbeRequestSchema,
}).strict();

export type DataAgentPlanningProbeInput = z.input<typeof planningProbeInputSchema>;

export type DataAgentPlanningProbeResult = Readonly<{
  catalog: CatalogSnapshotRef;
  semanticCatalog: SemanticCatalogRef;
  probe: DiscoveryProbeRequest;
  columns: readonly CompiledResultColumn[];
  execution: Readonly<{
    specId: string;
    probeId: string;
    queryFingerprint: string;
    result: DatabaseQueryResult;
    resultScope: "complete-result" | "returned-rows";
  }>;
}>;

/**
 * Server-only physical relation selector. It is intentionally separate from
 * the model-facing semantic catalog and has no SQL or caller-selected limit.
 */
export const relationPreviewRequestSchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
  columns: z.array(z.string().min(1).max(256)).min(1).max(DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS),
  /** Server-controlled catalog refresh; Studio never forwards this from a browser request. */
  refresh: z.boolean().optional().default(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.columns).size !== value.columns.length) {
    context.addIssue({ code: "custom", message: "Preview columns must be unique.", path: ["columns"] });
  }
});

export type RelationPreviewRequest = z.input<typeof relationPreviewRequestSchema>;

export type DataAgentCatalogSnapshot = Readonly<{
  catalog: DatabaseCatalog;
  ref: CatalogSnapshotRef;
  semanticCatalog: SemanticCatalog;
  cacheStatus: "hit" | "loaded";
}>;

export type DataAgentStage =
  | "catalog"
  | "semantic"
  | "binding"
  | "probing"
  | "compiling"
  | "executing"
  | "verifying";
export type DataAgentStageStatus = "started" | "completed" | "failed" | "skipped";

export type DataAgentStageEvent = Readonly<{
  type: "stage";
  requestId: string;
  stage: DataAgentStage;
  status: DataAgentStageStatus;
  at: string;
  durationMs?: number;
}>;

export type DataAgentExecution = Readonly<{
  queryFingerprint: string;
  result: DatabaseQueryResult;
  resultScope: "complete-result" | "returned-rows";
}>;

/**
 * Explicit SQL is an escape hatch for database work that is not a semantic
 * analysis. The connector remains the execution boundary and accepts only
 * its dialect's supported read-only statement subset.
 */
export type DataAgentReadSqlInput = Readonly<{
  sql: string;
  parameters?: readonly (string | number | boolean)[];
  purpose?: string;
}>;

export type DataAgentRelationPreview = Readonly<{
  catalog: CatalogSnapshotRef;
  relation: Readonly<{ schema: string; table: string }>;
  columns: readonly string[];
  limit: typeof DATA_AGENT_RELATION_PREVIEW_LIMIT;
  result: DatabaseQueryResult;
}>;

export type DataAgentRunInput = Readonly<{
  requestId?: string;
  capability: PlanningCapability;
  draft: unknown;
  signal?: AbortSignal;
  onEvent?: (event: DataAgentStageEvent) => void | Promise<void>;
}>;

export type DataAgentRunResult = Readonly<{
  requestId: string;
  catalog: CatalogSnapshotRef;
  semanticCatalog: SemanticCatalogRef;
  columns: readonly CompiledResultColumn[];
  execution: DataAgentExecution;
  events: readonly DataAgentStageEvent[];
}>;

export type DataAgentOptions = Readonly<{
  connector: DatabaseConnector;
  catalog?: Readonly<{
    ttlMs?: number;
    introspection?: CatalogIntrospectionOptions;
  }>;
  semantic?: SemanticCatalogDefinition;
  query?: Readonly<{
    maxRows?: number;
    timeoutMs?: number;
  }>;
  now?: () => Date;
  requestIdFactory?: () => string;
}>;

export type DataAgent = Readonly<{
  readonly connectorId: string;
  readonly dialect?: DatabaseCatalog["dialect"];
  inspectCapabilities(signal?: AbortSignal): Promise<DataAgentCapabilitiesSnapshot>;
  inspectExtensions?(input?: DatabaseExtensionInspectionInput, signal?: AbortSignal): Promise<DatabaseExtensionInspection>;
  inspectRlsPolicies?(input?: DatabaseRlsPolicyInspectionInput, signal?: AbortSignal): Promise<DatabaseRlsPolicyInspection>;
  inspectCatalog(input?: DataAgentCatalogInput, signal?: AbortSignal): Promise<DataAgentCatalogSnapshot>;
  inspectPlanningCatalog(input?: DataAgentPlanningCatalogInput, signal?: AbortSignal): Promise<DataAgentPlanningCatalogSnapshot>;
  inspectRelationPlanningCatalog(input: DataAgentRelationPlanningCatalogInput, signal?: AbortSignal): Promise<DataAgentRelationPlanningCatalogSnapshot>;
  describePlanningCatalog(input: DataAgentPlanningCatalogDescriptionInput, signal?: AbortSignal): Promise<DataAgentPlanningCatalogDescription>;
  probePlanningData(input: DataAgentPlanningProbeInput, signal?: AbortSignal): Promise<DataAgentPlanningProbeResult>;
  composePlanningCapabilities(input: DataAgentPlanningCapabilityCompositionInput, signal?: AbortSignal): Promise<PlanningCapability>;
  previewRelation(input: RelationPreviewRequest, signal?: AbortSignal): Promise<DataAgentRelationPreview>;
  executeReadSql(input: DataAgentReadSqlInput, signal?: AbortSignal): Promise<DatabaseQueryResult>;
  runAnalysis(input: DataAgentRunInput): Promise<DataAgentRunResult>;
}>;

export type DataAgentErrorCode =
  | "catalog_stale"
  | "invalid_analysis_spec"
  | "invalid_semantic_catalog"
  | "invalid_relation_context"
  | "invalid_relation_preview"
  | "compile_failed"
  | "query_policy_rejected"
  | "query_failed"
  | "query_limit_exceeded";
