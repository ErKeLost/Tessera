import {
  catalogStats,
  classifyDatabaseAction,
  createAbortResilientAsyncCache,
  databaseMutationRequestSchema,
  databaseMutationResultSchema,
  finalizeCatalog,
  validateDatabaseMutationPlan,
  type AbortResilientAsyncCache,
  type CatalogIntrospectionOptions,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseMutationExecutor,
  type DatabaseMutationRequest,
  type DatabaseMutationResult,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
  type DatabaseSchema,
  type DatabaseTable,
} from "@data-elements/database";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryArrayResult } from "pg";
import { PostgresQueryPolicyError, validateReadOnlySql, type KnownRelation } from "./sql-policy";

export { PostgresQueryPolicyError, validateReadOnlySql } from "./sql-policy";
export type { KnownRelation, ReadOnlySqlPolicy } from "./sql-policy";

export type PostgresConnectorOptions = {
  connectionString: string;
  id?: string;
  applicationName?: string;
  schemas?: readonly string[];
  maxConnections?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
  allowedFunctions?: readonly string[];
};

type NormalizedOptions = Required<Omit<PostgresConnectorOptions, "schemas" | "allowedFunctions" | "id">> & {
  id: string;
  schemas?: readonly string[];
  allowedFunctions: readonly string[];
};

type TableRow = {
  schema_name: string;
  table_name: string;
  relation_kind: string;
  comment: string | null;
  estimated_rows: number | string | null;
};

type ColumnRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
  ordinal: number;
  data_type: string;
  nullable: boolean;
  default_value: string | null;
  comment: string | null;
};

type PrimaryKeyRow = {
  schema_name: string;
  table_name: string;
  columns: string[];
};

type ForeignKeyRow = {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  columns: string[];
  referenced_schema: string;
  referenced_table: string;
  referenced_columns: string[];
};

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_TIMEOUT_MS = 1_500;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CONNECTIONS = 4;

export function createPostgresConnector(options: PostgresConnectorOptions): PostgresConnector {
  return new PostgresConnector(options);
}

export class PostgresConnector implements DatabaseConnector, DatabaseMutationExecutor {
  readonly dialect = "postgres" as const;
  readonly id: string;
  readonly #options: NormalizedOptions;
  readonly #pool: Pool;
  readonly #schemaCache: AbortResilientAsyncCache<readonly string[]>;
  #catalog: DatabaseCatalog | undefined;

