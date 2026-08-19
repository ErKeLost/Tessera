import {
  classifyDatabaseAction,
  databaseMutationRequestSchema,
  databaseMutationResultSchema,
  createAbortResilientAsyncCache,
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
import {
  createPool,
  type FieldPacket,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
} from "mysql2/promise";
import {
  MySqlQueryPolicyError,
  validateReadOnlySql,
  type KnownRelation,
} from "./sql-policy";

export { MySqlQueryPolicyError, validateReadOnlySql } from "./sql-policy";
export type { KnownRelation, ReadOnlySqlPolicy } from "./sql-policy";

export type MySqlConnectorOptions = {
  connectionString: string;
  id?: string;
  schemas?: readonly string[];
  maxConnections?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  allowedFunctions?: readonly string[];
};

type NormalizedOptions = Required<
  Omit<MySqlConnectorOptions, "schemas" | "allowedFunctions" | "id">
> & {
  id: string;
  schemas?: readonly string[];
  allowedFunctions: readonly string[];
};

type TableRow = {
  schema_name: string;
  table_name: string;
  table_type: string;
  comment: string | null;
  estimated_rows: number | string | null;
};

type ColumnRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
  ordinal: number;
  data_type: string;
  nullable: boolean | number;
  default_value: string | null;
  comment: string | null;
};

type PrimaryKeyRow = {
  schema_name: string;
  table_name: string;
  column_name: string;
  ordinal: number;
};

type ForeignKeyRow = {
  schema_name: string;
  table_name: string;
  constraint_name: string;
  column_name: string;
  ordinal: number;
  referenced_schema: string;
  referenced_table: string;
  referenced_column: string;
};

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONNECTIONS = 4;

export function createMySqlConnector(
  options: MySqlConnectorOptions,
): MySqlConnector {
  return new MySqlConnector(options);
}

export class MySqlConnector implements DatabaseConnector, DatabaseMutationExecutor {
  readonly dialect = "mysql" as const;
  readonly id: string;
  readonly #options: NormalizedOptions;
  readonly #pool: Pool;
  readonly #schemaCache: AbortResilientAsyncCache<readonly string[]>;
  #catalog: DatabaseCatalog | undefined;

