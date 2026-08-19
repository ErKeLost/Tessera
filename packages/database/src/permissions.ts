import { z } from "zod";

/** Named database permission postures compatible with Datus' SQL policy. */
export const databasePermissionProfileSchema = z.enum(["normal", "auto", "dangerous"]);
export const databasePermissionLevelSchema = z.enum(["allow", "ask", "deny"]);
export const databaseSqlStatementClassSchema = z.enum(["read", "write", "destructive", "unknown"]);

export type DatabasePermissionProfile = z.infer<typeof databasePermissionProfileSchema>;
export type DatabasePermissionLevel = z.infer<typeof databasePermissionLevelSchema>;
export type DatabaseSqlStatementClass = z.infer<typeof databaseSqlStatementClassSchema>;

export type DatabasePermissionPolicyInput = Readonly<{
  profile?: DatabasePermissionProfile;
  /** Per-class overrides are applied after the selected profile. */
  sqlStatements?: Readonly<Partial<Record<DatabaseSqlStatementClass, DatabasePermissionLevel>>>;
}>;

export type DatabasePermissionPolicy = Readonly<{
  profile: DatabasePermissionProfile;
  sqlStatements: Readonly<Record<DatabaseSqlStatementClass, DatabasePermissionLevel>>;
}>;

export type DatabaseSqlPermissionEvaluation = Readonly<{
  statementClass: DatabaseSqlStatementClass;
  permission: DatabasePermissionLevel;
}>;

const SQL_STATEMENT_CLASSES = new Set<DatabaseSqlStatementClass>([
  "read",
  "write",
  "destructive",
  "unknown",
]);

const PROFILE_SQL_STATEMENT_RULES: Readonly<Record<
  DatabasePermissionProfile,
  Readonly<Record<DatabaseSqlStatementClass, DatabasePermissionLevel>>
>> = Object.freeze({
  normal: Object.freeze({
    read: "allow",
    write: "ask",
    destructive: "ask",
    unknown: "ask",
  }),
  auto: Object.freeze({
    read: "allow",
    write: "allow",
    destructive: "ask",
    unknown: "ask",
  }),
  dangerous: Object.freeze({
    read: "allow",
    write: "allow",
    destructive: "allow",
    unknown: "allow",
  }),
});

/**
 * Resolves Datus-style profile defaults with optional per-class overrides.
 * The returned object is suitable for a server-side execution boundary only;
 * it must never be derived from browser state or an LLM instruction.
 */
export function createDatabasePermissionPolicy(
  input: DatabasePermissionPolicyInput = {},
): DatabasePermissionPolicy {
  const profile = input.profile ?? "normal";
  const defaults = PROFILE_SQL_STATEMENT_RULES[profile];
  if (defaults === undefined) throw new TypeError("Unknown database permission profile.");

  return Object.freeze({
    profile,
    sqlStatements: Object.freeze({
      ...defaults,
      ...input.sqlStatements,
    }),
  });
}

/**
 * Assigns a conservative Datus-compatible class from SQL text. This is not a
 * SQL parser or an execution validator: future write execution must still
 * parse and validate dialect-specific SQL before calling a connector.
 */
export function classifyDatabaseSqlStatement(sql: string): DatabaseSqlStatementClass {
  const source = stripLeadingSqlComments(sql);
  if (!source || !hasOneCompleteSqlStatement(source)) return "unknown";

  const keyword = source.match(/^([A-Za-z_]+)/)?.[1]?.toLocaleUpperCase("en-US");
  switch (keyword) {
    case "SELECT":
      // SELECT INTO creates a relation and SELECT ... FOR UPDATE/SHARE
      // changes locking behavior. Neither can inherit read auto-approval.
      return /\bINTO\b|\bFOR\s+(?:UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(source)
        ? "unknown"
        : "read";
    case "SHOW":
    case "DESCRIBE":
    case "DESC":
    case "VALUES":
      return "read";
    case "EXPLAIN":
      // EXPLAIN ANALYZE runs the explained statement, which can mutate data.
      return /\bANALYZE\b/i.test(source) ? "unknown" : "read";
    case "INSERT":
      // Upsert variants may update existing rows and must not inherit INSERT's
      // non-destructive classification.
      return /^INSERT\s+OR\s+REPLACE\b|\bON\s+DUPLICATE\s+KEY\s+UPDATE\b|\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(source)
        ? "destructive"
        : "write";
    case "CREATE":
    case "COMMENT":
    case "GRANT":
    case "REVOKE":
    case "ANALYZE":
    case "VACUUM":
    case "USE":
    case "SET":
    case "RESET":
    case "BEGIN":
    case "START":
    case "COMMIT":
    case "ROLLBACK":
    case "SAVEPOINT":
    case "RELEASE":
    case "PREPARE":
    case "DEALLOCATE":
      return "write";
    case "UPDATE":
    case "DELETE":
    case "MERGE":
    case "DROP":
    case "TRUNCATE":
    case "ALTER":
    case "REPLACE":
    case "RENAME":
      return "destructive";
    // A CTE can contain data-modifying statements. Without a dialect parser,
    // treating a WITH query as a read would be unsafe.
    case "WITH":
    default:
      return "unknown";
  }
}

/**
 * Resolves the permission for SQL text or an already-classified statement.
 * `ask` represents an approval boundary; it does not authorize execution.
 */
export function evaluateDatabaseSqlPermission(
  policy: DatabasePermissionPolicy,
  sqlOrStatementClass: string | DatabaseSqlStatementClass,
): DatabaseSqlPermissionEvaluation {
  const statementClass = SQL_STATEMENT_CLASSES.has(sqlOrStatementClass as DatabaseSqlStatementClass)
    ? sqlOrStatementClass as DatabaseSqlStatementClass
    : classifyDatabaseSqlStatement(sqlOrStatementClass);
  return Object.freeze({
    statementClass,
    permission: policy.sqlStatements[statementClass],
  });
}

function stripLeadingSqlComments(value: string): string {
  let source = value.trimStart();
  while (source) {
    if (source.startsWith("--") || source.startsWith("#")) {
      const lineEnd = source.indexOf("\n");
      source = lineEnd === -1 ? "" : source.slice(lineEnd + 1).trimStart();
      continue;
    }
    if (source.startsWith("/*")) {
      const commentEnd = source.indexOf("*/", 2);
      source = commentEnd === -1 ? "" : source.slice(commentEnd + 2).trimStart();
      continue;
    }
    break;
  }
  return source;
}

/** Rejects multi-statements and malformed, unclosed literal/comment sources. */
function hasOneCompleteSqlStatement(source: string): boolean {
  let quote: "single" | "double" | "backtick" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote === "single") {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        quote = undefined;
      }
      continue;
    }
    if (quote === "double") {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        quote = undefined;
      }
      continue;
    }
    if (quote === "backtick") {
      if (character === "`" && next === "`") {
        index += 1;
      } else if (character === "`") {
        quote = undefined;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
    } else if (character === "#") {
      lineComment = true;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (character === "`") {
      quote = "backtick";
    } else if (character === ";" && stripLeadingSqlComments(source.slice(index + 1))) {
      return false;
    }
  }

  return quote === undefined && !blockComment;
}
