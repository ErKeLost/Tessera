import { Parser } from "node-sql-parser";

export class MySqlQueryPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MySqlQueryPolicyError";
  }
}

export type KnownRelation = { schema: string; name: string };

export type ReadOnlySqlPolicy = {
  allowedSchemas: readonly string[];
  knownRelations?: readonly KnownRelation[];
  allowedFunctions?: readonly string[];
};

const parser = new Parser();

const SAFE_FUNCTIONS = new Set([
  "abs",
  "acos",
  "ascii",
  "asin",
  "atan",
  "atan2",
  "avg",
  "ceil",
  "ceiling",
  "char_length",
  "coalesce",
  "concat",
  "concat_ws",
  "convert_tz",
  "count",
  "curdate",
  "current_date",
  "current_timestamp",
  "curtime",
  "date",
  "date_add",
  "date_format",
  "date_sub",
  "datediff",
  "day",
  "dayofmonth",
  "dayofweek",
  "dayofyear",
  "dense_rank",
  "elt",
  "exp",
  "extract",
  "first_value",
  "floor",
  "format",
  "greatest",
  "hour",
  "if",
  "ifnull",
  "instr",
  "json_arrayagg",
  "json_extract",
  "json_length",
  "json_objectagg",
  "lag",
  "last_day",
  "last_value",
  "lead",
  "least",
  "length",
  "ln",
  "localtime",
  "locate",
  "log",
  "lower",
  "lpad",
  "ltrim",
  "max",
  "md5",
  "min",
  "minute",
  "month",
  "monthname",
  "now",
  "nullif",
  "ntile",
  "percent_rank",
  "pi",
  "position",
  "power",
  "quarter",
  "rank",
  "regexp_like",
  "replace",
  "round",
  "row_number",
  "rpad",
  "rtrim",
  "second",
  "sin",
  "soundex",
  "sqrt",
  "std",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "str_to_date",
  "substr",
  "substring",
  "sum",
  "tan",
  "timestampadd",
  "timestampdiff",
  "trim",
  "truncate",
  "ucase",
  "unhex",
  "unix_timestamp",
  "upper",
  "week",
  "weekday",
  "year",
]);

const FORBIDDEN_FUNCTIONS = new Set([
  "benchmark",
  "connection_id",
  "get_lock",
  "inet6_aton",
  "load_file",
  "master_pos_wait",
  "pg_sleep",
  "release_lock",
  "sleep",
  "sys_eval",
  "sys_exec",
  "uuid_short",
]);

/**
 * Parse a single MySQL SELECT and reject constructs which can mutate data,
 * lock rows, read server files, or access relations outside the discovered catalog.
 * The connector's `START TRANSACTION READ ONLY` remains the mandatory second
 * line of defense against parser gaps and unsafe server extensions.
 */
export function validateReadOnlySql(
  sql: string,
  policy: ReadOnlySqlPolicy,
): string {
  const source = sql.trim();
  if (!source)
    throw new MySqlQueryPolicyError("empty_sql", "SQL must not be empty.");

  let parsed: unknown;
  try {
    parsed = parser.astify(source, { database: "MySQL" });
  } catch {
    throw new MySqlQueryPolicyError(
      "invalid_sql",
      "The query could not be parsed as a supported MySQL read-only statement.",
    );
  }

  if (Array.isArray(parsed) && parsed.length !== 1) {
    throw new MySqlQueryPolicyError(
      "multiple_statements",
      "Only one SQL statement is allowed per request.",
    );
  }
  const statement = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(statement) || statement.type !== "select") {
    throw new MySqlQueryPolicyError(
      "statement_not_allowed",
      "Only SELECT statements are allowed.",
    );
  }

  const context = {
    allowedFunctions: new Set(
      [...SAFE_FUNCTIONS, ...(policy.allowedFunctions ?? [])].map(
        normalizeName,
      ),
    ),
    allowedSchemas: new Set(policy.allowedSchemas.map(normalizeName)),
    cteNames: collectCteNames(statement),
    knownRelations: new Set(
      (policy.knownRelations ?? []).map(
        ({ schema, name }) => `${normalizeName(schema)}.${normalizeName(name)}`,
      ),
    ),
  };
  visitNode(statement, context);
  return source.replace(/;\s*$/, "");
}

function collectCteNames(statement: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const bindings = statement.with;
  if (!Array.isArray(bindings)) return names;
  for (const binding of bindings) {
    if (
      !isRecord(binding) ||
      !isRecord(binding.name) ||
      typeof binding.name.value !== "string"
    )
      continue;
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
  const type = typeof node.type === "string" ? node.type : undefined;
  if (type === "select") {
    if (node.locking_read) {
      throw new MySqlQueryPolicyError(
        "locking_clause",
        "Row-locking clauses are not allowed in read-only mode.",
      );
    }
    if (isRecord(node.into) && node.into.keyword) {
      throw new MySqlQueryPolicyError(
        "select_into",
        "SELECT ... INTO is not allowed in read-only mode.",
      );
    }
  }
  if (type === "assign") {
    throw new MySqlQueryPolicyError(
      "session_assignment",
      "Session variable assignments are not allowed.",
    );
  }
  if (type === "var") {
    throw new MySqlQueryPolicyError(
      "session_variable",
      "Session and system variable access is not allowed.",
    );
  }
  if (type === "function" || type === "aggr_func")
    validateFunctionCall(node, context);
  if (isTableReference(node)) validateTableReference(node, context);

  for (const [key, item] of Object.entries(node)) {
    // These parser convenience values are strings, not executable AST nodes.
    if (key === "tableList" || key === "columnList") continue;
    visitNode(item, context);
  }
}

function isTableReference(node: Record<string, unknown>): boolean {
  return (
    node.type === undefined &&
    typeof node.table === "string" &&
    (node.db === null || typeof node.db === "string")
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
  const schema =
    typeof node.db === "string" ? normalizeName(node.db) : undefined;
  if (schema) {
    if (isSystemSchema(schema) || !context.allowedSchemas.has(schema)) {
      throw new MySqlQueryPolicyError(
        "schema_not_allowed",
        `Schema "${schema}" is not available to this Agent.`,
      );
    }
    if (
      context.knownRelations.size > 0 &&
      !context.knownRelations.has(`${schema}.${table}`)
    ) {
      throw new MySqlQueryPolicyError(
        "relation_not_found",
        `Relation "${schema}.${table}" is not present in the discovered catalog.`,
      );
    }
    return;
  }
  if (context.cteNames.has(table)) return;
  if (
    context.knownRelations.size > 0 &&
    ![...context.knownRelations].some((relation) =>
      relation.endsWith(`.${table}`),
    )
  ) {
    throw new MySqlQueryPolicyError(
      "relation_not_found",
      `Relation "${table}" is not present in the discovered catalog.`,
    );
  }
}

function validateFunctionCall(
  node: Record<string, unknown>,
  context: { allowedFunctions: Set<string> },
): void {
  const name = functionName(node);
  if (!name)
    throw new MySqlQueryPolicyError(
      "invalid_function",
      "The query contains an invalid function call.",
    );
  if (FORBIDDEN_FUNCTIONS.has(name)) {
    throw new MySqlQueryPolicyError(
      "function_not_allowed",
      `Function "${name}" is not allowed in read-only mode.`,
    );
  }
  if (!context.allowedFunctions.has(name)) {
    throw new MySqlQueryPolicyError(
      "function_not_allowlisted",
      `Function "${name}" is not in the Agent's read-only function allowlist.`,
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
  return (
    schema === "information_schema" ||
    schema === "mysql" ||
    schema === "performance_schema" ||
    schema === "sys"
  );
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
