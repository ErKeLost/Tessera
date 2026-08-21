import type {
  DatabaseAction,
  DatabaseCatalog,
  DatabaseMutationAction,
  DatabaseMutationPlan,
  DatabasePredicate,
} from "./index";
import { assertDatabaseActionCatalogBinding } from "./actions";
import { databaseMutationActionSchema, createDatabaseMutationPlan } from "./mutation";

export type CompileDatabaseMutationInput = Readonly<{
  action: DatabaseMutationAction;
  catalog: DatabaseCatalog;
  purpose: string;
}>;

/**
 * Compiles a catalog-bound typed mutation into parameterized SQL. Identifiers
 * come from the current catalog/action binding; values are always parameters.
 */
export function compileDatabaseMutation(input: CompileDatabaseMutationInput): DatabaseMutationPlan {
  const catalog = input.catalog;
  if (catalog.dialect !== "postgres" && catalog.dialect !== "mysql") {
    throw new TypeError("This database dialect is not supported by the SQL mutation compiler.");
  }
  const action = assertDatabaseActionCatalogBinding(
    databaseMutationActionSchema.parse(input.action),
    catalog,
  ) as DatabaseMutationAction;

  if (!catalog.schemas.some((schema) => schema.name === action.relation.schema)) {
    throw new TypeError("Mutation schema is not present in the catalog.");
  }
  const table = findTable(catalog, action.relation.schema, action.relation.table);
  if (action.kind !== "data.ddl" || !isCreateTable(action)) {
    if (!table) throw new TypeError("Mutation relation is not present in the catalog.");
  }

  const compiled = action.kind === "data.ddl"
    ? compileDdl(action, catalog, table)
    : compileDataMutation(action, catalog, table!);
  return createDatabaseMutationPlan({ action, purpose: input.purpose, compiled });
}

function compileDataMutation(
  action: Exclude<DatabaseMutationAction, { kind: "data.ddl" }>,
  catalog: DatabaseCatalog,
  table: NonNullable<ReturnType<typeof findTable>>,
): { sql: string; parameters: Array<string | number | boolean | null> } {
  const dialect = catalog.dialect;
  const qualified = qualify(action.relation.schema, action.relation.table, dialect);
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const parameters: Array<string | number | boolean | null> = [];
  const bind = (value: string | number | boolean | null): string => {
    parameters.push(value);
    return dialect === "postgres" ? `$${parameters.length}` : "?";
  };
  const columnName = (name: string): string => {
    if (!columns.has(name)) throw new TypeError(`Column "${name}" is not present in the catalog.`);
    return quoteIdentifier(name, dialect);
  };
  const returning = "returning" in action && action.returning
    ? ` RETURNING ${action.returning.map(columnName).join(", ")}`
    : "";
  if (returning && dialect === "mysql") throw new TypeError("MySQL mutations do not support returning columns.");

  if (action.kind === "data.insert") {
    const names = Object.keys(action.values[0]!).sort();
    names.forEach(columnName);
    for (const row of action.values) {
      const rowNames = Object.keys(row).sort();
      if (rowNames.join("\u0000") !== names.join("\u0000")) throw new TypeError("Inserted rows must use the same columns.");
    }
    const valuesSql = action.values.map((row) => `(${names.map((name) => {
      return bind(row[name]!);
    }).join(", ")})`).join(", ");
    return {
      sql: `INSERT INTO ${qualified} (${names.map((name) => quoteIdentifier(name, dialect)).join(", ")}) VALUES ${valuesSql}${returning}`,
      parameters,
    };
  }

  if (action.kind === "data.update") {
    const names = Object.keys(action.patch).sort();
    names.forEach(columnName);
    const assignments = names.map((name) => `${quoteIdentifier(name, dialect)} = ${bind(action.patch[name]!)}`);
    const where = compilePredicate(action.where, columnName, bind);
    return {
      sql: `UPDATE ${qualified} SET ${assignments.join(", ")} WHERE ${where}${returning}`,
      parameters,
    };
  }
  const where = compilePredicate(action.where, columnName, bind);
  return { sql: `DELETE FROM ${qualified} WHERE ${where}${returning}`, parameters };
}

