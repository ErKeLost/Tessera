import NodeSqlParser from "node-sql-parser";

export class SqliteQueryPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SqliteQueryPolicyError";
  }
}

export type KnownRelation = { schema: string; name: string };

export type ReadOnlySqlPolicy = {
  allowedSchemas: readonly string[];
  knownRelations?: readonly KnownRelation[];
  allowedFunctions?: readonly string[];
};

const parser = new NodeSqlParser.Parser();

const SAFE_FUNCTIONS = new Set([
  "abs",
  "avg",
  "ceil",
  "ceiling",
  "char",
  "coalesce",
  "concat",
  "concat_ws",
  "count",
  "date",
  "datetime",
  "dense_rank",
  "first_value",
  "floor",
  "format",
  "glob",
  "hex",
  "ifnull",
  "instr",
  "json",
  "json_array",
  "json_array_length",
  "json_extract",
  "json_group_array",
  "json_group_object",
  "json_object",
  "json_quote",
  "json_type",
  "json_valid",
  "julianday",
  "lag",
  "last_value",
  "lead",
  "length",
  "likely",
  "likelihood",
  "lower",
  "ltrim",
  "max",
  "min",
  "nullif",
  "ntile",
  "percent_rank",
  "printf",
  "quote",
  "random",
  "randomblob",
  "rank",
  "replace",
  "round",
  "row_number",
  "rtrim",
  "sign",
  "soundex",
  "strftime",
  "substr",
  "substring",
  "sum",
  "time",
  "timediff",
  "total",
  "total_changes",
  "trim",
  "typeof",
  "unicode",
  "unixepoch",
  "unlikely",
  "upper",
  "zeroblob",
]);

const FORBIDDEN_FUNCTIONS = new Set([
  "edit",
  "eval",
  "fts3_tokenizer",
  "load_extension",
  "readfile",
  "sqlite_compileoption_get",
  "sqlite_compileoption_used",
  "sqlite_source_id",
  "writefile",
]);

/**
 * Parses one SQLite SELECT and rejects mutations, locking/session constructs,
 * unknown relations, and functions outside the read-only allowlist.
 */
export function validateReadOnlySql(
  sql: string,
  policy: ReadOnlySqlPolicy,
): string {
  const source = sql.trim();
  if (!source) {
    throw new SqliteQueryPolicyError("empty_sql", "SQL must not be empty.");
  }

  let parsed: unknown;
  try {
    parsed = parser.astify(source, { database: "SQLite" });
  } catch {
    throw new SqliteQueryPolicyError(
      "invalid_sql",
      "The query could not be parsed as a supported SQLite read-only statement.",
    );
  }

  if (Array.isArray(parsed) && parsed.length !== 1) {
    throw new SqliteQueryPolicyError(
      "multiple_statements",
      "Only one SQL statement is allowed per request.",
    );
  }
  const statement = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(statement) || statement.type !== "select") {
    throw new SqliteQueryPolicyError(
      "statement_not_allowed",
      "Only SELECT statements are allowed.",
    );
  }

  const context = {
    allowedFunctions: new Set(
      [...SAFE_FUNCTIONS, ...(policy.allowedFunctions ?? [])].map(normalizeName),
    ),
    allowedSchemas: new Set(policy.allowedSchemas.map(normalizeName)),
    cteNames: collectCteNames(statement),
    knownRelations: new Set(
      (policy.knownRelations ?? []).map(
        ({ schema, name }) => normalizeName(schema) + "." + normalizeName(name),
      ),
    ),
  };
  visitNode(statement, context);
  return source.replace(/;\s*$/u, "");
}

function collectCteNames(statement: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const bindings = statement.with;
  if (!Array.isArray(bindings)) return names;
  for (const binding of bindings) {
    if (
      !isRecord(binding)
      || !isRecord(binding.name)
      || typeof binding.name.value !== "string"
    ) {
      continue;
    }
    names.add(normalizeName(binding.name.value));
  }
  return names;
}