  constructor(options: PostgresConnectorOptions) {
    const parsedUrl = validatePostgresUrl(options.connectionString);
    this.id = options.id?.trim() || `postgres:${parsedUrl.hostname || "local"}`;
    this.#options = {
      connectionString: options.connectionString,
      id: this.id,
      applicationName: options.applicationName?.trim() || "data-elements-studio",
      maxConnections: clampInteger(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, 1, 20),
      maxRows: clampInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 10_000),
      statementTimeoutMs: clampInteger(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS, 250, 120_000),
      lockTimeoutMs: clampInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 100, 30_000),
      idleTransactionTimeoutMs: clampInteger(options.idleTransactionTimeoutMs ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS, 1_000, 120_000),
      ...(options.schemas?.length ? { schemas: normalizeSchemas(options.schemas) } : {}),
      allowedFunctions: [...new Set((options.allowedFunctions ?? []).map(normalizeIdentifier))],
    };
    this.#pool = new Pool({
      application_name: this.#options.applicationName,
      connectionString: this.#options.connectionString,
      connectionTimeoutMillis: this.#options.statementTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: this.#options.maxConnections,
    });
    this.#schemaCache = createAbortResilientAsyncCache(async () => {
      const result = await this.#withReadOnlyTransaction(undefined, async (client) => {
        return client.query<{ schema_name: string }>({
          text: `
            SELECT DISTINCT namespace.nspname AS schema_name
            FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname <> 'information_schema'
              AND namespace.nspname NOT LIKE 'pg_%'
              AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND has_table_privilege(relation.oid, 'SELECT')
            ORDER BY namespace.nspname
          `,
        });
      });
      return result.rows.map(({ schema_name }) => schema_name);
    });
  }

  async assess(signal?: AbortSignal): Promise<ConnectionAssessment> {
    const startedAt = performance.now();
    const url = validatePostgresUrl(this.#options.connectionString);
    try {
      const assessment = await this.#withReadOnlyTransaction(signal, async (client) => {
        const result = await client.query<{
          database_name: string;
          server_version: string;
          can_create_database_objects: boolean;
          can_modify_discovered_tables: boolean;
        }>({
          text: `
            SELECT
              current_database() AS database_name,
              current_setting('server_version') AS server_version,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
              EXISTS (
                SELECT 1
                FROM information_schema.role_table_grants grants
                WHERE grants.grantee IN (current_user, 'PUBLIC')
                  AND grants.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
              ) AS can_modify_discovered_tables
          `,
        });
        return result.rows[0];
      });
      if (!assessment) throw new Error("PostgreSQL did not return a connection assessment.");
      const credentialCanWrite = assessment.can_create_database_objects || assessment.can_modify_discovered_tables;
      return {
        connectorId: this.id,
        dialect: "postgres",
        connected: true,
        databaseName: assessment.database_name,
        host: url.hostname || undefined,
        serverVersion: assessment.server_version,
        readOnlyTransactions: true,
        credentialCanWrite,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: credentialCanWrite
          ? ["The credential appears to have write privileges. Studio still uses read-only transactions, but a dedicated read-only role is recommended."]
          : [],
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return {
        connectorId: this.id,
        dialect: "postgres",
        connected: false,
        host: url.hostname || undefined,
        readOnlyTransactions: true,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: ["PostgreSQL could not be reached with the configured connection."],
      };
    }
  }

  async introspect(
    options: CatalogIntrospectionOptions = {},
    signal?: AbortSignal,
  ): Promise<DatabaseCatalog> {
    const allowedSchemas = await this.#getAllowedSchemas(signal);
    const schemas = options.schemas?.length
      ? normalizeSchemas(options.schemas).filter((schema) => allowedSchemas.includes(schema))
      : allowedSchemas;
    if (schemas.length === 0) throw new Error("No PostgreSQL schemas are available to this connection.");
    // An administrator connection must discover every relation it can read by
    // default. A host may still set `maxTables` deliberately for a bounded
    // deployment, but an implicit first-500 slice makes later relations
    // indistinguishable from relations that do not exist.
    const maxTables = normalizeMaxTables(options.maxTables);

    const [tableRows, columnRows, primaryKeyRows, foreignKeyRows, databaseName] = await this.#withReadOnlyTransaction(
      signal,
      async (client) => {
        // node-postgres serializes work on one client. Running these in parallel
        // corrupts the client protocol on current drivers and can hide catalog
        // SQL failures behind a generic Studio error.
        const tableRows = await queryTables(client, schemas, maxTables);
        const columnRows = await queryColumns(client, schemas, maxTables);
        const primaryKeyRows = await queryPrimaryKeys(client, schemas, maxTables);
        const foreignKeyRows = await queryForeignKeys(client, schemas, maxTables);
        const databaseName = await queryDatabaseName(client);
        return [tableRows, columnRows, primaryKeyRows, foreignKeyRows, databaseName] as const;
      },
    );

    const catalog = finalizeCatalog({
      connectorId: this.id,
      dialect: "postgres",
      databaseName,
      scannedAt: new Date().toISOString(),
      schemas: assembleCatalog(
        tableRows,
        columnRows,
        primaryKeyRows,
        foreignKeyRows,
        options.includeComments ?? false,
      ),
    });
    this.#catalog = catalog;
    return catalog;
  }

  async query(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    if (signal?.aborted) throw abortError();
    const parsed = request;
    const maxRows = clampInteger(parsed.maxRows ?? this.#options.maxRows, 1, this.#options.maxRows);
    const timeoutMs = clampInteger(parsed.timeoutMs ?? this.#options.statementTimeoutMs, 250, this.#options.statementTimeoutMs);
    const allowedSchemas = await this.#getAllowedSchemas(signal);
    const knownRelations = this.#catalog ? catalogRelations(this.#catalog) : undefined;
    const normalizedSql = validateReadOnlySql(parsed.sql, {
      allowedSchemas,
      knownRelations,
      allowedFunctions: this.#options.allowedFunctions,
    });
    const wrappedSql = `SELECT * FROM (${normalizedSql}) AS __data_elements_result LIMIT ${maxRows + 1}`;
    const parameters = parsed.parameters ?? [];
    const startedAt = performance.now();
    const result = await this.#withReadOnlyTransaction(signal, async (client) => (
      client.query<any[]>({ text: wrappedSql, values: parameters, rowMode: "array" })
    ), timeoutMs, allowedSchemas);
    const rows = result.rows.slice(0, maxRows);
    const columns = uniqueColumnNames(result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeId: dataTypeID })));
    return {
      queryId: randomUUID(),
      columns,
      rows: rows.map((row) => Object.fromEntries(columns.map((column, index) => [column.name, toJsonValue(row[index])]))),
      rowCount: rows.length,
      truncated: result.rows.length > maxRows,
      durationMs: roundDuration(performance.now() - startedAt),
    };
  }

  /**
   * Executes a compiler-produced mutation plan. It is deliberately separate
   * from `query()`: read paths retain their AST policy and read-only
   * transaction semantics.
   */
  async mutate(
    request: DatabaseMutationRequest,
    signal?: AbortSignal,
  ): Promise<DatabaseMutationResult> {
    if (signal?.aborted) throw abortError();
    const parsed = databaseMutationRequestSchema.parse(request);
    validateDatabaseMutationPlan(parsed.plan);
    const timeoutMs = clampInteger(
      parsed.timeoutMs ?? this.#options.statementTimeoutMs,
      250,
      this.#options.statementTimeoutMs,
    );
    const allowedSchemas = await this.#getAllowedSchemas(signal);
    assertMutationPlanMatchesConnector(parsed, this.id, allowedSchemas, this.#catalog);

    const startedAt = performance.now();
    const result = await this.#withMutationTransaction(
      signal,
      async (client) => {
        const queryResult = await client.query<unknown[]>({
          text: parsed.plan.compiled.sql,
          values: parsed.plan.compiled.parameters,
          rowMode: "array",
        });
        const affectedRows = queryResult.rowCount ?? 0;
        const maxAffectedRows = parsed.plan.maxAffectedRows;
        if (maxAffectedRows !== undefined && affectedRows > maxAffectedRows) {
          throw new DatabaseMutationLimitError(maxAffectedRows, affectedRows);
        }
        const columns = uniqueColumnNames(
          queryResult.fields.map(({ name, dataTypeID }) => ({
            name,
            dataTypeId: dataTypeID,
          })),
        );
        return {
          affectedRows,
          columns,
          rows: queryResult.rows.map((row) => Object.fromEntries(
            columns.map((column, index) => [column.name, toJsonValue(row[index])]),
          )),
        };
      },
      timeoutMs,
      allowedSchemas,
    );

    return databaseMutationResultSchema.parse({
      mutationId: parsed.mutationId,
      queryId: randomUUID(),
      ...result,
      truncated: false,
      durationMs: roundDuration(performance.now() - startedAt),
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #getAllowedSchemas(signal?: AbortSignal): Promise<string[]> {
    if (this.#options.schemas) return [...this.#options.schemas];
    return [...await this.#schemaCache.get(signal)];
  }

  async #withReadOnlyTransaction<T>(
    signal: AbortSignal | undefined,
    operation: (client: PoolClient) => Promise<T>,
    statementTimeoutMs = this.#options.statementTimeoutMs,
    schemas: readonly string[] = this.#options.schemas ?? [],
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    const client = await this.#pool.connect();
    let released = false;
    const releaseOnAbort = () => {
      if (released) return;
      released = true;
      client.release(true);
    };
    signal?.addEventListener("abort", releaseOnAbort, { once: true });
    try {
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${this.#options.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.#options.idleTransactionTimeoutMs}ms'`);
      if (schemas.length > 0) {
        await client.query(`SET LOCAL search_path = ${schemas.map(quoteIdentifier).join(", ")}, pg_catalog`);
      }
      if (signal?.aborted) throw abortError();
      const result = await operation(client);
      if (signal?.aborted) throw abortError();
      return result;
    } finally {
      signal?.removeEventListener("abort", releaseOnAbort);
      if (!released) {
        try {
          await client.query("ROLLBACK");
        } finally {
          released = true;
          client.release();
        }
      }
    }
  }

  async #withMutationTransaction<T>(
    signal: AbortSignal | undefined,
    operation: (client: PoolClient) => Promise<T>,
    statementTimeoutMs: number,
    schemas: readonly string[],
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    const client = await this.#pool.connect();
    let released = false;
    let committed = false;
    const releaseOnAbort = () => {
      if (released) return;
      released = true;
      client.release(true);
    };
    signal?.addEventListener("abort", releaseOnAbort, { once: true });
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${this.#options.lockTimeoutMs}ms'`);
      await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${this.#options.idleTransactionTimeoutMs}ms'`);
      if (schemas.length > 0) {
        await client.query(`SET LOCAL search_path = ${schemas.map(quoteIdentifier).join(", ")}, pg_catalog`);
      }
      if (signal?.aborted) throw abortError();
      const result = await operation(client);
      if (signal?.aborted) throw abortError();
      await client.query("COMMIT");
      committed = true;
      return result;
    } finally {
      signal?.removeEventListener("abort", releaseOnAbort);
      if (!released) {
        try {
          if (!committed) await client.query("ROLLBACK");
        } finally {
          released = true;
          client.release();
        }
      }
    }
  }
}

export class DatabaseMutationLimitError extends Error {
  readonly code = "affected_row_limit_exceeded";

  constructor(
    readonly maxAffectedRows: number,
    readonly affectedRows: number,
  ) {
    super(`The mutation affected ${affectedRows} rows, above its limit of ${maxAffectedRows}.`);
    this.name = "DatabaseMutationLimitError";
  }
}

function assertMutationPlanMatchesConnector(
  request: DatabaseMutationRequest,
  connectorId: string,
  allowedSchemas: readonly string[],
  catalog: DatabaseCatalog | undefined,
): void {
  const { plan } = request;
  if (plan.action.connectionRef !== connectorId) {
    throw new Error("The mutation connection does not match this connector.");
  }
  if (plan.statementClass !== classifyDatabaseAction(plan.action).statementClass) {
    throw new Error("The mutation statement class does not match its typed action.");
  }
  for (const relation of mutationRelations(plan.action)) {
    if (!allowedSchemas.includes(relation.schema)) {
      throw new Error(`Schema "${relation.schema}" is not available to this connector.`);
    }
  }
  if (catalog && plan.catalogFingerprint !== catalog.fingerprint) {
    throw new Error("The mutation catalog binding is stale.");
  }
  if (catalog && plan.action.databaseRef !== catalog.databaseName) {
    throw new Error("The mutation database does not match the catalog.");
  }
  if (catalog && !mutationRelationExists(plan.action, catalog)) {
    throw new Error(`Relation "${plan.action.relation.schema}.${plan.action.relation.table}" is not present in the catalog.`);
  }
}

function mutationRelations(
  action: DatabaseMutationRequest["plan"]["action"],
): readonly DatabaseMutationRequest["plan"]["action"]["relation"][] {
  if (action.kind === "data.ddl" && action.operation.kind === "rename-table") {
    return [action.relation, action.operation.to];
  }
  return [action.relation];
}

function mutationRelationExists(
  action: DatabaseMutationRequest["plan"]["action"],
  catalog: DatabaseCatalog,
): boolean {
  const exists = catalog.schemas.some((schema) => schema.name === action.relation.schema
    && schema.tables.some((table) => table.name === action.relation.table));
  if (exists) return true;
  return action.kind === "data.ddl" && action.operation.kind === "create-table";
}

async function queryTables(client: PoolClient, schemas: readonly string[], maxTables: number | undefined): Promise<TableRow[]> {
  const result = await client.query<TableRow>({
    text: `
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS table_name,
        relation.relkind AS relation_kind,
        obj_description(relation.oid, 'pg_class') AS comment,
        GREATEST(relation.reltuples, 0)::bigint AS estimated_rows
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = ANY($1::text[])
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(relation.oid, 'SELECT')
      ORDER BY namespace.nspname, relation.relname
      ${catalogLimitSql(maxTables)}
    `,
    values: catalogQueryValues(schemas, maxTables),
  });
  return result.rows;
}

async function queryColumns(client: PoolClient, schemas: readonly string[], maxTables: number | undefined): Promise<ColumnRow[]> {
  const result = await client.query<ColumnRow>({
    text: `
      WITH selected_relations AS (
        SELECT relation.oid, namespace.nspname, relation.relname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ANY($1::text[])
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(relation.oid, 'SELECT')
        ORDER BY namespace.nspname, relation.relname
        ${catalogLimitSql(maxTables)}
      )
      SELECT
        selected_relations.nspname AS schema_name,
        selected_relations.relname AS table_name,
        attribute.attname AS column_name,
        attribute.attnum AS ordinal,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
        NOT attribute.attnotnull AS nullable,
        pg_get_expr(default_value.adbin, default_value.adrelid) AS default_value,
        col_description(selected_relations.oid, attribute.attnum) AS comment
      FROM selected_relations
      JOIN pg_attribute attribute ON attribute.attrelid = selected_relations.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      WHERE attribute.attnum > 0 AND NOT attribute.attisdropped
      ORDER BY selected_relations.nspname, selected_relations.relname, attribute.attnum
    `,
    values: catalogQueryValues(schemas, maxTables),
  });
  return result.rows;
}

async function queryPrimaryKeys(client: PoolClient, schemas: readonly string[], maxTables: number | undefined): Promise<PrimaryKeyRow[]> {
  const result = await client.query<PrimaryKeyRow>({
    text: `
      WITH selected_relations AS (
        SELECT relation.oid, namespace.nspname, relation.relname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ANY($1::text[])
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(relation.oid, 'SELECT')
        ORDER BY namespace.nspname, relation.relname
        ${catalogLimitSql(maxTables)}
      )
      SELECT
        selected_relations.nspname AS schema_name,
        selected_relations.relname AS table_name,
        array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS columns
      FROM selected_relations
      JOIN pg_constraint key_constraint
        ON key_constraint.conrelid = selected_relations.oid AND key_constraint.contype = 'p'
      JOIN unnest(key_constraint.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = selected_relations.oid AND attribute.attnum = key_column.attnum
      GROUP BY selected_relations.nspname, selected_relations.relname
    `,
    values: catalogQueryValues(schemas, maxTables),
  });
  return result.rows;
}

async function queryForeignKeys(client: PoolClient, schemas: readonly string[], maxTables: number | undefined): Promise<ForeignKeyRow[]> {
  const result = await client.query<ForeignKeyRow>({
    text: `
      WITH selected_relations AS (
        SELECT relation.oid, namespace.nspname, relation.relname
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = ANY($1::text[])
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege(relation.oid, 'SELECT')
        ORDER BY namespace.nspname, relation.relname
        ${catalogLimitSql(maxTables)}
      )
      SELECT
        source_namespace.nspname AS schema_name,
        source_relation.relname AS table_name,
        key_constraint.conname AS constraint_name,
        array_agg(source_attribute.attname::text ORDER BY source_key.ordinality) AS columns,
        target_namespace.nspname AS referenced_schema,
        target_relation.relname AS referenced_table,
        array_agg(target_attribute.attname::text ORDER BY target_key.ordinality) AS referenced_columns
      FROM pg_constraint key_constraint
      JOIN selected_relations selected ON selected.oid = key_constraint.conrelid
      JOIN pg_class source_relation ON source_relation.oid = key_constraint.conrelid
      JOIN pg_namespace source_namespace ON source_namespace.oid = source_relation.relnamespace
      JOIN pg_class target_relation ON target_relation.oid = key_constraint.confrelid
      JOIN pg_namespace target_namespace ON target_namespace.oid = target_relation.relnamespace
      JOIN unnest(key_constraint.conkey) WITH ORDINALITY AS source_key(attnum, ordinality) ON true
      JOIN unnest(key_constraint.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
        ON target_key.ordinality = source_key.ordinality
      JOIN pg_attribute source_attribute ON source_attribute.attrelid = source_relation.oid AND source_attribute.attnum = source_key.attnum
      JOIN pg_attribute target_attribute ON target_attribute.attrelid = target_relation.oid AND target_attribute.attnum = target_key.attnum
      WHERE key_constraint.contype = 'f'
      GROUP BY source_namespace.nspname, source_relation.relname, key_constraint.conname, target_namespace.nspname, target_relation.relname
      ORDER BY source_namespace.nspname, source_relation.relname, key_constraint.conname
    `,
    values: catalogQueryValues(schemas, maxTables),
  });
  return result.rows;
}

async function queryDatabaseName(client: PoolClient): Promise<string> {
  const result = await client.query<{ database_name: string }>("SELECT current_database() AS database_name");
  return result.rows[0]?.database_name ?? "postgres";
}

function assembleCatalog(
  tableRows: readonly TableRow[],
  columnRows: readonly ColumnRow[],
  primaryKeyRows: readonly PrimaryKeyRow[],
  foreignKeyRows: readonly ForeignKeyRow[],
  includeComments: boolean,
): DatabaseSchema[] {
  const columns = new Map<string, ColumnRow[]>();
  const primaryKeys = new Map(primaryKeyRows.flatMap((row) => {
    const columns = catalogIdentifierArray(row.columns);
    return columns === undefined ? [] : [[tableKey(row.schema_name, row.table_name), columns] as const];
  }));
  const foreignKeys = new Map<string, ForeignKeyRow[]>();
  for (const row of columnRows) append(columns, tableKey(row.schema_name, row.table_name), row);
  for (const row of foreignKeyRows) append(foreignKeys, tableKey(row.schema_name, row.table_name), row);

  const schemas = new Map<string, DatabaseTable[]>();
  for (const row of tableRows) {
    const key = tableKey(row.schema_name, row.table_name);
    const table: DatabaseTable = {
      schema: row.schema_name,
      name: row.table_name,
      kind: relationKind(row.relation_kind),
      ...(includeComments && row.comment ? { comment: row.comment } : {}),
      ...(row.estimated_rows === null ? {} : { estimatedRows: asNumber(row.estimated_rows) }),
      columns: (columns.get(key) ?? []).map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        nullable: column.nullable,
        ordinal: column.ordinal,
        ...(column.default_value ? { defaultValue: column.default_value } : {}),
        ...(includeComments && column.comment ? { comment: column.comment } : {}),
      })),
      primaryKey: primaryKeys.get(key) ?? [],
      foreignKeys: (foreignKeys.get(key) ?? []).flatMap((foreignKey) => {
        const foreignKeyColumns = catalogIdentifierArray(foreignKey.columns);
        const referencedColumns = catalogIdentifierArray(foreignKey.referenced_columns);
        // A constraint wider than the catalog contract cannot be faithfully
        // represented. Omit it rather than publishing a truncated relation.
        if (foreignKeyColumns === undefined
          || referencedColumns === undefined
          || foreignKeyColumns.length !== referencedColumns.length) {
          return [];
        }
        return [{
          name: foreignKey.constraint_name,
          columns: foreignKeyColumns,
          referencedSchema: foreignKey.referenced_schema,
          referencedTable: foreignKey.referenced_table,
          referencedColumns,
        }];
      }),
    };
    append(schemas, row.schema_name, table);
  }
  return [...schemas.entries()].map(([name, tables]) => ({ name, tables }));
}

