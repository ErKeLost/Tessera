import { describe, expect, test } from "bun:test";
import {
  compileDatabaseMutation,
  finalizeCatalog,
  type DatabaseCatalog,
  type DatabaseDdlAction,
  type DatabaseDdlOperation,
  type DatabaseDialect,
} from "./index";

function catalogFor(dialect: DatabaseDialect): DatabaseCatalog {
  return finalizeCatalog({
    connectorId: "warehouse",
    dialect,
    databaseName: "analytics",
    scannedAt: "2026-08-19T00:00:00.000Z",
    schemas: [{
      name: "public",
      tables: [{
        schema: "public",
        name: "orders",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "created_at", dataType: "timestamp", nullable: false, ordinal: 2 },
          { name: "notes", dataType: "text", nullable: true, ordinal: 3 },
          { name: "status", dataType: "text", nullable: false, ordinal: 4 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      }, {
        schema: "public",
        name: "archived_orders",
        kind: "table",
        columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
        primaryKey: ["id"],
        foreignKeys: [],
      }],
    }, {
      name: "archive",
      tables: [],
    }],
  });
}

function updateAction(catalog: DatabaseCatalog, returning = false) {
  return {
    version: 1 as const,
    kind: "data.update" as const,
    connectionRef: catalog.connectorId,
    databaseRef: catalog.databaseName,
    catalogFingerprint: catalog.fingerprint,
    relation: { schema: "public", table: "orders" },
    patch: { status: "archived", notes: "needs-review" },
    where: {
      kind: "all" as const,
      items: [
        { kind: "comparison" as const, column: "id", op: "in" as const, value: ["o-1", "o-2"] },
        { kind: "comparison" as const, column: "created_at", op: "between" as const, value: ["2026-01-01", "2026-01-31"] },
        { kind: "comparison" as const, column: "notes", op: "contains" as const, value: "fragile" },
      ],
    },
    maxAffectedRows: 2,
    ...(returning ? { returning: ["id", "status"] } : {}),
  };
}

function ddlAction(catalog: DatabaseCatalog, operation: DatabaseDdlOperation): DatabaseDdlAction {
  return {
    version: 1 as const,
    kind: "data.ddl" as const,
    connectionRef: catalog.connectorId,
    databaseRef: catalog.databaseName,
    catalogFingerprint: catalog.fingerprint,
    relation: { schema: "public", table: "orders" },
    operation,
  };
}

