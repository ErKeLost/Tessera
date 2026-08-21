import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  finalizeCatalog,
  databaseCapabilitiesSchema,
  type CatalogIntrospectionOptions,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseCapabilities,
  type DatabaseConnector,
  type DatabaseDialect,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
  type DatabaseTable,
} from "@data-elements/database";
import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
  type Row,
  type Transaction,
} from "@libsql/client";
import {
  SqliteQueryPolicyError,
  validateReadOnlySql,
  type KnownRelation,
  type ReadOnlySqlPolicy,
} from "./sql-policy";

export {
  SqliteQueryPolicyError,
  validateReadOnlySql,
} from "./sql-policy";
export type { KnownRelation, ReadOnlySqlPolicy } from "./sql-policy";

export type SqliteConnectorOptions = Readonly<{
  connectionString: string;
  id?: string;
  schemas?: readonly string[];
  maxRows?: number;
  statementTimeoutMs?: number;
  allowedFunctions?: readonly string[];
}>;

export type LibSqlConnectorOptions = SqliteConnectorOptions & Readonly<{
  dialect: Extract<DatabaseDialect, "sqlite" | "turso">;
  authToken?: string;
}>;

type NormalizedOptions = Readonly<{
  connectionString: string;
  clientUrl: string;
  authToken?: string;
  id: string;
  maxRows: number;
  statementTimeoutMs: number;
  allowedFunctions: readonly string[];
  databaseName: string;
  host?: string;
}>;

type SchemaRow = {
  name: string;
  type: "table" | "view";
};

type ColumnRow = {
  cid: number | bigint;
  name: string;
  type: string;
  notnull: number | bigint;
  dflt_value: string | null;
  pk: number | bigint;
  hidden?: number | bigint;
};

type ForeignKeyRow = {
  id: number | bigint;
  seq: number | bigint;
  table: string;
  from: string;
  to: string;
};

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const SQLITE_SCHEMA = "main";

export function createSqliteConnector(options: SqliteConnectorOptions): LibSqlConnector {
  return new LibSqlConnector({ ...options, dialect: "sqlite" });
}

/**
 * Shared SQLite/libSQL connector used by local SQLite and remote Turso.
 * The public query surface accepts only parser-validated SELECT statements,
 * and every request executes inside a driver-level read transaction.
 */
export class LibSqlConnector implements DatabaseConnector {
  readonly dialect: Extract<DatabaseDialect, "sqlite" | "turso">;
  readonly id: string;
  readonly #options: NormalizedOptions;
  readonly #client: Client;
  #catalog: DatabaseCatalog | undefined;