function catalogRelations(catalog: DatabaseCatalog): KnownRelation[] {
  return catalog.schemas.flatMap((schema) => schema.tables.map((table) => ({ schema: table.schema, name: table.name })));
}

function relationKind(value: string): DatabaseTable["kind"] {
  switch (value) {
    case "p": return "partitioned-table";
    case "v": return "view";
    case "m": return "materialized-view";
    case "f": return "foreign-table";
    default: return "table";
  }
}

function uniqueColumnNames(columns: Array<{ name: string; dataTypeId?: number }>) {
  const counts = new Map<string, number>();
  return columns.map((column) => {
    const count = (counts.get(column.name) ?? 0) + 1;
    counts.set(column.name, count);
    return { ...column, name: count === 1 ? column.name : `${column.name}_${count}` };
  });
}

/** Normalizes driver arrays before they enter the bounded public catalog. */
function catalogIdentifierArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const identifiers = value.map((item) => typeof item === "string" ? item.trim() : "");
  return identifiers.every((identifier) => identifier.length > 0 && identifier.length <= 256)
    ? identifiers
    : undefined;
}

function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary:${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}

function normalizeSchemas(schemas: readonly string[]): string[] {
  const normalized = [...new Set(schemas.map(normalizeIdentifier).filter(Boolean))];
  if (normalized.some((schema) => schema.startsWith("pg_") || schema === "information_schema")) {
    throw new Error("System schemas cannot be exposed through the Data Agent.");
  }
  return normalized;
}

function normalizeMaxTables(value: number | undefined): number | undefined {
  return value === undefined ? undefined : clampInteger(value, 1, 100_000);
}

function catalogLimitSql(maxTables: number | undefined): string {
  return maxTables === undefined ? "" : "LIMIT $2";
}

function catalogQueryValues(schemas: readonly string[], maxTables: number | undefined): readonly unknown[] {
  return maxTables === undefined ? [schemas] : [schemas, maxTables];
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function validatePostgresUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PostgreSQL connectionString must be a valid URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PostgreSQL connectionString must use postgres:// or postgresql://.");
  }
  return url;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const items = map.get(key) ?? [];
  items.push(value);
  map.set(key, items);
}

function tableKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

function asNumber(value: number | string): number {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : 0;
}

function roundDuration(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

function abortError(): DOMException {
  return new DOMException("The database operation was cancelled.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
