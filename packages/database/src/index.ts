import { createHash } from "node:crypto";
import { z } from "zod";

export {
  classifyDatabaseSqlStatement,
  createDatabasePermissionPolicy,
  databasePermissionLevelSchema,
  databasePermissionProfileSchema,
  databaseSqlStatementClassSchema,
  evaluateDatabaseSqlPermission,
  type DatabasePermissionLevel,
  type DatabasePermissionPolicy,
  type DatabasePermissionPolicyInput,
  type DatabasePermissionProfile,
  type DatabaseSqlPermissionEvaluation,
  type DatabaseSqlStatementClass,
} from "./permissions";

export {
  DATABASE_ACTION_VERSION,
  assertDatabaseActionCatalogBinding,
  bindDatabaseActionRowPredicates,
  canonicalizeDatabaseAction,
  classifyDatabaseAction,
  collectDatabaseActionColumns,
  createDatabaseActionHash,
  databaseActionKindSchema,
  databaseActionRiskSchema,
  databaseActionSchema,
  databaseCatalogFingerprintSchema,
  databaseColumnRefSchema,
  databaseConnectionRefSchema,
  databaseDdlActionSchema,
  databaseDdlColumnSchema,
  databaseDdlOperationSchema,
  databaseDeleteActionSchema,
  databaseIdentifierSchema,
  databaseInsertActionSchema,
  databasePredicateSchema,
  databaseRowPredicateBindingSchema,
  databaseReadActionSchema,
  databaseRelationRefSchema,
  databaseUpdateActionSchema,
  databaseWriteValueSchema,
  type DatabaseAction,
  type DatabaseActionClassification,
  type DatabaseActionKind,
  type DatabaseActionRisk,
  type DatabaseColumnRef,
  type DatabaseDdlAction,
  type DatabaseDdlOperation,
  type DatabaseDeleteAction,
  type DatabaseInsertAction,
  type DatabasePredicate,
  type DatabaseRowPredicateBinding,
  type DatabaseReadAction,
  type DatabaseRelationRef,
  type DatabaseUpdateAction,
  type DatabaseWriteValue,
} from "./actions";

export {
  createDatabaseCompiledMutationHash,
  createDatabaseMutationPlan,
  databaseCompiledMutationSchema,
  databaseMutationActionSchema,
  databaseMutationPlanSchema,
  databaseMutationRequestSchema,
  databaseMutationResultSchema,
  databaseSqlParameterSchema,
  isDatabaseMutationExecutor,
  validateDatabaseMutationPlan,
  type DatabaseCompiledMutation,
  type DatabaseMutationAction,
  type DatabaseMutationExecutor,
  type DatabaseMutationPlan,
  type DatabaseMutationPlanInput,
  type DatabaseMutationRequest,
  type DatabaseMutationResult,
  type DatabaseSqlParameter,
} from "./mutation";

export {
  compileDatabaseMutation,
  type CompileDatabaseMutationInput,
} from "./mutation-compiler";

export {
  createDatabaseScopedPermissionPolicy,
  databaseActionMatchesResourceScope,
  databaseActionPermissionGrantSchema,
  databaseActorMatchesSubjectScope,
  databasePermissionActorSchema,
  databasePermissionResourceScopeSchema,
  databasePermissionSubjectScopeSchema,
  databaseScopedPermissionPolicyInputSchema,
  databaseScopedPermissionRuleSchema,
  evaluateDatabaseActionPolicy,
  isDatabaseActionPermissionGrantActive,
  type DatabaseActionPermissionGrant,
  type DatabaseActionPolicyEvaluation,
  type DatabaseActionPolicyEvaluationInput,
  type DatabasePermissionActor,
  type DatabasePermissionResourceScope,
  type DatabasePermissionSubjectScope,
  type DatabasePolicyOutcome,
  type DatabaseScopedPermissionPolicy,
  type DatabaseScopedPermissionPolicyInput,
  type DatabaseScopedPermissionRule,
} from "./scoped-policy";

