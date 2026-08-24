import { randomUUID } from "node:crypto";
import {
  databaseExtensionInspectionInputSchema,
  databaseExtensionInspectionSchema,
  databaseCapabilitiesSchema,
  finalizeCatalog,
  type CatalogIntrospectionOptions,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseCapabilities,
  type DatabaseColumn,
  type DatabaseConnector,
  type DatabaseExtensionInspectionInput,
  type DatabaseMongoQueryRequest,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
  type DatabaseTable,
} from "@open-tessera/database";
import {
  Binary,
  Decimal128,
  Long,
  MongoClient,
  ObjectId,
  Timestamp,
  type Document,
} from "mongodb";

export type MongoDbConnectorOptions = Readonly<{
  connectionString: string;
  id?: string;
  database?: string;
  maxConnections?: number;
  maxRows?: number;
  statementTimeoutMs?: number;
  sampleDocuments?: number;
}>;

type NormalizedOptions = Readonly<{
  connectionString: string;
  id: string;
  database: string;
  maxConnections: number;
  maxRows: number;
  statementTimeoutMs: number;
  sampleDocuments: number;
}>;

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_ROWS = 1_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_SAMPLE_DOCUMENTS = 100;
const MAX_PIPELINE_BYTES = 250_000;
const ALLOWED_STAGES = new Set([
  "$group",
  "$count",
  "$limit",
  "$lookup",
  "$match",
  "$project",
  "$skip",
  "$sort",
  "$unwind",
]);
const FORBIDDEN_OPERATORS = new Set([
  "$accumulator",
  "$function",
  "$merge",
  "$out",
  "$where",
]);

export function createMongoDbConnector(options: MongoDbConnectorOptions): MongoDbConnector {
  return new MongoDbConnector(options);
}

export class MongoDbConnector implements DatabaseConnector {
  readonly dialect = "mongodb" as const;
  readonly id: string;
  readonly #options: NormalizedOptions;
  readonly #client: MongoClient;
  #catalog: DatabaseCatalog | undefined;

