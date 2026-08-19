import { describe, expect, test } from "bun:test";
import { createDataAgent } from "@data-elements/data-agent";
import {
  createDatabaseScopedPermissionPolicy,
  finalizeCatalog,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseMutationExecutor,
} from "@data-elements/database";
import { InMemoryDurableStateStore } from "@data-elements/runtime";
import { defineTesseraConfig } from "./config";
import { createTesseraDatabaseActionService } from "./database-actions";
import { createStudioApp, createTesseraStudioRuntime } from "./server";
import { createTesseraStudioRuntimeManager } from "./settings-runtime";

const IDENTITY = { subject: "alice", tenantId: "tenant-a", roles: ["operator"] } as const;

describe("Tessera Studio database action routes", () => {
  test("never exposes actions from a read-only managed runtime", async () => {
    const { connector, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "auto" }),
    });
    const manager = await createTesseraStudioRuntimeManager({
      config: runtimeConfig(),
      accessMode: "read-only",
      factory: {
        async create() {
          return {
            connector,
            dataAgent: createDataAgent({ connector }),
            // A host factory cannot bypass the manager's read-only boundary.
            databaseActions: service,
            async close() {},
          };
        },
      },
    });
    const app = createStudioApp({
      connector,
      settingsRuntime: manager,
      authenticate: () => IDENTITY,
      requireAuthentication: true,
    });

    try {
      const capabilities = await app.fetch(request("/api/database-actions/capabilities"));
      expect(capabilities.status).toBe(503);
      expect(await capabilities.json()).toMatchObject({ error: { code: "database_actions_unavailable" } });

      const mutation = await app.fetch(jsonRequest("/api/database-actions", {}));
      expect(mutation.status).toBe(503);
      expect(mutations).toHaveLength(0);
    } finally {
      await manager.close();
    }
  });

  test("defaults static runtimes to read-only even when a host injects an action service", async () => {
    const { connector, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "auto" }),
    });
    const runtime = createTesseraStudioRuntime(runtimeConfig(), {
      connector,
      databaseActions: service,
      authenticate: () => IDENTITY,
    });

    try {
      expect(runtime.databaseActions).toBeUndefined();
      const capabilities = await runtime.app.fetch(request("/api/database-actions/capabilities"));
      expect(capabilities.status).toBe(503);
      expect(await capabilities.json()).toMatchObject({ error: { code: "database_actions_unavailable" } });
      expect(mutations).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  test("exposes static actions only after an explicit read-write opt-in", async () => {
    const { connector } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "auto" }),
    });
    const runtime = createTesseraStudioRuntime(runtimeConfig(), {
      connector,
      databaseActions: service,
      accessMode: "read-write",
      authenticate: () => IDENTITY,
    });

    try {
      expect(runtime.databaseActions).toBe(service);
      const capabilities = await runtime.app.fetch(request("/api/database-actions/capabilities"));
      expect(capabilities.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  test("exposes typed capabilities and executes an authenticated insert without raw SQL", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "auto" }),
    });
    const app = createStudioApp({
      connector,
      databaseActions: service,
      authenticate: () => IDENTITY,
      requireAuthentication: true,
    });

    const capabilities = await app.fetch(request("/api/database-actions/capabilities"));
    expect(capabilities.status).toBe(200);
    expect(await capabilities.text()).toContain("database.mutate");

    const response = await app.fetch(jsonRequest("/api/database-actions", {
      action: {
        version: 1,
        kind: "data.insert",
        connectionRef: catalog.connectorId,
        databaseRef: catalog.databaseName,
        catalogFingerprint: catalog.fingerprint,
        relation: { schema: "public", table: "orders" },
        values: [{ id: "order-1", status: "new" }],
        maxAffectedRows: 1,
      },
      purpose: "Create one order",
      requestId: "route-insert-1",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("INSERT INTO");
    expect(mutations).toHaveLength(1);
  });

  test("uses the public catalog alias for an approved write without exposing the connector id", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
    });
    const app = createStudioApp({
      connector,
      databaseActions: service,
      authenticate: () => IDENTITY,
      requireAuthentication: true,
    });

    const catalogResponse = await app.fetch(request("/api/catalog"));
    const catalogText = await catalogResponse.text();
    expect(catalogResponse.status).toBe(200);
    expect(catalogText).not.toContain(catalog.connectorId);
    expect((JSON.parse(catalogText) as { catalog: { connectionRef: string } }).catalog.connectionRef).toBe("tessera");

    const pending = await app.fetch(jsonRequest("/api/database-actions", {
      action: {
        version: 1,
        kind: "data.update",
        connectionRef: "tessera",
        databaseRef: catalog.databaseName,
        catalogFingerprint: catalog.fingerprint,
        relation: { schema: "public", table: "orders" },
        patch: { status: "archived" },
        where: { kind: "comparison", column: "id", op: "eq", value: "order-1" },
        maxAffectedRows: 1,
      },
      purpose: "Archive one order",
      requestId: "route-update-1",
    }));
    expect(pending.status).toBe(202);
    const pendingText = await pending.text();
    expect(pendingText).not.toContain(catalog.connectorId);
    const pendingBody = JSON.parse(pendingText) as { approval?: { checkpointId?: string } };
    expect(pendingBody.approval?.checkpointId).toBeString();
    expect(mutations).toHaveLength(0);

    const approved = await app.fetch(jsonRequest("/api/database-actions/route-update-1/approval", {
      checkpointId: pendingBody.approval!.checkpointId,
      decision: "approve",
    }));
    expect(approved.status).toBe(200);
    const approvedText = await approved.text();
    expect(approvedText).not.toContain(catalog.connectorId);
    expect((JSON.parse(approvedText) as { summary?: { status?: string } }).summary?.status).toBe("succeeded");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.plan.action.connectionRef).toBe(catalog.connectorId);

    const rawSql = await app.fetch(jsonRequest("/api/database-actions", {
      sql: "DELETE FROM orders",
      purpose: "Delete everything",
    }));
    expect(rawSql.status).toBe(400);
    expect(await rawSql.text()).not.toContain("DELETE FROM");
  });
});