export {
  createAbortResilientAsyncCache,
  type AbortResilientAsyncCache,
} from "./abort-resilient-cache";

export const databaseDialectSchema = z.enum(["postgres", "mysql", "sqlite", "turso", "mongodb"]);

export const databaseColumnSchema = z.object({
  name: z.string().min(1).max(256),
  dataType: z.string().min(1).max(256),
  nullable: z.boolean(),
  ordinal: z.number().int().positive(),
  defaultValue: z.string().max(2_000).optional(),
  comment: z.string().max(2_000).optional(),
}).strict();

export const databaseForeignKeySchema = z.object({
  name: z.string().min(1).max(256),
  columns: z.array(z.string().min(1).max(256)).min(1).max(32),
  referencedSchema: z.string().min(1).max(256),
  referencedTable: z.string().min(1).max(256),
  referencedColumns: z.array(z.string().min(1).max(256)).min(1).max(32),
}).strict();

/** Describes how trustworthy the connector's native foreign-key inventory is. */
export const databaseForeignKeyMetadataSchema = z.enum(["complete", "partial", "unavailable"]);

export const databaseIndexSchema = z.object({
  name: z.string().min(1).max(256),
  columns: z.array(z.string().min(1).max(4_000)).min(1).max(32),
  unique: z.boolean(),
  method: z.string().min(1).max(128).optional(),
  definition: z.string().max(4_000).optional(),
  isConstraint: z.boolean().default(false),
}).strict();

/**
 * Describes how trustworthy the connector's index inventory is. `complete`
 * means the connector checked the full relation inventory; `partial` means
 * some native indexes could not be represented (for example an expression
 * index); `unavailable` means index inspection was not possible.
 */
export const databaseIndexMetadataSchema = z.enum(["complete", "partial", "unavailable"]);

export const databaseTableSchema = z.object({
  schema: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  kind: z.enum(["table", "view", "materialized-view", "foreign-table", "partitioned-table", "collection"]),
  comment: z.string().max(2_000).optional(),
  estimatedRows: z.number().nonnegative().optional(),
  columns: z.array(databaseColumnSchema).max(2_000),
  primaryKey: z.array(z.string().min(1).max(256)).max(32).default([]),
  foreignKeys: z.array(databaseForeignKeySchema).max(256).default([]),
  // An empty array is only evidence of no native foreign keys when metadata is
  // complete. A connector may omit or partially inspect this inventory.
  foreignKeyMetadata: databaseForeignKeyMetadataSchema.optional(),
  // Undefined means the connector could not provide a reliable index
  // inventory. An empty array means it did inspect indexes and found none.
  indexes: z.array(databaseIndexSchema).max(256).optional(),
  indexMetadata: databaseIndexMetadataSchema.optional(),
}).strict().superRefine((table, context) => {
  if ((table.indexMetadata === "complete" || table.indexMetadata === "partial") && table.indexes === undefined) {
    context.addIssue({
      code: "custom",
      path: ["indexes"],
      message: "A complete or partial index inventory must include indexes; use an empty array only when the checked inventory found none.",
    });
  }
  if (table.indexMetadata === "unavailable" && table.indexes !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["indexes"],
      message: "An unavailable index inventory must omit indexes rather than publishing an incomplete array.",
    });
  }
});

export const databaseSchemaSchema = z.object({
  name: z.string().min(1).max(256),
  tables: z.array(databaseTableSchema).max(100_000),
}).strict();

/**
 * Describes whether a connector enumerated the complete readable relation
 * scope or stopped at an explicit inventory boundary. This is catalog-level
 * coverage, distinct from response-level truncation performed by Studio.
 */