  constructor(options: MongoDbConnectorOptions) {
    const url = validateMongoDbUrl(options.connectionString);
    const database = normalizeDatabaseName(options.database ?? databaseNameFromUrl(url));
    this.id = options.id?.trim() || `mongodb:${url.hostname || "local"}/${database}`;
    this.#options = {
      connectionString: options.connectionString,
      id: this.id,
      database,
      maxConnections: clampInteger(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS, 1, 20),
      maxRows: clampInteger(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 20_000),
      statementTimeoutMs: clampInteger(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS, 250, 120_000),
      sampleDocuments: clampInteger(options.sampleDocuments ?? DEFAULT_SAMPLE_DOCUMENTS, 1, 1_000),
    };
    this.#client = new MongoClient(this.#options.connectionString, {
      appName: "data-elements-studio",
      maxPoolSize: this.#options.maxConnections,
      serverSelectionTimeoutMS: this.#options.statementTimeoutMs,
    });
  }

  async assess(signal?: AbortSignal): Promise<ConnectionAssessment> {
    const startedAt = performance.now();
    const url = validateMongoDbUrl(this.#options.connectionString);
    try {
      throwIfAborted(signal);
      await waitForAbort(this.#client.connect(), signal);
      const database = this.#client.db(this.#options.database);
      const buildInfo = await waitForAbort(database.command({ buildInfo: 1 }), signal);
      await waitForAbort(database.listCollections({}, { nameOnly: true }).hasNext(), signal);
      return {
        connectorId: this.id,
        dialect: "mongodb",
        connected: true,
        databaseName: this.#options.database,
        host: url.hostname || undefined,
        ...(typeof buildInfo.version === "string" ? { serverVersion: buildInfo.version } : {}),
        readOnlyTransactions: true,
        credentialCanWrite: false,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: [],
      };
    } catch (error) {
      if (isAbort(error)) throw error;
      return {
        connectorId: this.id,
        dialect: "mongodb",
        connected: false,
        host: url.hostname || undefined,
        readOnlyTransactions: true,
        latencyMs: roundDuration(performance.now() - startedAt),
        warnings: ["MongoDB could not be reached with the configured connection."],
      };
    }
  }

  async inspectCapabilities(signal?: AbortSignal): Promise<DatabaseCapabilities> {
    throwIfAborted(signal);
    await waitForAbort(this.#client.connect(), signal);
    const buildInfo = await waitForAbort(
      this.#client.db(this.#options.database).command({ buildInfo: 1 }),
      signal,
    ) as { version?: string; modules?: unknown };
    const modules = Array.isArray(buildInfo.modules)
      ? buildInfo.modules.filter((value): value is string => typeof value === "string")
      : [];
    const components: DatabaseCapabilities["components"] = [
      {
        id: "engine.mongodb",
        kind: "engine",
        status: "supported",
        ...(typeof buildInfo.version === "string" ? { version: buildInfo.version } : {}),
      },
      { id: "aggregation.pipeline", kind: "feature", status: "supported" },
      { id: "aggregation.lookup", kind: "feature", status: "supported" },
      ...modules.slice(0, 253).map((module) => ({
        id: `module:${module}`,
        kind: "module" as const,
        status: "installed" as const,
      })),
    ];
    return databaseCapabilitiesSchema.parse({
      kind: "database-capabilities",
      connectorId: this.id,
      dialect: "mongodb",
      databaseName: this.#options.database,
      availability: "available",
      ...(typeof buildInfo.version === "string" ? { serverVersion: buildInfo.version } : {}),
      components,
      truncated: modules.length > 253,
      warnings: [],
    });
  }

  async inspectExtensions(
    input: DatabaseExtensionInspectionInput = {},
    signal?: AbortSignal,
  ) {
    const parsed = databaseExtensionInspectionInputSchema.parse(input);
    throwIfAborted(signal);
    await waitForAbort(this.#client.connect(), signal);
    const buildInfo = await waitForAbort(
      this.#client.db(this.#options.database).command({ buildInfo: 1 }),
      signal,
    ) as { modules?: unknown };
    const modules = Array.isArray(buildInfo.modules)
      ? buildInfo.modules.filter((value): value is string => typeof value === "string")
      : [];
    const requested = new Set(parsed.names ?? []);
    const extensions = modules
      .filter((name) => requested.size === 0 || requested.has(name))
      .slice(0, 512)
      .map((name) => ({
        name,
        kind: "module" as const,
        installed: true,
        status: "compiled",
        type: "server_module",
      }));
    return databaseExtensionInspectionSchema.parse({
      kind: "database-extensions",
      connectorId: this.id,
      dialect: "mongodb",
      databaseName: this.#options.database,
      extensions,
      truncated: modules.length > 512,
      warnings: [
        "MongoDB exposes server modules from buildInfo; it does not expose a database-level extension catalog.",
      ],
    });
  }

  async introspect(
    options: CatalogIntrospectionOptions = {},
    signal?: AbortSignal,
  ): Promise<DatabaseCatalog> {
    throwIfAborted(signal);
    if (options.schemas?.length && !options.schemas.includes(this.#options.database)) {
      throw new Error("MongoDB introspection is limited to the database in the connection URL.");
    }
    await waitForAbort(this.#client.connect(), signal);
    const database = this.#client.db(this.#options.database);
    const collectionInfos = await waitForAbort(
      database.listCollections({}, { nameOnly: false }).toArray(),
      signal,
    );
    const allReadable = collectionInfos
      .filter(({ name }) => !name.startsWith("system."))
      .sort((left, right) => left.name.localeCompare(right.name));
    const maxTables = options.maxTables === undefined
      ? undefined
      : clampInteger(options.maxTables, 1, 100_000);
    const readable = maxTables === undefined ? allReadable : allReadable.slice(0, maxTables);
    const tables: DatabaseTable[] = [];
    for (const info of readable) {
      throwIfAborted(signal);
      const collection = database.collection(info.name);
      const documents = await waitForAbort(
        collection.find({}, {
          limit: this.#options.sampleDocuments,
          maxTimeMS: this.#options.statementTimeoutMs,
        }).toArray(),
        signal,
      );
      let indexes: NonNullable<DatabaseTable["indexes"]> | undefined;
      let indexMetadata: "complete" | "partial" | "unavailable" = "unavailable";
      try {
        const indexRows = await waitForAbort(collection.listIndexes().toArray(), signal);
        const inventory = mongoIndexInventory(indexRows);
        indexes = inventory.indexes;
        indexMetadata = inventory.metadata;
      } catch (error) {
        // Index listing is a separate MongoDB privilege. Keep readable
        // collections usable when that privilege is absent, and publish no
        // empty array because an empty array would falsely mean no indexes.
        if (isAbort(error)) throw error;
      }
      tables.push({
        schema: this.#options.database,
        name: info.name,
        kind: info.type === "view" ? "view" : "collection",
        columns: inferColumns(documents),
        primaryKey: documents.length === 0 || documents.some((document) => !("_id" in document)) ? [] : ["_id"],
        foreignKeys: [],
        // MongoDB collections do not expose native foreign-key constraints;
        // an empty array here is a complete result for this connector model.
        foreignKeyMetadata: "complete",
        ...(indexes === undefined ? {} : { indexes }),
        indexMetadata,
      });
    }
    const catalog = finalizeCatalog({
      connectorId: this.id,
      dialect: "mongodb",
      databaseName: this.#options.database,
      scannedAt: new Date().toISOString(),
      coverage: {
        status: maxTables !== undefined && readable.length >= maxTables ? "partial" : "complete",
        ...(maxTables !== undefined && readable.length >= maxTables ? { reason: "max_tables" as const, maxTables } : {}),
        returnedTables: readable.length,
        ...(maxTables !== undefined && readable.length >= maxTables ? {} : { omittedTables: 0 }),
      },
      schemas: [{ name: this.#options.database, tables }],
    });
    this.#catalog = catalog;
    return catalog;
  }

  async query(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    if (request.kind !== "mongodb") throw new TypeError("MongoDB requires an aggregation query request.");
    throwIfAborted(signal);
    const parsed = request as DatabaseMongoQueryRequest;
    if (parsed.database !== this.#options.database) {
      throw new Error("The MongoDB query targets a different database.");
    }
    const readableCollections = await this.#readableCollections(signal);
    if (!readableCollections.has(parsed.collection)) {
      throw new Error("The MongoDB query targets a collection outside the readable catalog.");
    }
    const pipeline = validateMongoReadPipeline(parsed.pipeline, readableCollections);
    const maxRows = clampInteger(parsed.maxRows ?? this.#options.maxRows, 1, this.#options.maxRows);
    const timeoutMs = clampInteger(parsed.timeoutMs ?? this.#options.statementTimeoutMs, 250, this.#options.statementTimeoutMs);
    const startedAt = performance.now();
    const cursor = this.#client
      .db(this.#options.database)
      .collection(parsed.collection)
      .aggregate([...pipeline, { $limit: maxRows + 1 }], {
        allowDiskUse: false,
        maxTimeMS: timeoutMs,
      });
    const closeOnAbort = () => { void cursor.close(); };
    signal?.addEventListener("abort", closeOnAbort, { once: true });
    let documents: Document[];
    try {
      documents = await waitForAbort(cursor.toArray(), signal);
    } finally {
      signal?.removeEventListener("abort", closeOnAbort);
      await cursor.close().catch(() => undefined);
    }
    const rows = documents.slice(0, maxRows).map((document) => toJsonDocument(document));
    const columnNames = parsed.columns?.length
      ? parsed.columns
      : [...new Set(rows.flatMap((row) => Object.keys(row)))];
    return {
      queryId: randomUUID(),
      columns: columnNames.map((name) => ({ name })),
      rows,
      rowCount: rows.length,
      truncated: documents.length > maxRows,
      durationMs: roundDuration(performance.now() - startedAt),
    };
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  async #readableCollections(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    if (this.#catalog) {
      return new Set(this.#catalog.schemas.flatMap(({ tables }) => tables.map(({ name }) => name)));
    }
    await waitForAbort(this.#client.connect(), signal);
    const infos = await waitForAbort(
      this.#client.db(this.#options.database).listCollections({}, { nameOnly: true }).toArray(),
      signal,
    );
    return new Set(infos.map(({ name }) => name).filter((name) => !name.startsWith("system.")));
  }
}

function mongoIndexInventory(rows: readonly Document[]): Readonly<{
  indexes: NonNullable<DatabaseTable["indexes"]>;
  metadata: "complete" | "partial";
}> {
  let metadata: "complete" | "partial" = "complete";
  const indexes = rows.flatMap((row) => {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const key = isRecord(row.key) ? row.key : undefined;
    const columns = key === undefined ? [] : Object.keys(key);
    if (!name || columns.length === 0) {
      metadata = "partial";
      return [];
    }
    return [{
      name,
      columns,
      unique: row.unique === true || (name === "_id_" && columns.length === 1 && columns[0] === "_id"),
      isConstraint: false,
    }];
  });
  return { indexes, metadata };
}

export function validateMongoReadPipeline(
  input: readonly Record<string, unknown>[],
  allowedCollections?: ReadonlySet<string>,
): Record<string, unknown>[] {
  if (input.length > 128) throw new Error("MongoDB aggregation exceeds the stage limit.");
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("MongoDB aggregation must be serializable.");
  }
  if (serialized.length > MAX_PIPELINE_BYTES) throw new Error("MongoDB aggregation exceeds the size limit.");
  const pipeline = input.map((stage) => structuredClone(stage));
  for (const stage of pipeline) validateStage(stage, allowedCollections);
  return pipeline;
}

function validateStage(stage: Record<string, unknown>, allowedCollections?: ReadonlySet<string>): void {
  const entries = Object.entries(stage);
  if (entries.length !== 1 || !ALLOWED_STAGES.has(entries[0]![0])) {
    throw new Error("MongoDB aggregation contains a stage that is not allowed.");
  }
  const [operator, value] = entries[0]!;
  rejectForbiddenOperators(value);
  if (operator !== "$lookup") return;
  if (!isRecord(value) || typeof value.from !== "string" || !Array.isArray(value.pipeline)) {
    throw new Error("MongoDB lookups must use a bounded collection pipeline.");
  }
  if (allowedCollections && !allowedCollections.has(value.from)) {
    throw new Error("MongoDB lookup targets a collection outside the readable catalog.");
  }
  for (const nested of value.pipeline) {
    if (!isRecord(nested)) throw new Error("MongoDB lookup pipeline is invalid.");
    validateStage(nested, allowedCollections);
  }
}

function rejectForbiddenOperators(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenOperators);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      throw new Error("MongoDB aggregation contains an unsafe operator.");
    }
    rejectForbiddenOperators(nested);
  }
}

function inferColumns(documents: readonly Document[]): DatabaseColumn[] {
  const fields = new Map<string, { present: number; nullable: boolean; types: Set<string> }>();
  for (const document of documents) {
    for (const [name, value] of Object.entries(document)) {
      if (!isSupportedFieldName(name)) continue;
      const field = fields.get(name) ?? { present: 0, nullable: false, types: new Set<string>() };
      field.present += 1;
      field.nullable ||= value === null || value === undefined;
      field.types.add(mongoType(value));
      fields.set(name, field);
    }
  }
  return [...fields.entries()]
    .sort(([left], [right]) => left === "_id" ? -1 : right === "_id" ? 1 : left.localeCompare(right))
    .map(([name, field], index) => ({
      name,
      dataType: field.types.size === 1 ? [...field.types][0]! : `mixed (${[...field.types].sort().join(", ")})`,
      nullable: field.nullable || field.present < documents.length,
      ordinal: index + 1,
    }));
}

function mongoType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "double";
  if (typeof value === "bigint" || value instanceof Long) return "bigint";
  if (typeof value === "boolean") return "boolean";
  if (value instanceof Date) return "datetime";
  if (value instanceof ObjectId) return "objectId";
  if (value instanceof Decimal128) return "decimal";
  if (value instanceof Timestamp) return "timestamp";
  if (value instanceof Binary || value instanceof Uint8Array) return "binary";
  if (Array.isArray(value)) return "json array";
  if (typeof value === "object") return "json object";
  return "unknown";
}

function toJsonDocument(document: Document): Record<string, unknown> {
  return Object.fromEntries(Object.entries(document).map(([key, value]) => [key, toJsonValue(value)]));
}

function toJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || value instanceof Long) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Decimal128) return value.toString();
  if (value instanceof Timestamp) return value.toString();
  if (value instanceof Binary) return `[binary:${value.length()} bytes]`;
  if (value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  return String(value);
}

function validateMongoDbUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MongoDB connectionString must be a valid URL.");
  }
  if (url.protocol !== "mongodb:" && url.protocol !== "mongodb+srv:") {
    throw new Error("MongoDB connectionString must use mongodb:// or mongodb+srv://.");
  }
  if (!url.hostname) throw new Error("MongoDB connectionString must include a host.");
  return url;
}

function databaseNameFromUrl(url: URL): string {
  const value = decodeURIComponent(url.pathname.replace(/^\//u, "").split("/")[0] ?? "");
  if (!value) throw new Error("MongoDB connectionString must include a database name.");
  return value;
}

function normalizeDatabaseName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 || /[\0/\\. "\$]/u.test(normalized)) {
    throw new Error("MongoDB database name is invalid.");
  }
  return normalized;
}

function isSupportedFieldName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.startsWith("$") && !value.includes(".") && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function waitForAbort<T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function abortError(): DOMException {
  return new DOMException("The database operation was cancelled.", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