  constructor(options: MySqlConnectorOptions) {
    const parsedUrl = validateMySqlUrl(options.connectionString);
    this.id = options.id?.trim() || `mysql:${parsedUrl.hostname || "local"}`;
    this.#options = {
      connectionString: options.connectionString,
      id: this.id,
      maxConnections: clampInteger(
        options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
        1,
        20,
      ),
      maxRows: clampInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 10_000),
      statementTimeoutMs: clampInteger(
        options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
        250,
        120_000,
      ),
      ...(options.schemas?.length
        ? { schemas: normalizeSchemas(options.schemas) }
        : {}),
      allowedFunctions: [
        ...new Set((options.allowedFunctions ?? []).map(normalizeIdentifier)),
      ],
    };
    this.#pool = createPool({
      uri: this.#options.connectionString,
      connectionLimit: this.#options.maxConnections,
      connectTimeout: this.#options.statementTimeoutMs,
      enableKeepAlive: true,
    });
    this.#schemaCache = createAbortResilientAsyncCache(async () => {
      const rows = await this.#withReadOnlyTransaction(
        undefined,
        async (client) => queryRows<{ schema_name: string }>(client, `
          SELECT DISTINCT table_schema AS schema_name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
            AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema
        `),
      );
      return rows.map(({ schema_name }) => schema_name.trim()).filter(Boolean);
    });
  }

  async assess(signal?: AbortSignal): Promise<ConnectionAssessment> {
    const startedAt = performance.now();
    const url = validateMySqlUrl(this.#options.connectionString);
    try {
      const assessment = await this.#withReadOnlyTransaction(
        signal,
        async (client) => {
          const rows = await queryRows<{
            database_name: string | null;
            server_version: string;
            credential_can_write: boolean | number;
          }>(
            client,
            `
          SELECT
            DATABASE() AS database_name,
            VERSION() AS server_version,
            (
              EXISTS (
                SELECT 1
                FROM information_schema.schema_privileges privileges
                WHERE privileges.grantee = CURRENT_USER()
                  AND privileges.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX')
              )
              OR EXISTS (
                SELECT 1
                FROM information_schema.table_privileges privileges
                WHERE privileges.grantee = CURRENT_USER()
                  AND privileges.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX')
              )
            ) AS credential_can_write
        `,
          );
          return rows[0];
        },
      );
      if (!assessment)
        throw new Error("MySQL did not return a connection assessment.");
      const databaseName =
        assessment.database_name ?? this.#options.schemas?.[0];
      const credentialCanWrite = Boolean(assessment.credential_can_write);
      return {
        connectorId: this.id,
        dialect: "mysql",
        connected: true,
        ...(databaseName ? { databaseName } : {}),
        host: url.hostname || undefined,
        serverVersion: assessment.server_version,
        readOnlyTransactions: true,
        credentialCanWrite,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: credentialCanWrite
          ? [
              "The credential appears to have write privileges. Studio still uses read-only transactions, but a dedicated read-only role is recommended.",
            ]
          : [],
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return {
        connectorId: this.id,
        dialect: "mysql",
        connected: false,
        host: url.hostname || undefined,
        readOnlyTransactions: true,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: [
          "MySQL could not be reached with the configured connection.",
        ],
      };
    }
  }

  async introspect(
    options: CatalogIntrospectionOptions = {},
    signal?: AbortSignal,
  ): Promise<DatabaseCatalog> {
    const allowedSchemas = await this.#getAllowedSchemas(signal);
    const schemas = options.schemas?.length
      ? normalizeSchemas(options.schemas).filter((schema) =>
          allowedSchemas.includes(schema),
        )
      : allowedSchemas;
    if (schemas.length === 0)
      throw new Error("No MySQL schemas are available to this connection.");
    // The default administrator path discovers every readable relation. A
    // table bound is an explicit host policy, never an implicit first-500
    // slice that makes valid relations appear absent to the Data Agent.
    const maxTables = normalizeMaxTables(options.maxTables);

    const result = await this.#withReadOnlyTransaction(
      signal,
      async (client) => {
        const tableRows = await queryTables(client, schemas, maxTables);
        const [columnRows, primaryKeyRows, foreignKeyRows, databaseName] =
          await Promise.all([
            queryColumns(client, schemas, maxTables),
            queryPrimaryKeys(client, schemas, maxTables),
            queryForeignKeys(client, schemas, maxTables),
            queryDatabaseName(client),
          ]);
        return {
          tableRows,
          columnRows,
          primaryKeyRows,
          foreignKeyRows,
          databaseName,
        };
      },
    );
    const databaseName = result.databaseName || schemas[0];
    if (!databaseName) throw new Error("MySQL did not select a database.");

    const catalog = finalizeCatalog({
      connectorId: this.id,
      dialect: "mysql",
      databaseName,
      scannedAt: new Date().toISOString(),
      schemas: assembleCatalog(
        result.tableRows,
        result.columnRows,
        result.primaryKeyRows,
        result.foreignKeyRows,
        options.includeComments ?? false,
      ),
    });
    this.#catalog = catalog;
    return catalog;
  }

  async query(
    request: DatabaseQueryRequest,
    signal?: AbortSignal,
  ): Promise<DatabaseQueryResult> {
    if (signal?.aborted) throw abortError();
    const maxRows = clampInteger(
      request.maxRows ?? this.#options.maxRows,
      1,
      this.#options.maxRows,
    );
    const timeoutMs = clampInteger(
      request.timeoutMs ?? this.#options.statementTimeoutMs,
      250,
      this.#options.statementTimeoutMs,
    );
    const allowedSchemas = await this.#getAllowedSchemas(signal);
    const knownRelations = this.#catalog
      ? catalogRelations(this.#catalog)
      : undefined;
    const normalizedSql = validateReadOnlySql(request.sql, {
      allowedSchemas,
      knownRelations,
      allowedFunctions: this.#options.allowedFunctions,
    });
    const wrappedSql = `SELECT * FROM (${normalizedSql}) AS \`__data_elements_result\` LIMIT ${maxRows + 1}`;
    const parameters = request.parameters ?? [];
    const startedAt = performance.now();
    const result = await this.#withReadOnlyTransaction(
      signal,
      async (client) => {
        const [rows, fields] = (await client.query(wrappedSql, parameters)) as unknown as [
          Array<Record<string, unknown>>,
          FieldPacket[],
        ];
        if (!Array.isArray(rows))
          throw new Error("MySQL returned an unexpected query result.");
        return { rows, fields };
      },
      timeoutMs,
    );
    const rows = result.rows.slice(0, maxRows);
    const columns = uniqueColumnNames(
      result.fields.map(({ name, columnType }) => ({
        name,
        dataTypeId: columnType,
      })),
    );
    return {
      queryId: randomUUID(),
      columns,
      rows: rows.map((row) =>
        Object.fromEntries(
          columns.map((column) => [column.name, toJsonValue(row[column.name])]),
        ),
      ),
      rowCount: rows.length,
      truncated: result.rows.length > maxRows,
      durationMs: roundDuration(performance.now() - startedAt),
    };
  }

  /** Executes a server-compiled, parameterized mutation in a write transaction. */
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
        const [rawResult, fields] = await client.execute(
          { sql: parsed.plan.compiled.sql, values: parsed.plan.compiled.parameters, timeout: timeoutMs },
        ) as unknown as [ResultSetHeader | Array<Record<string, unknown>>, FieldPacket[]];
        const rows = Array.isArray(rawResult) ? rawResult : [];
        const header = Array.isArray(rawResult)
          ? undefined
          : rawResult;
        const affectedRows = header?.affectedRows ?? rows.length;
        const maxAffectedRows = parsed.plan.maxAffectedRows;
        if (maxAffectedRows !== undefined && affectedRows > maxAffectedRows) {
          throw new DatabaseMutationLimitError(maxAffectedRows, affectedRows);
        }
        const columns = uniqueColumnNames(
          fields.map(({ name, columnType }) => ({ name, dataTypeId: columnType })),
        );
        return {
          affectedRows,
          columns,
          rows: rows.map((row) => Object.fromEntries(
            columns.map((column) => [column.name, toJsonValue(row[column.name])]),
          )),
        };
      },
      timeoutMs,
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
    operation: (client: PoolConnection) => Promise<T>,
    statementTimeoutMs = this.#options.statementTimeoutMs,
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    const client = await this.#pool.getConnection();
    let released = false;
    const releaseOnAbort = () => {
      if (released) return;
      released = true;
      client.destroy();
    };
    signal?.addEventListener("abort", releaseOnAbort, { once: true });
    try {
      await client.query(
        `SET SESSION MAX_EXECUTION_TIME = ${statementTimeoutMs}`,
      );
      await client.query("START TRANSACTION READ ONLY");
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
          try {
            await client.query("SET SESSION MAX_EXECUTION_TIME = DEFAULT");
          } finally {
            released = true;
            client.release();
          }
        }
      }
    }
  }

  async #withMutationTransaction<T>(
    signal: AbortSignal | undefined,
    operation: (client: PoolConnection) => Promise<T>,
    statementTimeoutMs: number,
  ): Promise<T> {
    if (signal?.aborted) throw abortError();
    const client = await this.#pool.getConnection();
    let released = false;
    let committed = false;
    const releaseOnAbort = () => {
      if (released) return;
      released = true;
      client.destroy();
    };
    signal?.addEventListener("abort", releaseOnAbort, { once: true });
    try {
      await client.query(`SET SESSION MAX_EXECUTION_TIME = ${statementTimeoutMs}`);
      await client.beginTransaction();
      if (signal?.aborted) throw abortError();
      const result = await operation(client);
      if (signal?.aborted) throw abortError();
      await client.commit();
      committed = true;
      return result;
    } finally {
      signal?.removeEventListener("abort", releaseOnAbort);
      if (!released) {
        try {
          if (!committed) await client.rollback();
        } finally {
          try {
            await client.query("SET SESSION MAX_EXECUTION_TIME = DEFAULT");
          } finally {
            released = true;
            client.release();
          }
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

async function queryTables(
  client: PoolConnection,
  schemas: readonly string[],
  maxTables: number | undefined,
): Promise<TableRow[]> {
  return queryRows<TableRow>(
    client,
    `
    SELECT
      table_schema AS schema_name,
      table_name,
      table_type,
      table_comment AS comment,
      table_rows AS estimated_rows
    FROM information_schema.tables
    WHERE table_schema IN (?)
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_name
    ${catalogLimitSql(maxTables)}
  `,
    catalogQueryValues(schemas, maxTables),
  );
}

function selectedRelationsSql(maxTables: number | undefined): string {
  return `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema IN (?)
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_schema, table_name
    ${catalogLimitSql(maxTables)}
  `;
}

async function queryColumns(
  client: PoolConnection,
  schemas: readonly string[],
  maxTables: number | undefined,
): Promise<ColumnRow[]> {
  return queryRows<ColumnRow>(
    client,
    `
    SELECT
      column_info.table_schema AS schema_name,
      column_info.table_name,
      column_info.column_name,
      column_info.ordinal_position AS ordinal,
      column_info.column_type AS data_type,
      column_info.is_nullable = 'YES' AS nullable,
      column_info.column_default AS default_value,
      column_info.column_comment AS comment
    FROM information_schema.columns column_info
    JOIN (${selectedRelationsSql(maxTables)}) selected
      ON selected.table_schema = column_info.table_schema
     AND selected.table_name = column_info.table_name
    ORDER BY column_info.table_schema, column_info.table_name, column_info.ordinal_position
  `,
    catalogQueryValues(schemas, maxTables),
  );
}

async function queryPrimaryKeys(
  client: PoolConnection,
  schemas: readonly string[],
  maxTables: number | undefined,
): Promise<PrimaryKeyRow[]> {
  return queryRows<PrimaryKeyRow>(
    client,
    `
    SELECT
      key_info.table_schema AS schema_name,
      key_info.table_name,
      key_info.column_name,
      key_info.seq_in_index AS ordinal
    FROM information_schema.statistics key_info
    JOIN (${selectedRelationsSql(maxTables)}) selected
      ON selected.table_schema = key_info.table_schema
     AND selected.table_name = key_info.table_name
    WHERE key_info.index_name = 'PRIMARY'
    ORDER BY key_info.table_schema, key_info.table_name, key_info.seq_in_index
  `,
    catalogQueryValues(schemas, maxTables),
  );
}

async function queryForeignKeys(
  client: PoolConnection,
  schemas: readonly string[],
  maxTables: number | undefined,
): Promise<ForeignKeyRow[]> {
  return queryRows<ForeignKeyRow>(
    client,
    `
    SELECT
      key_info.table_schema AS schema_name,
      key_info.table_name,
      key_info.constraint_name,
      key_info.column_name,
      key_info.ordinal_position AS ordinal,
      key_info.referenced_table_schema AS referenced_schema,
      key_info.referenced_table_name AS referenced_table,
      key_info.referenced_column_name AS referenced_column
    FROM information_schema.key_column_usage key_info
    JOIN (${selectedRelationsSql(maxTables)}) selected
      ON selected.table_schema = key_info.table_schema
     AND selected.table_name = key_info.table_name
    WHERE key_info.referenced_table_name IS NOT NULL
    ORDER BY key_info.table_schema, key_info.table_name, key_info.constraint_name, key_info.ordinal_position
  `,
    catalogQueryValues(schemas, maxTables),
  );
}

async function queryDatabaseName(client: PoolConnection): Promise<string> {
  const rows = await queryRows<{ database_name: string | null }>(
    client,
    "SELECT DATABASE() AS database_name",
  );
  return rows[0]?.database_name ?? "";
}

async function queryRows<T extends Record<string, unknown>>(
  client: PoolConnection,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const [rows] = await client.query(sql, values as unknown[]);
  if (!Array.isArray(rows))
    throw new Error("MySQL returned an unexpected result shape.");
  return rows as T[];
}

function assembleCatalog(
  tableRows: readonly TableRow[],
  columnRows: readonly ColumnRow[],
  primaryKeyRows: readonly PrimaryKeyRow[],
  foreignKeyRows: readonly ForeignKeyRow[],
  includeComments: boolean,
): DatabaseSchema[] {
  const columns = new Map<string, ColumnRow[]>();
  const primaryKeys = new Map<string, string[]>();
  const foreignKeys = new Map<string, ForeignKeyRow[]>();
  for (const row of columnRows)
    append(columns, tableKey(row.schema_name, row.table_name), row);
  for (const row of primaryKeyRows)
    append(
      primaryKeys,
      tableKey(row.schema_name, row.table_name),
      row.column_name,
    );
  for (const row of foreignKeyRows)
    append(foreignKeys, tableKey(row.schema_name, row.table_name), row);

  const schemas = new Map<string, DatabaseTable[]>();
  for (const row of tableRows) {
    const key = tableKey(row.schema_name, row.table_name);
    const table: DatabaseTable = {
      schema: row.schema_name,
      name: row.table_name,
      kind: row.table_type === "VIEW" ? "view" : "table",
      ...(includeComments && row.comment ? { comment: row.comment } : {}),
      ...(row.estimated_rows === null
        ? {}
        : { estimatedRows: asNumber(row.estimated_rows) }),
      columns: (columns.get(key) ?? []).map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        nullable: Boolean(column.nullable),
        ordinal: asNumber(column.ordinal),
        ...(column.default_value ? { defaultValue: column.default_value } : {}),
        ...(includeComments && column.comment
          ? { comment: column.comment }
          : {}),
      })),
      primaryKey: primaryKeys.get(key) ?? [],
      foreignKeys: assembleForeignKeys(foreignKeys.get(key) ?? []),
    };
    append(schemas, row.schema_name, table);
  }
  return [...schemas.entries()].map(([name, tables]) => ({ name, tables }));
}

function assembleForeignKeys(
  rows: readonly ForeignKeyRow[],
): DatabaseTable["foreignKeys"] {
  const keys = new Map<string, ForeignKeyRow[]>();
  for (const row of rows) append(keys, row.constraint_name, row);
  return [...keys.entries()].map(([name, parts]) => ({
    name,
    columns: parts.map((part) => part.column_name),
    referencedSchema: parts[0]?.referenced_schema ?? "",
    referencedTable: parts[0]?.referenced_table ?? "",
    referencedColumns: parts.map((part) => part.referenced_column),
  }));
}

function catalogRelations(catalog: DatabaseCatalog): KnownRelation[] {
  return catalog.schemas.flatMap((schema) =>
    schema.tables.map((table) => ({ schema: table.schema, name: table.name })),
  );
}

function uniqueColumnNames(
  columns: Array<{ name: string; dataTypeId?: number }>,
) {
  const counts = new Map<string, number>();
  return columns.map((column) => {
    const count = (counts.get(column.name) ?? 0) + 1;
    counts.set(column.name, count);
    return {
      ...column,
      name: count === 1 ? column.name : `${column.name}_${count}`,
    };
  });
}

function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonValue(item),
      ]),
    );
  }
  return String(value);
}