export const databaseCatalogCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "unknown"]),
  reason: z.enum(["max_tables", "connector_limit", "metadata_unavailable", "unknown"]).optional(),
  maxTables: z.number().int().positive().max(100_000).optional(),
  returnedTables: z.number().int().nonnegative().max(100_000),
  omittedTables: z.number().int().nonnegative().optional(),
}).strict().superRefine((coverage, context) => {
  if (coverage.status === "complete" && coverage.omittedTables !== undefined && coverage.omittedTables > 0) {
    context.addIssue({ code: "custom", path: ["omittedTables"], message: "Complete catalog coverage cannot omit tables." });
  }
  if (coverage.status === "partial" && coverage.reason === undefined) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Partial catalog coverage requires a reason." });
  }
  if (coverage.maxTables !== undefined && coverage.returnedTables > coverage.maxTables) {
    context.addIssue({ code: "custom", path: ["returnedTables"], message: "returnedTables cannot exceed maxTables." });
  }
}).describe(
  "Connector-owned relation inventory coverage. Partial means relations may have been omitted by the connector; absence from that catalog never proves a relation does not exist.",
);

export const databaseCatalogSchema = z.object({
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  databaseName: z.string().min(1).max(256),
  scannedAt: z.iso.datetime(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schemas: z.array(databaseSchemaSchema).max(1_000),
  coverage: databaseCatalogCoverageSchema.optional(),
}).strict();

/** Runtime database capabilities. Components are advisory planning metadata,
 * never an authorization grant and never a request to install or modify a
 * database feature. */
export const databaseCapabilityComponentSchema = z.object({
  id: z.string().min(1).max(256),
  kind: z.enum(["engine", "feature", "extension", "module"]),
  status: z.enum(["supported", "installed", "available", "unsupported", "unknown"]),
  version: z.string().min(1).max(256).optional(),
  defaultVersion: z.string().min(1).max(256).optional(),
  schema: z.string().min(1).max(256).optional(),
}).strict();

export const databaseCapabilitiesSchema = z.object({
  kind: z.literal("database-capabilities"),
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  databaseName: z.string().min(1).max(256).optional(),
  availability: z.enum(["available", "unavailable", "not-applicable"]),
  serverVersion: z.string().min(1).max(256).optional(),
  serverVersionNumber: z.number().int().nonnegative().optional(),
  components: z.array(databaseCapabilityComponentSchema).max(256),
  truncated: z.boolean(),
  warnings: z.array(z.string().min(1).max(1_000)).max(16),
}).strict();

/** Read-only database-specific extension, plugin, or compiled-module metadata. */
export const databaseExtensionSchema = z.object({
  name: z.string().min(1).max(256),
  /** The database-native mechanism represented by this inventory item. */
  kind: z.enum(["extension", "plugin", "module"]).default("extension"),
  schema: z.string().min(1).max(256).optional(),
  installed: z.boolean(),
  installedVersion: z.string().min(1).max(256).optional(),
  defaultVersion: z.string().min(1).max(256).optional(),
  /** Native status/type values when the database exposes them. */
  status: z.string().min(1).max(128).optional(),
  type: z.string().min(1).max(128).optional(),
}).strict();

export const databaseExtensionInspectionInputSchema = z.object({
  names: z.array(z.string().trim().min(1).max(256)).max(128).optional(),
  includeAvailable: z.boolean().default(true),
}).strict();

export const databaseExtensionInspectionSchema = z.object({
  kind: z.literal("database-extensions"),
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  databaseName: z.string().min(1).max(256).optional(),
  extensions: z.array(databaseExtensionSchema).max(512),
  truncated: z.boolean(),
  warnings: z.array(z.string().min(1).max(1_000)).max(16),
}).strict();

/** PostgreSQL row-level security metadata. Expressions are optional because
 * policy predicates can contain sensitive business rules and are unnecessary
 * for a simple policy inventory. */
export const databaseRlsPolicySchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  permissive: z.enum(["permissive", "restrictive"]),
  roles: z.array(z.string().min(1).max(256)).max(64),
  command: z.enum(["select", "insert", "update", "delete", "all"]),
  usingExpression: z.string().max(8_000).optional(),
  checkExpression: z.string().max(8_000).optional(),
}).strict();

