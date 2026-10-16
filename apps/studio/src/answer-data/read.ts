import {
  DATA_AGENT_RELATION_PREVIEW_LIMIT,
  DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS,
  type DataAgent,
} from "@open-tessera/data-agent";
import type { DatabaseCatalog, DatabaseConnector } from "@open-tessera/database";
import {
  AnswerDataError,
  type AnswerPreviewCell,
  type AnswerQueryResult,
  type MetricFilter,
  type RelationMetricsArgs,
  type RelationPreviewArgs,
} from "./contracts";

/**
 * Answer reads: `relation_preview` and `relation_metrics`.
 *
 * Both resolve names against the live catalog and return the same result shape.
 * The caller supplies catalog coordinates and, for metrics, a bounded aggregate
 * description — never SQL, filters-as-SQL, or a caller-chosen row bound that the
 * server would trust. Identifiers are quoted here and values are parameterized.
 */

type CatalogColumn = Readonly<{ name: string; dataType: string }>;
type CatalogTable = Readonly<{ name: string; columns: readonly CatalogColumn[] }>;

const MAX_METRIC_ROWS = 1_000;

// ── Shared helpers ──

/** Bounds one cell to a JSON-safe value; objects are stringified, never echoed raw. */
export function answerPreviewCell(value: unknown): AnswerPreviewCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > 4_096 ? `${value.slice(0, 4_096)}…` : value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text.length > 4_096 ? `${text.slice(0, 4_096)}…` : text;
    } catch {
      return null;
    }
  }
  return null;
}

export function findCatalogTable(
  catalog: Pick<DatabaseCatalog, "schemas">,
  schemaName: string,
  tableName: string,
): CatalogTable | undefined {
  return catalog.schemas
    .find((schema) => schema.name === schemaName)
    ?.tables.find((table) => table.name === tableName);
}

function projectRows(
  columns: readonly string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  limit: number,
): AnswerQueryResult {
  const bounded = rows.slice(0, limit).map((source) => Object.fromEntries(
    columns.map((name) => [name, answerPreviewCell(source[name])]),
  ));
  return {
    columns: [...columns],
    rows: bounded,
    rowCount: bounded.length,
    truncated: rows.length > bounded.length,
  };
}

// ── relation_preview ──

export type ExecuteRelationPreviewInput = Readonly<{
  dataAgent: Pick<DataAgent, "inspectCatalog" | "previewRelation">;
  request: RelationPreviewArgs;
  signal?: AbortSignal;
}>;

/** Derives the bounded column list from the catalog and runs the Data Agent preview. */
export async function executeRelationPreview(
  input: ExecuteRelationPreviewInput,
): Promise<AnswerQueryResult> {
  const snapshot = await input.dataAgent.inspectCatalog({ refresh: false }, input.signal);
  const table = findCatalogTable(snapshot.catalog, input.request.schema, input.request.table);
  if (table === undefined) {
    throw new AnswerDataError("relation_not_found", "The requested relation is not available in the current catalog.");
  }

  const columns = table.columns
    .slice()
    .sort((left, right) => ((left as { ordinal?: number }).ordinal ?? 0) - ((right as { ordinal?: number }).ordinal ?? 0))
    .slice(0, DATA_AGENT_RELATION_PREVIEW_MAX_COLUMNS)
    .map((column) => column.name);
  if (columns.length === 0) {
    throw new AnswerDataError("relation_not_previewable", "The requested relation does not expose any previewable columns.");
  }

  const preview = await input.dataAgent.previewRelation({
    schema: input.request.schema,
    table: input.request.table,
    columns,
    refresh: false,
  }, input.signal);

  const projected = projectRows(columns, preview.result.rows, DATA_AGENT_RELATION_PREVIEW_LIMIT);
  return { ...projected, truncated: preview.result.truncated || projected.truncated };
}

// ── relation_metrics ──

export type CompiledRelationMetrics = Readonly<{
  sql: string;
  parameters: Array<string | number | boolean>;
  limit: number;
}>;

function quoteIdentifier(dialect: DatabaseCatalog["dialect"], identifier: string): string {
  return dialect === "postgres" || dialect === "sqlite" || dialect === "turso"
    ? `"${identifier.replaceAll('"', '""')}"`
    : `\`${identifier.replaceAll("`", "``")}\``;
}

