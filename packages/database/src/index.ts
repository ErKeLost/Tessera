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

export const databaseTableSchema = z.object({
  schema: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  kind: z.enum(["table", "view", "materialized-view", "foreign-table", "partitioned-table", "collection"]),
  comment: z.string().max(2_000).optional(),
  estimatedRows: z.number().nonnegative().optional(),
  columns: z.array(databaseColumnSchema).max(2_000),
  primaryKey: z.array(z.string().min(1).max(256)).max(32).default([]),
  foreignKeys: z.array(databaseForeignKeySchema).max(256).default([]),
}).strict();

export const databaseSchemaSchema = z.object({
  name: z.string().min(1).max(256),
  tables: z.array(databaseTableSchema).max(100_000),
}).strict();

export const databaseCatalogSchema = z.object({
  connectorId: z.string().min(1).max(256),
  dialect: databaseDialectSchema,
  databaseName: z.string().min(1).max(256),
  scannedAt: z.iso.datetime(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schemas: z.array(databaseSchemaSchema).max(1_000),
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
  ])).max(256).optional(),
  purpose: z.string().min(1).max(1_000),
  maxRows: z.number().int().positive().max(10_000).optional(),
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
  maxRows: z.number().int().positive().max(10_000).optional(),
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
export type DatabaseTable = z.infer<typeof databaseTableSchema>;
export type DatabaseSchema = z.infer<typeof databaseSchemaSchema>;
export type DatabaseCatalog = z.infer<typeof databaseCatalogSchema>;
export type DatabaseCapabilityComponent = z.infer<typeof databaseCapabilityComponentSchema>;
export type DatabaseCapabilities = z.infer<typeof databaseCapabilitiesSchema>;
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
  const tables = catalog.schemas.flatMap((schema) => schema.tables).slice(0, maxTables);
  const summary = {
    dialect: catalog.dialect,
    database: catalog.databaseName,
    scannedAt: catalog.scannedAt,
    truncated: catalog.schemas.reduce((count, schema) => count + schema.tables.length, 0) > tables.length,
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
