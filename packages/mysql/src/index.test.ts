import { describe, expect, test } from "bun:test";
import { createDatabaseMutationPlan } from "@open-tessera/database";
import { createMySqlConnector } from "./index";

describe("MySqlConnector", () => {
  test("rejects a non-MySQL URL before opening a connection", () => {
    expect(() =>
      createMySqlConnector({
        connectionString: "postgresql://localhost/warehouse",
      }),
    ).toThrow("mysql://");
  });

  test("uses conservative query defaults", () => {
    const connector = createMySqlConnector({
      connectionString: "mysql://readonly:secret@localhost/warehouse",
      schemas: ["warehouse"],
    });
    expect(connector.id).toBe("mysql:localhost");
    expect(typeof connector.mutate).toBe("function");
    expect(typeof connector.inspectExtensions).toBe("function");
  });

  test("rejects a plan for another connection before opening a database session", async () => {
    const connector = createMySqlConnector({
      connectionString: "mysql://readonly:secret@localhost/warehouse",
      schemas: ["warehouse"],
    });
    const plan = createDatabaseMutationPlan({
      action: {
        version: 1,
        kind: "data.update",
        connectionRef: "other-connection",
        catalogFingerprint: `sha256:${"a".repeat(64)}`,
        relation: { schema: "warehouse", table: "orders" },
        patch: { status: "archived" },
        where: { kind: "comparison", column: "id", op: "eq", value: "order-1" },
        maxAffectedRows: 1,
      },
      purpose: "Archive one order",
      compiled: {
        sql: "UPDATE `warehouse`.`orders` SET `status` = ? WHERE `id` = ?",
        parameters: ["archived", "order-1"],
      },
    });

    await expect(connector.mutate({ mutationId: "mutation-1", plan })).rejects.toThrow(
      "does not match this connector",
    );
    await connector.close();
  });

  test("rejects SQL and parameter tampering before opening a database session", async () => {
    const connector = createMySqlConnector({
      connectionString: "mysql://readonly:secret@localhost/warehouse",
      schemas: ["warehouse"],
    });
    const plan = createDatabaseMutationPlan({
      action: {
        version: 1,
        kind: "data.update",
        connectionRef: connector.id,
        catalogFingerprint: `sha256:${"a".repeat(64)}`,
        relation: { schema: "warehouse", table: "orders" },
        patch: { status: "archived" },
        where: { kind: "comparison", column: "id", op: "eq", value: "order-1" },
        maxAffectedRows: 1,
      },
      purpose: "Archive one order",
      compiled: {
        sql: "UPDATE `warehouse`.`orders` SET `status` = ? WHERE `id` = ?",
        parameters: ["archived", "order-1"],
      },
    });

    await expect(connector.mutate({
      mutationId: "mutation-sql-tampered",
      plan: { ...plan, compiled: { ...plan.compiled, sql: "DELETE FROM `warehouse`.`orders`" } },
    })).rejects.toThrow("Database mutation compiled SQL or parameters do not match their hash.");
    await expect(connector.mutate({
      mutationId: "mutation-parameters-tampered",
      plan: { ...plan, compiled: { ...plan.compiled, parameters: ["changed", "order-1"] } },
    })).rejects.toThrow("Database mutation compiled SQL or parameters do not match their hash.");
    await connector.close();
  });
});