describe("database mutation compiler", () => {
  test("generates sequential PostgreSQL parameters in statement order", () => {
    const catalog = catalogFor("postgres");
    const plan = compileDatabaseMutation({
      action: updateAction(catalog, true),
      catalog,
      purpose: "Archive two orders",
    });

    expect(plan.compiled).toEqual({
      sql: "UPDATE \"public\".\"orders\" SET \"notes\" = $1, \"status\" = $2 WHERE (\"id\" IN ($3, $4) AND \"created_at\" BETWEEN $5 AND $6 AND \"notes\" LIKE $7) RETURNING \"id\", \"status\"",
      parameters: ["needs-review", "archived", "o-1", "o-2", "2026-01-01", "2026-01-31", "%fragile%"],
    });
    expect(plan.compiled.sql).not.toContain("needs-review");
    expect(plan.compiled.sql).not.toContain("o-1");
  });

  test("generates MySQL placeholders while preserving the same parameter order", () => {
    const catalog = catalogFor("mysql");
    const plan = compileDatabaseMutation({
      action: updateAction(catalog),
      catalog,
      purpose: "Archive two orders",
    });

    expect(plan.compiled).toEqual({
      sql: "UPDATE `public`.`orders` SET `notes` = ?, `status` = ? WHERE (`id` IN (?, ?) AND `created_at` BETWEEN ? AND ? AND `notes` LIKE ?)",
      parameters: ["needs-review", "archived", "o-1", "o-2", "2026-01-01", "2026-01-31", "%fragile%"],
    });
  });

  test("rejects an action whose database label differs from the current catalog", () => {
    const catalog = catalogFor("postgres");
    expect(() => compileDatabaseMutation({
      action: { ...updateAction(catalog), databaseRef: "other_database" },
      catalog,
      purpose: "Archive two orders",
    })).toThrow("Database action database does not match the catalog.");
  });

  test("validates DDL column and index-column bindings against the catalog", () => {
    const catalog = catalogFor("postgres");
    const compile = (operation: DatabaseDdlOperation) => compileDatabaseMutation({
      action: ddlAction(catalog, operation),
      catalog,
      purpose: "Schema maintenance",
    });

    expect(() => compile({ kind: "add-column", column: { name: "status", dataType: "text", nullable: true } }))
      .toThrow('Column "status" already exists in the catalog.');
    expect(() => compile({ kind: "drop-column", column: "missing" }))
      .toThrow('Column "missing" is not present in the catalog.');
    expect(() => compile({ kind: "rename-column", column: "missing", to: "state" }))
      .toThrow('Column "missing" is not present in the catalog.');
    expect(() => compile({ kind: "rename-column", column: "status", to: "notes" }))
      .toThrow('Column "notes" already exists in the catalog.');
    expect(() => compile({ kind: "create-index", indexName: "orders_missing_idx", columns: ["missing"], unique: false }))
      .toThrow('Column "missing" is not present in the catalog.');
    expect(() => compile({ kind: "create-index", indexName: "orders_status_idx", columns: ["status", "status"], unique: false }))
      .toThrow('Index column "status" is duplicated.');
    expect(() => compile({ kind: "drop-index", indexName: "orders_status_idx" }))
      .toThrow("The current catalog does not expose indexes, so drop-index cannot be compiled.");

    expect(compile({ kind: "create-index", indexName: "orders_status_idx", columns: ["status", "created_at"], unique: true }).compiled)
      .toEqual({
        sql: "CREATE UNIQUE INDEX \"orders_status_idx\" ON \"public\".\"orders\" (\"status\", \"created_at\")",
        parameters: [],
      });
  });

  test("requires create-table primary keys to reference declared, unique columns", () => {
    const catalog = catalogFor("postgres");
    const compile = (operation: DatabaseDdlOperation) => compileDatabaseMutation({
      action: {
        ...ddlAction(catalog, operation),
        relation: { schema: "public", table: "new_orders" },
      },
      catalog,
      purpose: "Create a table",
    });

    expect(() => compile({
      kind: "create-table",
      columns: [{ name: "id", dataType: "uuid", nullable: false }],
      primaryKey: ["missing"],
    })).toThrow('Primary key column "missing" is not declared by the table.');
    expect(() => compile({
      kind: "create-table",
      columns: [
        { name: "id", dataType: "uuid", nullable: false },
        { name: "id", dataType: "text", nullable: true },
      ],
      primaryKey: [],
    })).toThrow('Table column "id" is duplicated.');
  });

  test("keeps table renames inside their bound schema and rejects occupied targets", () => {
    const catalog = catalogFor("postgres");
    const compile = (operation: DatabaseDdlOperation) => compileDatabaseMutation({
      action: ddlAction(catalog, operation),
      catalog,
      purpose: "Rename a table",
    });

    expect(() => compile({ kind: "rename-table", to: { schema: "archive", table: "orders" } }))
      .toThrow("Table rename must remain in the same schema.");
    expect(() => compile({ kind: "rename-table", to: { schema: "public", table: "archived_orders" } }))
      .toThrow("The table rename destination already exists in the catalog.");
    expect(compile({ kind: "rename-table", to: { schema: "public", table: "orders_2026" } }).compiled)
      .toEqual({ sql: "ALTER TABLE \"public\".\"orders\" RENAME TO \"orders_2026\"", parameters: [] });
  });
});