function compileDdl(
  action: Extract<DatabaseMutationAction, { kind: "data.ddl" }>,
  catalog: DatabaseCatalog,
  table: ReturnType<typeof findTable>,
): { sql: string; parameters: [] } {
  const dialect = catalog.dialect;
  const relation = qualify(action.relation.schema, action.relation.table, dialect);
  const operation = action.operation;
  switch (operation.kind) {
    case "create-table":
      if (table) throw new TypeError("The table already exists in the catalog.");
      assertDistinct(operation.columns.map(({ name }) => name), "Table column");
      assertDistinct(operation.primaryKey, "Primary key column");
      assertColumnsDeclared(operation.primaryKey, new Set(operation.columns.map(({ name }) => name)), "Primary key");
      return {
        sql: `CREATE TABLE ${relation} (${operation.columns.map((column) => `${quoteIdentifier(column.name, dialect)} ${ddlType(column.dataType)}${column.nullable ? "" : " NOT NULL"}`).join(", ")}${operation.primaryKey.length ? `, PRIMARY KEY (${operation.primaryKey.map((column) => quoteIdentifier(column, dialect)).join(", ")})` : ""})`,
        parameters: [],
      };
    case "drop-table":
      return { sql: `DROP TABLE ${relation}`, parameters: [] };
    case "truncate-table":
      return { sql: `TRUNCATE TABLE ${relation}`, parameters: [] };
    case "add-column":
      assertColumnAbsent(table!, operation.column.name);
      return { sql: `ALTER TABLE ${relation} ADD COLUMN ${quoteIdentifier(operation.column.name, dialect)} ${ddlType(operation.column.dataType)}${operation.column.nullable ? "" : " NOT NULL"}`, parameters: [] };
    case "drop-column":
      assertCatalogColumns(table!, [operation.column]);
      return { sql: `ALTER TABLE ${relation} DROP COLUMN ${quoteIdentifier(operation.column, dialect)}`, parameters: [] };
    case "rename-table":
      assertRenameTableTarget(action, catalog);
      return { sql: `ALTER TABLE ${relation} RENAME TO ${quoteIdentifier(operation.to.table, dialect)}`, parameters: [] };
    case "rename-column":
      assertCatalogColumns(table!, [operation.column]);
      assertColumnAbsent(table!, operation.to);
      return { sql: `ALTER TABLE ${relation} RENAME COLUMN ${quoteIdentifier(operation.column, dialect)} TO ${quoteIdentifier(operation.to, dialect)}`, parameters: [] };
    case "create-index":
      assertDistinct(operation.columns, "Index column");
      assertCatalogColumns(table!, operation.columns);
      return { sql: `CREATE ${operation.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(operation.indexName, dialect)} ON ${relation} (${operation.columns.map((column) => quoteIdentifier(column, dialect)).join(", ")})`, parameters: [] };
    case "drop-index":
      throw new TypeError("The current catalog does not expose indexes, so drop-index cannot be compiled.");
  }
}

function compilePredicate(
  predicate: DatabasePredicate,
  columnName: (name: string) => string,
  bind: (value: string | number | boolean | null) => string,
): string {
  switch (predicate.kind) {
    case "all": return `(${predicate.items.map((item) => compilePredicate(item, columnName, bind)).join(" AND ")})`;
    case "any": return `(${predicate.items.map((item) => compilePredicate(item, columnName, bind)).join(" OR ")})`;
    case "not": return `(NOT ${compilePredicate(predicate.item, columnName, bind)})`;
    case "null": return `${columnName(predicate.column)} IS ${predicate.isNull ? "NULL" : "NOT NULL"}`;
    case "comparison": {
      const column = columnName(predicate.column);
      if (predicate.op === "in") {
        const values = predicate.value as readonly (string | number | boolean)[];
        return `${column} IN (${values.map(bind).join(", ")})`;
      }
      if (predicate.op === "between") {
        const values = predicate.value as readonly (string | number | boolean)[];
        return `${column} BETWEEN ${bind(values[0]!)} AND ${bind(values[1]!)}`;
      }
      const op = predicate.op === "contains" ? "LIKE" : ({ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const)[predicate.op];
      const value = predicate.op === "contains"
        ? `%${String(predicate.value)}%`
        : predicate.value as string | number | boolean;
      return `${column} ${op} ${bind(value)}`;
    }
  }
}

function assertCatalogColumns(
  table: NonNullable<ReturnType<typeof findTable>>,
  columns: readonly string[],
): void {
  const catalogColumns = new Set(table.columns.map(({ name }) => name));
  for (const column of columns) {
    if (!catalogColumns.has(column)) throw new TypeError(`Column "${column}" is not present in the catalog.`);
  }
}

function assertColumnAbsent(
  table: NonNullable<ReturnType<typeof findTable>>,
  column: string,
): void {
  if (table.columns.some(({ name }) => name === column)) {
    throw new TypeError(`Column "${column}" already exists in the catalog.`);
  }
}

function assertDistinct(values: readonly string[], label: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate) throw new TypeError(`${label} "${duplicate}" is duplicated.`);
}

function assertColumnsDeclared(
  columns: readonly string[],
  declared: ReadonlySet<string>,
  label: string,
): void {
  for (const column of columns) {
    if (!declared.has(column)) throw new TypeError(`${label} column "${column}" is not declared by the table.`);
  }
}

function assertRenameTableTarget(
  action: Extract<DatabaseMutationAction, { kind: "data.ddl" }>,
  catalog: DatabaseCatalog,
): void {
  if (action.operation.kind !== "rename-table") return;
  if (action.operation.to.schema !== action.relation.schema) {
    throw new TypeError("Table rename must remain in the same schema.");
  }
  if (findTable(catalog, action.operation.to.schema, action.operation.to.table)) {
    throw new TypeError("The table rename destination already exists in the catalog.");
  }
}

function findTable(catalog: DatabaseCatalog, schema: string, table: string) {
  return catalog.schemas.find((item) => item.name === schema)?.tables.find((item) => item.name === table);
}

function isCreateTable(action: Extract<DatabaseAction, { kind: "data.ddl" }>): boolean {
  return action.operation.kind === "create-table";
}

function qualify(schema: string, table: string, dialect: DatabaseCatalog["dialect"]): string {
  return `${quoteIdentifier(schema, dialect)}.${quoteIdentifier(table, dialect)}`;
}

function quoteIdentifier(value: string, dialect: DatabaseCatalog["dialect"]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) throw new TypeError("Database identifiers must be simple catalog identifiers.");
  return dialect === "postgres" ? `"${value}"` : `\`${value}\``;
}

function ddlType(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+UNSIGNED)?$/i.test(normalized)) {
    throw new TypeError("DDL data types must be simple catalog-safe type names.");
  }
  return normalized;
}
