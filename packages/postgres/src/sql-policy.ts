import { parse, toSql, type QName, type Statement } from "pgsql-ast-parser";

export class PostgresQueryPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "PostgresQueryPolicyError";
  }
}

export type KnownRelation = { schema: string; name: string };

export type ReadOnlySqlPolicy = {
  allowedSchemas: readonly string[];
  knownRelations?: readonly KnownRelation[];
  allowedFunctions?: readonly string[];
};

const ROOT_TYPES = new Set(["select", "with", "with recursive", "union", "values"]);
const WRITE_OR_SESSION_TYPES = new Set([
  "alter table",
  "alter index",
  "alter sequence",
  "alter enum",
  "begin",
  "comment",
  "commit",
  "create composite type",
  "create enum",
  "create extension",
  "create function",
  "create index",
  "create materialized view",
  "create schema",
  "create sequence",
  "create table",
  "create view",
  "deallocate",
  "delete",
  "do",
  "drop",
  "drop function",
  "insert",
  "prepare",
  "raise",
  "refresh materialized view",
  "rollback",
  "set global",
  "set names",
  "set timezone",
  "share",
  "start transaction",
  "tablespace",
  "truncate",
  "update",
]);

const SAFE_FUNCTIONS = new Set([
  "abs", "acos", "array_agg", "asin", "atan", "atan2", "avg", "btrim", "ceil", "ceiling",
  "char_length", "coalesce", "concat", "concat_ws", "count", "corr", "cos", "date_part",
  "date_trunc", "dense_rank", "exp", "extract", "first_value", "floor", "greatest", "initcap",
  "json_array_length", "json_build_array", "json_build_object", "json_extract_path", "json_extract_path_text",
  "json_object_keys", "jsonb_array_length", "jsonb_build_array", "jsonb_build_object", "jsonb_extract_path",
  "jsonb_extract_path_text", "jsonb_object_keys", "lag", "last_value", "lead", "least", "length", "ln",
  "log", "lower", "lpad", "ltrim", "max", "md5", "min", "mode", "now", "nullif", "ntile",
  "percentile_cont", "percentile_disc", "pi", "power", "rank", "regr_avgx", "regr_avgy", "regr_count",
  "regr_intercept", "regr_r2", "regr_slope", "replace", "round", "row_number", "rpad", "rtrim", "sin",
  "split_part", "sqrt", "stddev", "stddev_pop", "stddev_samp", "string_agg", "substring", "sum", "tan",
  "to_char", "to_date", "to_timestamp", "trim", "trunc", "upper", "var_pop", "var_samp", "variance",
]);

const FORBIDDEN_FUNCTIONS = new Set([
  "dblink", "dblink_connect", "dblink_connect_u", "dblink_exec", "dblink_open", "dblink_send_query",
  "lo_export", "lo_import", "pg_advisory_lock", "pg_advisory_lock_shared", "pg_cancel_backend",
  "pg_ls_dir", "pg_log_backend_memory_contexts", "pg_notify", "pg_read_binary_file", "pg_read_file",
  "pg_reload_conf", "pg_rotate_logfile", "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_terminate_backend",
  "set_config", "terminate_backend",
]);

/**
 * Parse a statement with PostgreSQL grammar and return a canonical, one-statement
 * read-only SELECT. The database transaction remains the mandatory second line of
 * defense because SQL functions and extensions can have non-obvious behavior.
 */
export function validateReadOnlySql(sql: string, policy: ReadOnlySqlPolicy): string {
  const source = sql.trim();
  if (!source) throw new PostgresQueryPolicyError("empty_sql", "SQL must not be empty.");

  let statements: Statement[];
  try {
    statements = parse(source);
  } catch {
    throw new PostgresQueryPolicyError(
      "invalid_sql",
      "The query could not be parsed as a supported PostgreSQL read-only statement.",
    );
  }

  if (statements.length !== 1) {
    throw new PostgresQueryPolicyError("multiple_statements", "Only one SQL statement is allowed per request.");
  }

  const statement = statements[0];
  if (!statement || !ROOT_TYPES.has(statement.type)) {
    throw new PostgresQueryPolicyError("statement_not_allowed", "Only SELECT and read-only WITH statements are allowed.");
  }

  const context = {
    allowedFunctions: new Set([...SAFE_FUNCTIONS, ...(policy.allowedFunctions ?? [])].map(normalizeName)),
    allowedSchemas: new Set(policy.allowedSchemas.map(normalizeName)),
    cteNames: collectCteNames(statement),
    knownRelations: new Set((policy.knownRelations ?? []).map(({ schema, name }) => `${normalizeName(schema)}.${normalizeName(name)}`)),
  };
  visitNode(statement, context);
  return toSql.statement(statement);
}