  constructor(options: LibSqlConnectorOptions) {
    this.dialect = options.dialect;
    const connection = options.dialect === "sqlite"
      ? normalizeSqliteConnectionUrl(options.connectionString)
      : normalizeTursoConnectionUrl(options.connectionString);
    if (
      options.schemas?.length
      && !options.schemas.some((schema) => normalizeName(schema) === SQLITE_SCHEMA)
    ) {
      throw new Error("SQLite/libSQL exposes the main schema only.");
    }
    const host = connection.url.hostname || undefined;
    const databaseName = options.dialect === "sqlite"
      ? sqliteDatabaseName(connection.clientUrl)
      : host || "turso";
    this.id = options.id?.trim()
      || options.dialect + ":" + (host || databaseName);
    this.#options = {
      connectionString: options.connectionString,
      clientUrl: connection.clientUrl,
      ...(options.authToken?.trim() ? { authToken: options.authToken.trim() } : {}),
      id: this.id,
      maxRows: clampInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 10_000),
      statementTimeoutMs: clampInteger(
        options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
        250,
        120_000,
      ),
      allowedFunctions: [
        ...new Set((options.allowedFunctions ?? []).map(normalizeName)),
      ],
      databaseName,
      ...(host ? { host } : {}),
    };
    this.#client = createClient({
      url: this.#options.clientUrl,
      ...(this.#options.authToken ? { authToken: this.#options.authToken } : {}),
      intMode: "bigint",
      timeout: this.#options.statementTimeoutMs,
    });
  }

  async assess(signal?: AbortSignal): Promise<ConnectionAssessment> {
    const startedAt = performance.now();
    try {
      const result = await this.#withReadTransaction(
        (transaction) => transaction.execute("SELECT sqlite_version() AS version"),
        signal,
        this.#options.statementTimeoutMs,
      );
      const version = result.rows[0]?.version;
      return {
        connectorId: this.id,
        dialect: this.dialect,
        connected: true,
        databaseName: this.#options.databaseName,
        ...(this.#options.host ? { host: this.#options.host } : {}),
        ...(typeof version === "string" ? { serverVersion: version } : {}),
        readOnlyTransactions: true,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: [],
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return {
        connectorId: this.id,
        dialect: this.dialect,
        connected: false,
        ...(this.#options.host ? { host: this.#options.host } : {}),
        readOnlyTransactions: true,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: [
          this.dialect === "sqlite"
            ? "SQLite could not open the configured database."
            : "Turso could not be reached with the configured connection.",
        ],
      };
    }
  }

  async inspectCapabilities(signal?: AbortSignal): Promise<DatabaseCapabilities> {
    const result = await this.#withReadTransaction(async (transaction) => {
      const version = await transaction.execute("SELECT sqlite_version() AS version");
      let options: ResultSet | undefined;
      let optionWarning: string | undefined;
      try {
        options = await transaction.execute("PRAGMA compile_options");
      } catch {
        optionWarning = "SQLite compile-option metadata was not available.";
      }
      return {
        version: resultRows<{ version: string }>(version)[0]?.version,
        options: options ? resultRows<Record<string, unknown>>(options) : [],
        optionWarning,
      };
    }, signal, this.#options.statementTimeoutMs);
    if (!result.version) throw new Error("SQLite did not return a runtime version.");
    const version = result.version;
    const major = parseSqliteVersion(version);
    const compileOptions = result.options.flatMap((row) => Object.values(row)).filter((value): value is string => typeof value === "string");
    const hasOption = (name: string) => compileOptions.some((value) => value.toUpperCase().startsWith(name));
    const components: DatabaseCapabilities["components"] = [
      { id: `engine.${this.dialect}`, kind: "engine", status: "supported", version },
      { id: "sql.cte", kind: "feature", status: versionAtLeast(major, 3, 8, 3) ? "supported" : "unsupported" },
      { id: "sql.window_functions", kind: "feature", status: versionAtLeast(major, 3, 25, 0) ? "supported" : "unsupported" },
      { id: "module:fts5", kind: "module", status: hasOption("ENABLE_FTS5") ? "installed" : "unknown" },
      { id: "module:json1", kind: "module", status: hasOption("ENABLE_JSON1") || versionAtLeast(major, 3, 38, 0) ? "installed" : "unknown" },
    ];
    return databaseCapabilitiesSchema.parse({
      kind: "database-capabilities",
      connectorId: this.id,
      dialect: this.dialect,
      databaseName: this.#options.databaseName,
      availability: "available",
      serverVersion: version,
      components,
      truncated: false,
      warnings: result.optionWarning ? [result.optionWarning] : [],
    });
  }

  async introspect(
    options: CatalogIntrospectionOptions = {},
    signal?: AbortSignal,
  ): Promise<DatabaseCatalog> {
    if (
      options.schemas?.length
      && !options.schemas.some((schema) => normalizeName(schema) === SQLITE_SCHEMA)
    ) {
      throw new Error("SQLite/libSQL introspection is limited to the main schema.");
    }
    const maxTables = options.maxTables === undefined
      ? undefined
      : clampInteger(options.maxTables, 1, 100_000);
    const tables = await this.#withReadTransaction(async (transaction) => {
      const tableResult = await transaction.execute(
        "SELECT name, type FROM main.sqlite_schema "
        + "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' "
        + "ORDER BY name"
        + (maxTables === undefined ? "" : " LIMIT " + String(maxTables)),
      );
      const schemaRows = resultRows<SchemaRow>(tableResult);
      const discovered: DatabaseTable[] = [];
      for (const table of schemaRows) {
        throwIfAborted(signal);
        const quotedName = quoteIdentifier(table.name);
        const columnResult = await transaction.execute(
          "PRAGMA main.table_xinfo(" + quotedName + ")",
        );
        const foreignKeyResult = await transaction.execute(
          "PRAGMA main.foreign_key_list(" + quotedName + ")",
        );
        const columns = resultRows<ColumnRow>(columnResult)
          .filter((column) => Number(column.hidden ?? 0) !== 1)
          .sort((left, right) => Number(left.cid) - Number(right.cid));
        const primaryKey = columns
          .filter((column) => Number(column.pk) > 0)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => column.name);
        discovered.push({
          schema: SQLITE_SCHEMA,
          name: table.name,
          kind: table.type,
          columns: columns.map((column, index) => ({
            name: column.name,
            dataType: column.type.trim() || "unknown",
            nullable: Number(column.notnull) === 0 && Number(column.pk) === 0,
            ordinal: index + 1,
            ...(column.dflt_value === null
              ? {}
              : { defaultValue: String(column.dflt_value) }),
          })),
          primaryKey,
          foreignKeys: assembleForeignKeys(
            table.name,
            resultRows<ForeignKeyRow>(foreignKeyResult),
          ),
          indexes: [],
        });
      }
      return discovered;
    }, signal, this.#options.statementTimeoutMs);

    const catalog = finalizeCatalog({
      connectorId: this.id,
      dialect: this.dialect,
      databaseName: this.#options.databaseName,
      scannedAt: new Date().toISOString(),
      schemas: [{ name: SQLITE_SCHEMA, tables }],
    });
    this.#catalog = catalog;
    return catalog;
  }

  async query(
    request: DatabaseQueryRequest,
    signal?: AbortSignal,
  ): Promise<DatabaseQueryResult> {
    throwIfAborted(signal);
    if (typeof request.sql !== "string") {
      throw new TypeError("SQLite/libSQL requires a SQL query request.");
    }
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
    const normalizedSql = validateReadOnlySql(request.sql, {
      allowedSchemas: [SQLITE_SCHEMA],
      knownRelations: this.#catalog ? catalogRelations(this.#catalog) : undefined,
      allowedFunctions: this.#options.allowedFunctions,
    });
    const wrappedSql = "SELECT * FROM (" + normalizedSql
      + ") AS \"__data_elements_result\" LIMIT " + String(maxRows + 1);
    const parameters = (request.parameters ?? []).map(toLibSqlParameter);
    const startedAt = performance.now();
    const result = await this.#withReadTransaction(
      (transaction) => transaction.execute({ sql: wrappedSql, args: parameters }),
      signal,
      timeoutMs,
    );
    const rows = result.rows.slice(0, maxRows);
    const columns = uniqueColumnNames(result.columns, result.columnTypes);
    return {
      queryId: randomUUID(),
      columns,
      rows: rows.map((row) => Object.fromEntries(
        columns.map((column, index) => [
          column.name,
          toJsonValue(row[index]),
        ]),
      )),
      rowCount: rows.length,
      truncated: result.rows.length > maxRows,
      durationMs: roundDuration(performance.now() - startedAt),
    };
  }

  async close(): Promise<void> {
    this.#client.close();
  }

  async #withReadTransaction<T>(
    operation: (transaction: Transaction) => Promise<T>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    throwIfAborted(signal);
    let transaction: Transaction | undefined;
    const transactionTask = this.#client.transaction("read");
    try {
      try {
        transaction = await withDeadline(transactionTask, timeoutMs, signal);
      } catch (error) {
        void transactionTask.then((lateTransaction) => lateTransaction.close(), () => undefined);
        throw error;
      }
      return await withDeadline(
        operation(transaction),
        timeoutMs,
        signal,
        () => transaction?.close(),
      );
    } finally {
      transaction?.close();
    }
  }
}

