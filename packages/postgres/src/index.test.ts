import { describe, expect, test } from "bun:test";
import { createDatabaseMutationPlan } from "@open-tessera/database";
import { createPostgresConnector } from "./index";

describe("PostgresConnector", () => {
  test("rejects a non-PostgreSQL URL before opening a connection", () => {
    expect(() => createPostgresConnector({ connectionString: "mysql://localhost/app" })).toThrow("postgres://");
  });

  test("uses conservative query defaults", () => {
    const connector = createPostgresConnector({
      connectionString: "postgresql://readonly:secret@localhost/warehouse",
      schemas: ["public"],
    });
    expect(connector.id).toBe("postgres:localhost");
    expect(typeof connector.mutate).toBe("function");
    expect(typeof connector.inspectExtensions).toBe("function");
    expect(typeof connector.inspectRlsPolicies).toBe("function");
  });

  test("rejects a plan for another connection before opening a database session", async () => {
    const connector = createPostgresConnector({
      connectionString: "postgresql://readonly:secret@localhost/warehouse",
      schemas: ["public"],
    });
    const plan = createDatabaseMutationPlan({
      action: {
        version: 1,
        kind: "data.update",
        connectionRef: "other-connection",
        catalogFingerprint: `sha256:${"a".repeat(64)}`,
        relation: { schema: "public", table: "orders" },
        patch: { status: "archived" },
        where: { kind: "comparison", column: "id", op: "eq", value: "order-1" },
        maxAffectedRows: 1,
      },
      purpose: "Archive one order",
      compiled: {
        sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1 WHERE \"id\" = $2",
        parameters: ["archived", "order-1"],
      },
    });

    await expect(connector.mutate({ mutationId: "mutation-1", plan })).rejects.toThrow(
      "does not match this connector",
    );
    await connector.close();
  });

  test("rejects SQL and parameter tampering before opening a database session", async () => {
    const connector = createPostgresConnector({
      connectionString: "postgresql://readonly:secret@localhost/warehouse",
      schemas: ["public"],
    });
    const plan = createDatabaseMutationPlan({
      action: {
        version: 1,
        kind: "data.update",
        connectionRef: connector.id,
        catalogFingerprint: `sha256:${"a".repeat(64)}`,
        relation: { schema: "public", table: "orders" },
        patch: { status: "archived" },
        where: { kind: "comparison", column: "id", op: "eq", value: "order-1" },
        maxAffectedRows: 1,
      },
      purpose: "Archive one order",
      compiled: {
        sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1 WHERE \"id\" = $2",
        parameters: ["archived", "order-1"],
      },
    });

    await expect(connector.mutate({
      mutationId: "mutation-sql-tampered",
      plan: { ...plan, compiled: { ...plan.compiled, sql: "DELETE FROM \"public\".\"orders\"" } },
    })).rejects.toThrow("Database mutation compiled SQL or parameters do not match their hash.");
    await expect(connector.mutate({
      mutationId: "mutation-parameters-tampered",
      plan: { ...plan, compiled: { ...plan.compiled, parameters: ["changed", "order-1"] } },
    })).rejects.toThrow("Database mutation compiled SQL or parameters do not match their hash.");
    await connector.close();
  });
});