function collectCteNames(value: unknown, names = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return names;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCteNames(item, names));
    return names;
  }
  const node = value as Record<string, unknown>;
  if ((node.type === "with" || node.type === "with recursive") && Array.isArray(node.bind)) {
    for (const binding of node.bind) {
      const alias = isRecord(binding) && isRecord(binding.alias) ? binding.alias.name : undefined;
      if (typeof alias === "string") names.add(normalizeName(alias));
    }
  }
  Object.values(node).forEach((item) => collectCteNames(item, names));
  return names;
}

function visitNode(value: unknown, context: {
  allowedFunctions: Set<string>;
  allowedSchemas: Set<string>;
  cteNames: Set<string>;
  knownRelations: Set<string>;
}): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitNode(item, context));
    return;
  }
  const node = value as Record<string, unknown>;
  const type = typeof node.type === "string" ? node.type : undefined;
  if (type && WRITE_OR_SESSION_TYPES.has(type)) {
    throw new PostgresQueryPolicyError("write_statement", "The query includes an operation that is not allowed in read-only mode.");
  }
  if (node.for !== undefined) {
    throw new PostgresQueryPolicyError("locking_clause", "Row-locking clauses are not allowed in read-only mode.");
  }
  if (type === "table") validateTableReference(node.name, context);
  if (type === "call") validateFunctionCall(node.function, context);
  Object.values(node).forEach((item) => visitNode(item, context));
}

function validateTableReference(value: unknown, context: {
  allowedSchemas: Set<string>;
  cteNames: Set<string>;
  knownRelations: Set<string>;
}): void {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new PostgresQueryPolicyError("invalid_relation", "The query contains an invalid relation reference.");
  }
  const name = normalizeName(value.name);
  const schema = typeof value.schema === "string" ? normalizeName(value.schema) : undefined;
  if (schema) {
    if (isSystemSchema(schema) || !context.allowedSchemas.has(schema)) {
      throw new PostgresQueryPolicyError("schema_not_allowed", `Schema "${schema}" is not available to this Agent.`);
    }
    if (context.knownRelations.size > 0 && !context.knownRelations.has(`${schema}.${name}`)) {
      throw new PostgresQueryPolicyError("relation_not_found", `Relation "${schema}.${name}" is not present in the discovered catalog.`);
    }
    return;
  }
  if (context.cteNames.has(name)) return;
  if (name.startsWith("pg_") || name === "information_schema") {
    throw new PostgresQueryPolicyError("system_relation_not_allowed", "System relations are not available to this Agent.");
  }
  if (context.knownRelations.size > 0 && ![...context.knownRelations].some((relation) => relation.endsWith(`.${name}`))) {
    throw new PostgresQueryPolicyError("relation_not_found", `Relation "${name}" is not present in the discovered catalog.`);
  }
}

function validateFunctionCall(value: unknown, context: {
  allowedFunctions: Set<string>;
  allowedSchemas: Set<string>;
}): void {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new PostgresQueryPolicyError("invalid_function", "The query contains an invalid function call.");
  }
  const name = normalizeName(value.name);
  const schema = typeof value.schema === "string" ? normalizeName(value.schema) : undefined;
  if (schema && (isSystemSchema(schema) || !context.allowedSchemas.has(schema))) {
    throw new PostgresQueryPolicyError("function_schema_not_allowed", `Function schema "${schema}" is not available to this Agent.`);
  }
  if (FORBIDDEN_FUNCTIONS.has(name) || name.startsWith("dblink_")) {
    throw new PostgresQueryPolicyError("function_not_allowed", `Function "${name}" is not allowed in read-only mode.`);
  }
  if (!context.allowedFunctions.has(name)) {
    throw new PostgresQueryPolicyError(
      "function_not_allowlisted",
      `Function "${name}" is not in the Agent's read-only function allowlist.`,
    );
  }
}

function isSystemSchema(schema: string): boolean {
  return schema === "information_schema" || schema.startsWith("pg_");
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