export const databaseRlsRelationSchema = z.object({
  schema: z.string().min(1).max(256),
  table: z.string().min(1).max(256),
  rlsEnabled: z.boolean(),
  rlsForced: z.boolean(),
  policies: z.array(databaseRlsPolicySchema).max(256),
}).strict();

export const databaseRlsPolicyInspectionInputSchema = z.object({
  schemas: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
  relations: z.array(z.object({
    schema: z.string().trim().min(1).max(256),
    table: z.string().trim().min(1).max(256),
  }).strict()).max(128).optional(),
  includeExpressions: z.boolean().default(false),
}).strict();

export const databaseRlsPolicyInspectionSchema = z.object({
  kind: z.literal("database-rls-policies"),
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  databaseName: z.string().min(1).max(256).optional(),
  relations: z.array(databaseRlsRelationSchema).max(512),
  policyCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  warnings: z.array(z.string().min(1).max(1_000)).max(16),
}).strict();

export const connectionAssessmentSchema = z.object({
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  connected: z.boolean(),
  databaseName: z.string().min(1).max(256).optional(),
  host: z.string().min(1).max(512).optional(),
  serverVersion: z.string().min(1).max(256).optional(),
  readOnlyTransactions: z.boolean(),
  credentialCanWrite: z.boolean().optional(),
  latencyMs: z.number().nonnegative().optional(),
  warnings: z.array(z.string().min(1).max(1_000)).max(32).default([]),
}).strict();

export const databaseSqlQueryRequestSchema = z.object({
  sql: z.string().min(1).max(100_000),
  /** Server-only values bound by the connector's database driver. */
  parameters: z.array(z.union([
    z.string().max(8_192),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ])).max(256).optional(),
  purpose: z.string().min(1).max(1_000),
  maxRows: z.number().int().positive().max(20_000).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
}).strict();

/** Server-compiled MongoDB aggregation. This shape is never model-facing. */
export const databaseMongoQueryRequestSchema = z.object({
  kind: z.literal("mongodb"),
  database: z.string().min(1).max(256),
  collection: z.string().min(1).max(256),
  pipeline: z.array(z.record(z.string(), z.unknown())).max(128),
  columns: z.array(z.string().min(1).max(256)).max(2_000).optional(),
  purpose: z.string().min(1).max(1_000),
  maxRows: z.number().int().positive().max(20_000).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
}).strict();

/** SQL remains untagged for compatibility with the existing connector API. */
export const databaseQueryRequestSchema = z.union([
  databaseSqlQueryRequestSchema,
  databaseMongoQueryRequestSchema,
]);

export const databaseQueryResultSchema = z.object({
  queryId: z.string().min(1).max(256),
  columns: z.array(z.object({
    name: z.string().min(1).max(256),
    dataTypeId: z.number().int().nonnegative().optional(),
  }).strict()).max(2_000),
  rows: z.array(z.record(z.string(), z.unknown())).max(10_001),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
}).strict();