function coerceFilterValue(
  value: string | number | boolean | undefined,
  dataType: string,
): string | number | boolean {
  if (value === undefined) return "";
  if (typeof value !== "string") return value;
  const type = dataType.trim();
  if (/^(?:int|integer|bigint|smallint|numeric|decimal|real|double|float|serial|money)/iu.test(type)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (/^(?:bool|boolean)/iu.test(type)) {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

function buildMetricFilters(input: {
  dialect: DatabaseCatalog["dialect"];
  columns: Map<string, CatalogColumn>;
  filters: readonly MetricFilter[];
}): { parts: string[]; parameters: Array<string | number | boolean> } {
  const parts: string[] = [];
  const parameters: Array<string | number | boolean> = [];
  const placeholder = () => (input.dialect === "postgres" ? `$${parameters.length}` : "?");

  for (const filter of input.filters) {
    const column = input.columns.get(filter.column);
    if (column === undefined) {
      throw new AnswerDataError("invalid_metrics", `The filter column '${filter.column}' is not available.`);
    }
    const identifier = quoteIdentifier(input.dialect, column.name);
    if (filter.operator === "is_null") {
      parts.push(`${identifier} IS NULL`);
      continue;
    }
    if (filter.operator === "is_not_null") {
      parts.push(`${identifier} IS NOT NULL`);
      continue;
    }
    if (filter.operator === "contains") {
      parameters.push(`%${String(filter.value ?? "")}%`);
      parts.push(input.dialect === "postgres"
        ? `CAST(${identifier} AS text) ILIKE ${placeholder()}`
        : `CAST(${identifier} AS CHAR) LIKE ${placeholder()}`);
      continue;
    }
    parameters.push(coerceFilterValue(filter.value, column.dataType));
    const operator = filter.operator === "equals" ? "="
      : filter.operator === "not_equals" ? "<>"
        : filter.operator === "gt" ? ">"
          : filter.operator === "gte" ? ">="
            : filter.operator === "lt" ? "<" : "<=";
    parts.push(`${identifier} ${operator} ${placeholder()}`);
  }
  return { parts, parameters };
}

export type CompileRelationMetricsInput = Readonly<{
  dialect: DatabaseCatalog["dialect"];
  relation: Readonly<{ schema: string; table: string }>;
  columns: readonly CatalogColumn[];
  request: RelationMetricsArgs;
}>;

/**
 * Compiles a bounded `SELECT ... GROUP BY ...` from validated identifiers.
 * Pure and exported so the SQL contract is unit-tested without a connector.
 */
export function compileRelationMetricsSql(input: CompileRelationMetricsInput): CompiledRelationMetrics {
  const { dialect, request } = input;
  if (dialect === "mongodb") {
    throw new AnswerDataError("metrics_unsupported", "Grouped metrics are not available for this connector.");
  }
  const columns = new Map(input.columns.map((column) => [column.name, column]));
  const quote = (identifier: string) => quoteIdentifier(dialect, identifier);

  const groupBy = request.groupBy ?? [];
  const outputAliases: string[] = [];
  const selectParts: string[] = [];
  for (const name of groupBy) {
    if (!columns.has(name)) {
      throw new AnswerDataError("invalid_metrics", `The grouping column '${name}' is not available.`);
    }
    selectParts.push(quote(name));
    outputAliases.push(name);
  }

  for (const metric of request.metrics) {
    if (metric.fn === "count" && metric.column === undefined) {
      const alias = metric.alias ?? "count";
      selectParts.push(`COUNT(*) AS ${quote(alias)}`);
      outputAliases.push(alias);
      continue;
    }
    const column = metric.column === undefined ? undefined : columns.get(metric.column);
    if (column === undefined) {
      throw new AnswerDataError("invalid_metrics", `The metric column '${metric.column}' is not available.`);
    }
    const alias = metric.alias ?? `${metric.fn}_${column.name}`;
    selectParts.push(`${metric.fn.toUpperCase()}(${quote(column.name)}) AS ${quote(alias)}`);
    outputAliases.push(alias);
  }

  const orderAlias = request.orderBy?.alias;
  if (orderAlias !== undefined && !outputAliases.includes(orderAlias)) {
    throw new AnswerDataError("invalid_metrics", `The order column '${orderAlias}' is not part of the result.`);
  }

  const limit = Math.min(request.limit ?? MAX_METRIC_ROWS, MAX_METRIC_ROWS);
  const { parts, parameters } = buildMetricFilters({
    dialect,
    columns,
    filters: request.filters ?? [],
  });

  const sql = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${quote(input.relation.schema)}.${quote(input.relation.table)}`,
    ...(parts.length === 0 ? [] : [`WHERE ${parts.join(" AND ")}`]),
    ...(groupBy.length === 0 ? [] : [`GROUP BY ${groupBy.map(quote).join(", ")}`]),
    ...(orderAlias === undefined
      ? []
      : [`ORDER BY ${quote(orderAlias)} ${request.orderBy?.direction === "desc" ? "DESC" : "ASC"}`]),
    `LIMIT ${limit}`,
  ].join("\n");

  return { sql, parameters, limit };
}

export type ExecuteRelationMetricsInput = Readonly<{
  dataAgent: Pick<DataAgent, "inspectCatalog">;
  connector: Pick<DatabaseConnector, "query">;
  request: RelationMetricsArgs;
  signal?: AbortSignal;
}>;

export async function executeRelationMetrics(
  input: ExecuteRelationMetricsInput,
): Promise<AnswerQueryResult> {
  const snapshot = await input.dataAgent.inspectCatalog({ refresh: false }, input.signal);
  const table = findCatalogTable(snapshot.catalog, input.request.schema, input.request.table);
  if (table === undefined) {
    throw new AnswerDataError("relation_not_found", "The requested relation is not available in the current catalog.");
  }

  const compiled = compileRelationMetricsSql({
    dialect: snapshot.catalog.dialect,
    relation: { schema: input.request.schema, table: input.request.table },
    columns: table.columns,
    request: input.request,
  });

  const result = await input.connector.query({
    sql: compiled.sql,
    parameters: compiled.parameters,
    purpose: "Tessera answer metrics",
    maxRows: compiled.limit,
  }, input.signal);

  const columns = result.columns.map((column) => column.name);
  const projected = projectRows(columns, result.rows, compiled.limit);
  return { ...projected, truncated: result.truncated || projected.truncated };
}