export function normalizeSqliteConnectionUrl(value: string): {
  clientUrl: string;
  url: URL;
} {
  const source = value.trim();
  const rawFileUrl = source.toLocaleLowerCase("en-US").startsWith("sqlite:")
    ? "file:" + source.slice("sqlite:".length)
    : source;
  let url: URL;
  try {
    url = new URL(rawFileUrl);
  } catch {
    throw new Error("SQLite connectionString must be a valid file: or sqlite: URL.");
  }
  if (url.protocol !== "file:") {
    throw new Error("SQLite connectionString must use file: or sqlite:.");
  }
  if (url.search || url.hash) {
    throw new Error("SQLite connectionString must not contain a query or fragment.");
  }
  if (rawFileUrl === "file::memory:") {
    return { clientUrl: rawFileUrl, url };
  }
  const filePath = url.pathname.startsWith("/")
    ? fileURLToPath(url)
    : resolve(decodeURIComponent(url.pathname));
  if (!existsSync(filePath)) {
    throw new Error("SQLite connectionString must reference an existing database file.");
  }
  const clientUrl = pathToFileURL(filePath).href;
  return { clientUrl, url: new URL(clientUrl) };
}

export function normalizeTursoConnectionUrl(value: string): {
  clientUrl: string;
  url: URL;
} {
  const source = value.trim();
  const clientUrl = source.toLocaleLowerCase("en-US").startsWith("turso:")
    ? "libsql:" + source.slice("turso:".length)
    : source;
  let url: URL;
  try {
    url = new URL(clientUrl);
  } catch {
    throw new Error("Turso connectionString must be a valid libsql or HTTPS URL.");
  }
  const protocol = url.protocol.toLocaleLowerCase("en-US");
  if (!["libsql:", "https:", "wss:", "http:", "ws:"].includes(protocol)) {
    throw new Error("Turso connectionString must use libsql:, turso:, HTTPS, or WSS.");
  }
  if (!url.hostname) {
    throw new Error("Turso connectionString must include a host.");
  }
  if (
    (protocol === "http:" || protocol === "ws:")
    && !isLoopbackHost(url.hostname)
  ) {
    throw new Error("Unencrypted Turso URLs are allowed for loopback hosts only.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Turso credentials must be supplied as a separate auth token.");
  }
  return { clientUrl, url };
}

