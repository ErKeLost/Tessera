import { describe, expect, test } from "bun:test";
import { createTursoConnector } from "./index";

describe("TursoConnector", () => {
  test("accepts Turso/libSQL URLs without opening a connection eagerly", async () => {
    const connector = createTursoConnector({
      connectionString: "libsql://warehouse-example.turso.io",
      authToken: "server-only-token",
    });
    expect(connector.dialect).toBe("turso");
    expect(connector.id).toBe("turso:warehouse-example.turso.io");
    await connector.close();
  });

  test("accepts the turso alias and rejects local file URLs", async () => {
    const connector = createTursoConnector({
      connectionString: "turso://warehouse-example.turso.io",
    });
    expect(connector.dialect).toBe("turso");
    await connector.close();
    expect(() => createTursoConnector({
      connectionString: "file:/tmp/warehouse.db",
    })).toThrow("libsql");
  });
});