export type DatabaseDialect = z.infer<typeof databaseDialectSchema>;
export type DatabaseColumn = z.infer<typeof databaseColumnSchema>;
export type DatabaseForeignKey = z.infer<typeof databaseForeignKeySchema>;
export type DatabaseForeignKeyMetadata = z.infer<typeof databaseForeignKeyMetadataSchema>;
export type DatabaseIndex = z.infer<typeof databaseIndexSchema>;
export type DatabaseIndexMetadata = z.infer<typeof databaseIndexMetadataSchema>;
export type DatabaseCatalogCoverage = z.infer<typeof databaseCatalogCoverageSchema>;
type ParsedDatabaseTable = z.infer<typeof databaseTableSchema>;
type ParsedDatabaseSchema = z.infer<typeof databaseSchemaSchema>;
type ParsedDatabaseCatalog = z.infer<typeof databaseCatalogSchema>;
// Index metadata was added after the original catalog contract. Keep the
// public input type backward-compatible: legacy connectors may omit both
// fields, while new connectors state exactly how complete their inventory is.
export type DatabaseTable = Omit<ParsedDatabaseTable, "indexes"> & { indexes?: DatabaseIndex[] };
export type DatabaseSchema = Omit<ParsedDatabaseSchema, "tables"> & { tables: DatabaseTable[] };
export type DatabaseCatalog = Omit<ParsedDatabaseCatalog, "schemas"> & { schemas: DatabaseSchema[] };
export type DatabaseCapabilityComponent = z.infer<typeof databaseCapabilityComponentSchema>;
export type DatabaseCapabilities = z.infer<typeof databaseCapabilitiesSchema>;
export type DatabaseExtension = z.infer<typeof databaseExtensionSchema>;
export type DatabaseExtensionInspectionInput = z.input<typeof databaseExtensionInspectionInputSchema>;
export type DatabaseExtensionInspection = z.infer<typeof databaseExtensionInspectionSchema>;
export type DatabaseRlsPolicy = z.infer<typeof databaseRlsPolicySchema>;
export type DatabaseRlsRelation = z.infer<typeof databaseRlsRelationSchema>;
export type DatabaseRlsPolicyInspectionInput = z.input<typeof databaseRlsPolicyInspectionInputSchema>;
export type DatabaseRlsPolicyInspection = z.infer<typeof databaseRlsPolicyInspectionSchema>;
export type ConnectionAssessment = z.infer<typeof connectionAssessmentSchema>;
export type DatabaseSqlQueryRequest = z.infer<typeof databaseSqlQueryRequestSchema>;
export type DatabaseMongoQueryRequest = z.infer<typeof databaseMongoQueryRequestSchema>;
export type DatabaseQueryRequest =
  | (DatabaseSqlQueryRequest & Readonly<{ kind?: never; database?: never; collection?: never; pipeline?: never; columns?: never }>)
  | (DatabaseMongoQueryRequest & Readonly<{ sql?: never; parameters?: never }>);
export type DatabaseQueryResult = z.infer<typeof databaseQueryResultSchema>;

export type CatalogIntrospectionOptions = {
  schemas?: readonly string[];
  /** Omitted means every readable relation in the selected schemas. */
  maxTables?: number;
  includeComments?: boolean;
};