function sqliteDatabaseName(clientUrl: string): string {
  if (clientUrl === "file::memory:") return "memory";
  const path = fileURLToPath(new URL(clientUrl));
  return basename(path) || "sqlite";
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}

function assembleForeignKeys(
  tableName: string,
  rows: readonly ForeignKeyRow[],
): DatabaseTable["foreignKeys"] {
  const groups = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    const id = Number(row.id);
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([id, group]) => {
      const sorted = group.slice().sort((left, right) => Number(left.seq) - Number(right.seq));
      return {
        name: tableName + "_fk_" + String(id),
        columns: sorted.map((row) => row.from),
        referencedSchema: SQLITE_SCHEMA,
        referencedTable: sorted[0]?.table ?? "",
        referencedColumns: sorted.map((row) => row.to),
      };
    });
}

function resultRows<T extends object>(result: ResultSet): T[] {
  return result.rows.map((row) => Object.fromEntries(
    result.columns.map((column, index) => [column, row[index]]),
  ) as T);
}

function catalogRelations(catalog: DatabaseCatalog): KnownRelation[] {
  return catalog.schemas.flatMap((schema) => schema.tables.map((table) => ({
    schema: schema.name,
    name: table.name,
  })));
}

function uniqueColumnNames(
  names: readonly string[],
  types: readonly string[],
): DatabaseQueryResult["columns"] {
  const used = new Set<string>();
  return names.map((rawName, index) => {
    const base = rawName || "column_" + String(index + 1);
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = base + "_" + String(suffix);
      suffix += 1;
    }
    used.add(name);
    return { name };
  });
}

function toLibSqlParameter(value: string | number | boolean): InValue {
  return value;
}

function parseSqliteVersion(value: string): readonly [number, number, number] {
  const parts = value.match(/^(\d+)\.(\d+)(?:\.(\d+))?/u);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)] : [0, 0, 0];
}

function versionAtLeast(actual: readonly [number, number, number], major: number, minor: number, patch: number): boolean {
  if (actual[0] !== major) return actual[0] > major;
  if (actual[1] !== minor) return actual[1] > minor;
  return actual[2] >= patch;
}

function toJsonValue(value: Row[number] | undefined): unknown {
  if (value === null || value === undefined || typeof value === "string") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof ArrayBuffer) return "[binary:" + String(value.byteLength) + " bytes]";
  return String(value);
}

function withDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  cancel?: () => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => {
      cancel?.();
      rejectPromise(abortError());
    });
    const timer = setTimeout(() => finish(() => {
      cancel?.();
      rejectPromise(new Error("SQLite/libSQL query timed out."));
    }), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error)),
    );
  });
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase("en-US");
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function roundDuration(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException("The database operation was cancelled.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