function visitNode(
  value: unknown,
  context: {
    allowedFunctions: Set<string>;
    allowedSchemas: Set<string>;
    cteNames: Set<string>;
    knownRelations: Set<string>;
  },
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => visitNode(item, context));
    return;
  }

  const node = value as Record<string, unknown>;
  if (node.type === "select") {
    if (node.for_update || node.locking_read) {
      throw new SqliteQueryPolicyError(
        "locking_clause",
        "Row-locking clauses are not allowed in read-only mode.",
      );
    }
    if (isRecord(node.into) && node.into.keyword) {
      throw new SqliteQueryPolicyError(
        "select_into",
        "SELECT output clauses are not allowed in read-only mode.",
      );
    }
  }
  if (node.type === "assign" || node.type === "var") {
    throw new SqliteQueryPolicyError(
      "session_state",
      "Session state is not available in read-only mode.",
    );
  }
  if (node.type === "function" || node.type === "aggr_func") {
    validateFunctionCall(node, context);
  }
  if (isTableReference(node)) validateTableReference(node, context);

  for (const [key, item] of Object.entries(node)) {
    if (key === "tableList" || key === "columnList") continue;
    visitNode(item, context);
  }
}

function isTableReference(node: Record<string, unknown>): boolean {
  return (
    node.type === undefined
    && typeof node.table === "string"
    && (node.db === null || typeof node.db === "string")
  );
}

function validateTableReference(
  node: Record<string, unknown>,
  context: {
    allowedSchemas: Set<string>;
    cteNames: Set<string>;
    knownRelations: Set<string>;
  },
): void {
  const table = normalizeName(node.table as string);
  const schema = typeof node.db === "string" ? normalizeName(node.db) : undefined;
  if (schema) {
    if (isSystemSchema(schema) || !context.allowedSchemas.has(schema)) {
      throw new SqliteQueryPolicyError(
        "schema_not_allowed",
        "Schema \"" + schema + "\" is not available to this Agent.",
      );
    }
    if (
      context.knownRelations.size > 0
      && !context.knownRelations.has(schema + "." + table)
    ) {
      throw new SqliteQueryPolicyError(
        "relation_not_found",
        "Relation \"" + schema + "." + table + "\" is not present in the discovered catalog.",
      );
    }
    return;
  }
  if (context.cteNames.has(table)) return;
  if (table.startsWith("sqlite_")) {
    throw new SqliteQueryPolicyError(
      "system_relation_not_allowed",
      "SQLite system relations are not available to this Agent.",
    );
  }
  if (
    context.knownRelations.size > 0
    && ![...context.knownRelations].some((relation) => relation.endsWith("." + table))
  ) {
    throw new SqliteQueryPolicyError(
      "relation_not_found",
      "Relation \"" + table + "\" is not present in the discovered catalog.",
    );
  }
}

function validateFunctionCall(
  node: Record<string, unknown>,
  context: { allowedFunctions: Set<string> },
): void {
  const name = functionName(node);
  if (!name) {
    throw new SqliteQueryPolicyError(
      "invalid_function",
      "The query contains an invalid function call.",
    );
  }
  if (FORBIDDEN_FUNCTIONS.has(name)) {
    throw new SqliteQueryPolicyError(
      "function_not_allowed",
      "Function \"" + name + "\" is not allowed in read-only mode.",
    );
  }
  if (!context.allowedFunctions.has(name)) {
    throw new SqliteQueryPolicyError(
      "function_not_allowlisted",
      "Function \"" + name + "\" is not in the Agent read-only function allowlist.",
    );
  }
}

function functionName(node: Record<string, unknown>): string | undefined {
  if (typeof node.name === "string") return normalizeName(node.name);
  if (!isRecord(node.name) || !Array.isArray(node.name.name)) return undefined;
  const part = node.name.name[0];
  return isRecord(part) && typeof part.value === "string"
    ? normalizeName(part.value)
    : undefined;
}

function isSystemSchema(schema: string): boolean {
  return schema === "temp" || schema.startsWith("sqlite_");
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