function normalizeSchemas(schemas: readonly string[]): string[] {
  const normalized = [
    ...new Set(schemas.map((schema) => schema.trim()).filter(Boolean)),
  ];
  if (
    normalized.some((schema) => isSystemSchema(normalizeIdentifier(schema)))
  ) {
    throw new Error("System schemas cannot be exposed through the Data Agent.");
  }
  return normalized;
}

function normalizeMaxTables(value: number | undefined): number | undefined {
  return value === undefined ? undefined : clampInteger(value, 1, 100_000);
}

function catalogLimitSql(maxTables: number | undefined): string {
  return maxTables === undefined ? "" : "LIMIT ?";
}

function catalogQueryValues(schemas: readonly string[], maxTables: number | undefined): readonly unknown[] {
  return maxTables === undefined ? [schemas] : [schemas, maxTables];
}

function isSystemSchema(schema: string): boolean {
  return (
    schema === "information_schema" ||
    schema === "mysql" ||
    schema === "performance_schema" ||
    schema === "sys"
  );
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function validateMySqlUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MySQL connectionString must be a valid URL.");
  }
  if (url.protocol !== "mysql:") {
    throw new Error("MySQL connectionString must use mysql://.");
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
  return new DOMException(
    "The database operation was cancelled.",
    "AbortError",
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