export interface DatabaseConnector {
  readonly id: string;
  readonly dialect: DatabaseDialect;
  assess(signal?: AbortSignal): Promise<ConnectionAssessment>;
  introspect(options?: CatalogIntrospectionOptions, signal?: AbortSignal): Promise<DatabaseCatalog>;
  /** Optional read-only runtime capability probe. Older/custom connectors may
   * omit it; callers must treat the result as unavailable in that case. */
  inspectCapabilities?(signal?: AbortSignal): Promise<DatabaseCapabilities>;
  /** Optional database-specific read-only extension inventory. */
  inspectExtensions?(
    input?: DatabaseExtensionInspectionInput,
    signal?: AbortSignal,
  ): Promise<DatabaseExtensionInspection>;
  /** Optional database-specific read-only RLS/policy inventory. */
  inspectRlsPolicies?(
    input?: DatabaseRlsPolicyInspectionInput,
    signal?: AbortSignal,
  ): Promise<DatabaseRlsPolicyInspection>;
  query(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult>;
  close(): Promise<void>;
}

export type CatalogSummaryOptions = {
  maxTables?: number;
  maxColumnsPerTable?: number;
  includeComments?: boolean;
};

export function createCatalogFingerprint(input: Omit<DatabaseCatalog, "fingerprint">): string {
  // Freshness and mutable statistics are deliberately separate from lineage.
  // ANALYZE, comments, or a changed default must not invalidate a governed
  // semantic binding when relation/column/key shape did not change.
  const structure = {
    connectorId: input.connectorId,
    dialect: input.dialect,
    databaseName: input.databaseName,
    coverage: input.coverage,
    schemas: input.schemas.map((schema) => ({
      name: schema.name,
      tables: schema.tables.map((table) => ({
        schema: table.schema,
        name: table.name,
        kind: table.kind,
        columns: table.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
          nullable: column.nullable,
          ordinal: column.ordinal,
        })),
        primaryKey: table.primaryKey,
        foreignKeys: table.foreignKeys.map((foreignKey) => ({
          name: foreignKey.name,
          columns: foreignKey.columns,
          referencedSchema: foreignKey.referencedSchema,
          referencedTable: foreignKey.referencedTable,
          referencedColumns: foreignKey.referencedColumns,
        })),
        foreignKeyMetadata: table.foreignKeyMetadata,
        indexes: (table.indexes ?? []).map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique,
          method: index.method,
          isConstraint: index.isConstraint,
        })),
        indexMetadata: table.indexMetadata,
      })),
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(structure)).digest("hex")}`;
}

export function finalizeCatalog(input: Omit<DatabaseCatalog, "fingerprint">): DatabaseCatalog {
  return databaseCatalogSchema.parse({ ...input, fingerprint: createCatalogFingerprint(input) });
}

export function summarizeCatalog(
  catalog: DatabaseCatalog,
  options: CatalogSummaryOptions = {},
): string {
  const maxTables = clampInteger(options.maxTables ?? 80, 1, 500);
  const maxColumns = clampInteger(options.maxColumnsPerTable ?? 80, 1, 500);
  const allTables = catalog.schemas.flatMap((schema) => schema.tables);
  const tables = allTables.slice(0, maxTables);
  const columnsTruncated = tables.some((table) => table.columns.length > maxColumns);
  const summary = {
    dialect: catalog.dialect,
    database: catalog.databaseName,
    scannedAt: catalog.scannedAt,
    ...(catalog.coverage === undefined ? {} : { catalogCoverage: catalog.coverage }),
    truncated: catalog.coverage?.status === "partial" || allTables.length > tables.length || columnsTruncated,
    tables: tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      kind: table.kind,
      ...(table.estimatedRows === undefined ? {} : { estimatedRows: table.estimatedRows }),
      ...(options.includeComments && table.comment ? { comment: table.comment } : {}),
      primaryKey: table.primaryKey,
      columns: table.columns.slice(0, maxColumns).map((column) => ({
        name: column.name,
        type: column.dataType,
        nullable: column.nullable,
        ...(options.includeComments && column.comment ? { comment: column.comment } : {}),
      })),
      foreignKeys: table.foreignKeys.map((key) => ({
        columns: key.columns,
        references: `${key.referencedSchema}.${key.referencedTable}(${key.referencedColumns.join(", ")})`,
      })),
      foreignKeyMetadata: table.foreignKeyMetadata ?? "complete",
      indexMetadata: table.indexMetadata ?? (table.indexes === undefined ? "unavailable" : "complete"),
      ...(table.indexes === undefined ? {} : {
        indexes: table.indexes.map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique,
          ...(index.method ? { method: index.method } : {}),
          isConstraint: index.isConstraint,
        })),
      }),
    })),
  };
  return canonicalJson(summary);
}

export function findCatalogTable(
  catalog: DatabaseCatalog,
  schemaName: string,
  tableName: string,
): DatabaseTable | undefined {
  return catalog.schemas.find(({ name }) => name === schemaName)?.tables.find(({ name }) => name === tableName);
}

export function catalogStats(catalog: DatabaseCatalog): {
  schemaCount: number;
  tableCount: number;
  columnCount: number;
} {
  const tables = catalog.schemas.flatMap((schema) => schema.tables);
  return {
    schemaCount: catalog.schemas.length,
    tableCount: tables.length,
    columnCount: tables.reduce((count, table) => count + table.columns.length, 0),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Catalog JSON cannot encode non-finite numbers.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Catalog JSON cannot encode ${typeof value}.`);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