function runtimeConfig() {
  return defineTesseraConfig({
    database: {
      dialect: "postgres",
      url: "postgresql://readonly:secret@localhost/analytics",
    },
  });
}

function request(path: string): Request {
  return new Request(`http://127.0.0.1:4317${path}`);
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:4317${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createConnector(): {
  connector: DatabaseConnector & DatabaseMutationExecutor;
  catalog: DatabaseCatalog;
  mutations: Parameters<DatabaseMutationExecutor["mutate"]>[0][];
} {
  const catalog = finalizeCatalog({
    connectorId: "warehouse",
    dialect: "postgres",
    databaseName: "analytics",
    scannedAt: "2026-08-19T00:00:00.000Z",
    schemas: [{
      name: "public",
      tables: [{
        schema: "public",
        name: "orders",
        kind: "table",
        columns: [
          { name: "id", dataType: "text", nullable: false, ordinal: 1 },
          { name: "status", dataType: "text", nullable: false, ordinal: 2 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      }],
    }],
  });
  const mutations: Parameters<DatabaseMutationExecutor["mutate"]>[0][] = [];
  const connector: DatabaseConnector & DatabaseMutationExecutor = {
    id: "warehouse",
    dialect: "postgres",
    async assess() {
      return {
        connectorId: "warehouse",
        dialect: "postgres",
        connected: true,
        databaseName: "analytics",
        readOnlyTransactions: false,
        credentialCanWrite: true,
        warnings: [],
      };
    },
    async introspect() {
      return catalog;
    },
    async query() {
      return { queryId: "query-read", columns: [], rows: [], rowCount: 0, truncated: false, durationMs: 1 };
    },
    async mutate(request) {
      mutations.push(request);
      return {
        mutationId: request.mutationId,
        queryId: `query-${mutations.length}`,
        affectedRows: 1,
        columns: [],
        rows: [],
        truncated: false,
        durationMs: 1,
      };
    },
    async close() {},
  };
  return { connector, catalog, mutations };
}
