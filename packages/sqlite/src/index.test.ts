import { describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteConnector } from "./index";

describe("SqliteConnector", () => {
  test("rejects unsupported and missing local database URLs", () => {
    expect(() => createSqliteConnector({
      connectionString: "postgresql://localhost/app",
    })).toThrow("file:");
    expect(() => createSqliteConnector({
      connectionString: "file:/tmp/data-elements-missing-sqlite.db",
    })).toThrow("existing database file");
  });

  test("introspects keys and executes bounded parameterized reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "data-elements-sqlite-"));
    const databasePath = join(directory, "warehouse.db");
    const databaseUrl = pathToFileURL(databasePath).href;
    const setup = createClient({ url: databaseUrl });
    await setup.executeMultiple(
      "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);"
      + "CREATE TABLE orders ("
      + "id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, total REAL,"
      + "FOREIGN KEY (customer_id) REFERENCES customers(id));",
    );
    await setup.execute({
      sql: "INSERT INTO customers(id, name) VALUES (?, ?), (?, ?)",
      args: [1, "Ada", 2, "Lin"],
    });
    await setup.execute({
      sql: "INSERT INTO orders(id, customer_id, total) VALUES (?, ?, ?), (?, ?, ?)",
      args: [10, 1, 12.5, 11, 2, 20],
    });
    setup.close();

    const connector = createSqliteConnector({
      connectionString: databaseUrl,
      maxRows: 1,
    });
    try {
      const assessment = await connector.assess();
      expect(assessment.connected).toBe(true);
      expect(assessment.dialect).toBe("sqlite");
      expect(assessment.readOnlyTransactions).toBe(true);

      const catalog = await connector.introspect();
      const orders = catalog.schemas[0]?.tables.find((table) => table.name === "orders");
      expect(orders?.primaryKey).toEqual(["id"]);
      expect(orders?.foreignKeys[0]).toMatchObject({
        columns: ["customer_id"],
        referencedSchema: "main",
        referencedTable: "customers",
        referencedColumns: ["id"],
      });

      const extensions = await connector.inspectExtensions();
      expect(extensions.dialect).toBe("sqlite");
      expect(extensions.extensions.every((extension) => extension.kind === "module")).toBe(true);

      const result = await connector.query({
        sql: "SELECT id, total FROM main.orders WHERE total >= ? ORDER BY id",
        parameters: [10],
        purpose: "Connector regression test",
      });
      expect(result.rows).toEqual([{ id: 10, total: 12.5 }]);
      expect(result.truncated).toBe(true);

      await expect(connector.query({
        sql: "DELETE FROM main.orders",
        purpose: "Must remain read-only",
      })).rejects.toThrow("Only SELECT");
    } finally {
      await connector.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
