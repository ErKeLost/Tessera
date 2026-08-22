import { describe, expect, test } from "bun:test";
import {
  createDatabaseScopedPermissionPolicy,
  finalizeCatalog,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseMutationExecutor,
} from "@data-elements/database";
import { InMemoryDurableStateStore } from "@data-elements/runtime";
import { createTesseraDatabaseActionService } from "./database-actions";

const ACTOR = { tenantRef: "tenant-a", actorRef: "alice", roleRefs: ["analyst"] } as const;

describe("Tessera database action service", () => {
  test("executes a catalog-bound typed insert and durably returns its narrow result", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "auto" }),
      idFactory: deterministicIds(),
    });

    const submitted = await service.submit({
      actor: ACTOR,
      requestId: "insert-order-1",
      action: insertAction(catalog),
      purpose: "Create one order",
    });

    expect(submitted.summary.status).toBe("succeeded");
    expect(submitted.result).toMatchObject({
      mutationId: expect.stringMatching(/^mutation-/),
      affectedRows: 1,
      actionHash: expect.stringMatching(/^sha256:/),
      catalogFingerprint: catalog.fingerprint,
    });
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.plan.compiled.sql).toBe('INSERT INTO "public"."orders" ("id", "status") VALUES ($1, $2)');
    expect(JSON.stringify(submitted)).not.toContain("customer@example.test");

    const fetched = await service.get({ actor: ACTOR, requestId: "insert-order-1" });
    expect(fetched.result).toEqual(submitted.result);
    expect(fetched.replayed).toBe(true);
  });

  test("can require approval even when policy would auto-allow the mutation", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "dangerous" }),
      idFactory: deterministicIds(),
    });

    const pending = await service.submit({
      actor: ACTOR,
      requestId: "agent-insert-approval",
      action: insertAction(catalog),
      purpose: "Create one order from the Data Agent",
      requireApproval: true,
    });

    expect(pending.summary.status).toBe("awaiting-approval");
    expect(pending.review).toEqual({
      action: { ...insertAction(catalog), connectionRef: "tessera" },
      purpose: "Create one order from the Data Agent",
      compiled: {
        sql: 'INSERT INTO "public"."orders" ("id", "status") VALUES ($1, $2)',
        parameters: ["order-1", "new"],
      },
    });
    expect(mutations).toHaveLength(0);

    const approved = await service.approve({
      actor: ACTOR,
      requestId: pending.summary.requestId,
      checkpointId: pending.approval!.checkpointId,
    });
    expect(approved.summary.status).toBe("succeeded");
    expect(approved.result).toMatchObject({ affectedRows: 1, durationMs: 3 });
    expect(approved.review).toEqual(pending.review);
    expect(mutations).toHaveLength(1);
  });

  test("keeps the compiled review and database diagnostic when execution fails", async () => {
    const { connector, catalog, mutations } = createConnector();
    connector.mutate = async (request) => {
      mutations.push(request);
      throw new Error('update or delete on table "orders" violates foreign key constraint "items_order_id_fkey"');
    };
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
      idFactory: deterministicIds(),
    });
    const pending = await service.submit({
      actor: ACTOR,
      requestId: "failed-order-update",
      action: updateAction(catalog),
      purpose: "Archive one order",
    });

    const failed = await service.approve({
      actor: ACTOR,
      requestId: pending.summary.requestId,
      checkpointId: pending.approval!.checkpointId,
    });

    expect(failed.summary.status).toBe("failed");
    expect(failed.review?.compiled).toEqual({
      sql: 'UPDATE "public"."orders" SET "status" = $1 WHERE "id" = $2',
      parameters: ["archived", "order-1"],
    });
    expect(failed.receipt?.diagnostic).toMatchObject({
      code: "capability.execution-failed",
      message: expect.stringContaining("items_order_id_fkey"),
    });
    expect(mutations).toHaveLength(1);

    const retried = await service.retry({ actor: ACTOR, requestId: failed.summary.requestId });
    expect(retried.summary.status).toBe("awaiting-approval");
    expect(retried.summary.requestId).not.toBe(failed.summary.requestId);
    expect(retried.review).toEqual(failed.review);
    expect(mutations).toHaveLength(1);

    const restoredFromOriginal = await service.get({ actor: ACTOR, requestId: failed.summary.requestId });
    expect(restoredFromOriginal.summary.requestId).toBe(retried.summary.requestId);
    expect(restoredFromOriginal.summary.status).toBe("awaiting-approval");

    const replayedRetry = await service.retry({ actor: ACTOR, requestId: failed.summary.requestId });
    expect(replayedRetry.summary.requestId).toBe(retried.summary.requestId);
    expect(mutations).toHaveLength(1);
  });

  test("holds a destructive mutation for approval and executes it only after approval", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
      idFactory: deterministicIds(),
    });

    const pending = await service.submit({
      actor: ACTOR,
      requestId: "archive-order-1",
      action: updateAction(catalog),
      purpose: "Archive a reviewed order",
    });

    expect(pending.summary.status).toBe("awaiting-approval");
    expect(pending.approval?.checkpointId).toBeDefined();
    expect(mutations).toHaveLength(0);

    const approved = await service.approve({
      actor: ACTOR,
      requestId: "archive-order-1",
      checkpointId: pending.approval!.checkpointId,
    });

    expect(approved.summary.status).toBe("succeeded");
    expect(approved.result?.affectedRows).toBe(1);
    expect(mutations).toHaveLength(1);
  });

  test("binds server row predicates into the approved action and final SQL", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({
        profile: "dangerous",
        resource: { rowPredicateRefs: ["tenant-isolation"] },
      }),
      resolveRowPredicates: ({ actor }) => [{
        ref: "tenant-isolation",
        predicate: { kind: "comparison", column: "tenant_id", op: "eq", value: actor.tenantRef },
      }],
      idFactory: deterministicIds(),
    });

    const result = await service.submit({
      actor: ACTOR,
      requestId: "tenant-bound-update",
      action: updateAction(catalog),
      purpose: "Archive one tenant order",
    });

    expect(result.summary.status).toBe("succeeded");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.plan.compiled).toEqual({
      sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1 WHERE (\"id\" = $2 AND \"tenant_id\" = $3)",
      parameters: ["archived", "order-1", "tenant-a"],
    });
    expect(mutations[0]?.plan.actionHash).toBe(result.result?.actionHash);
  });

  test("fails closed when a row-scoped policy has no server predicate binding", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({
        profile: "dangerous",
        resource: { rowPredicateRefs: ["tenant-isolation"] },
      }),
      idFactory: deterministicIds(),
    });

    const result = await service.submit({
      actor: ACTOR,
      requestId: "unbound-row-update",
      action: updateAction(catalog),
      purpose: "Archive one tenant order",
    });

    expect(result.summary.status).toBe("denied");
    expect(mutations).toHaveLength(0);
  });

  test("rejects a forged database label before policy or mutation execution", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "dangerous" }),
      idFactory: deterministicIds(),
    });

    await expect(service.submit({
      actor: ACTOR,
      requestId: "forged-database-label",
      action: { ...updateAction(catalog), databaseRef: "other_database" },
      purpose: "Archive an order",
    })).rejects.toThrow("Database action database does not match the catalog.");
    expect(mutations).toHaveLength(0);
  });

  test("allows only one concurrent approval to execute a mutation", async () => {
    const { connector, catalog, mutations } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
      idFactory: deterministicIds(),
    });
    const pending = await service.submit({
      actor: ACTOR,
      requestId: "concurrent-approval-update",
      action: updateAction(catalog),
      purpose: "Archive a reviewed order",
    });

    const approvals = await Promise.all([
      service.approve({ actor: ACTOR, requestId: pending.summary.requestId, checkpointId: pending.approval!.checkpointId }),
      service.approve({ actor: ACTOR, requestId: pending.summary.requestId, checkpointId: pending.approval!.checkpointId }),
    ]);

    expect(mutations).toHaveLength(1);
    expect(approvals.some((result) => result.summary.status === "succeeded")).toBe(true);
  });

  test("rejects approval when the scoped policy changed after submission", async () => {
    const { connector, catalog, mutations } = createConnector();
    let policy = createDatabaseScopedPermissionPolicy({ profile: "normal" });
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: () => policy,
      idFactory: deterministicIds(),
    });

    const pending = await service.submit({
      actor: ACTOR,
      requestId: "archive-order-stale-policy",
      action: updateAction(catalog),
      purpose: "Archive a reviewed order",
    });
    expect(pending.summary.status).toBe("awaiting-approval");

    policy = createDatabaseScopedPermissionPolicy({
      profile: "normal",
      rules: [{ id: "deny-archives", permission: "deny", actionKinds: ["data.update"] }],
    });
    const denied = await service.approve({
      actor: ACTOR,
      requestId: "archive-order-stale-policy",
      checkpointId: pending.approval!.checkpointId,
    });

    expect(denied.summary.status).toBe("denied");
    expect(mutations).toHaveLength(0);
  });

  test("checks effect ownership before cancellation", async () => {
    const { connector, catalog } = createConnector();
    const service = createTesseraDatabaseActionService({
      connector,
      state: new InMemoryDurableStateStore(),
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
      idFactory: deterministicIds(),
    });
    const pending = await service.submit({
      actor: ACTOR,
      requestId: "cancel-order-1",
      action: updateAction(catalog),
      purpose: "Archive a reviewed order",
    });
    expect(pending.summary.status).toBe("awaiting-approval");

    await expect(service.cancel({
      actor: { tenantRef: "tenant-a", actorRef: "mallory" },
      requestId: "cancel-order-1",
    })).rejects.toThrow("outside the actor scope");
  });

  test("allows a separately authorized approver to approve without exposing the requester's capability", async () => {
    const { connector, catalog, mutations } = createConnector();
    const state = new InMemoryDurableStateStore();
    const service = createTesseraDatabaseActionService({
      connector,
      state,
      policy: createDatabaseScopedPermissionPolicy({ profile: "normal" }),
      authorizeApproval: ({ requester, approver }) => requester.tenantRef === approver.tenantRef && approver.roleRefs.includes("admin"),
      idFactory: deterministicIds(),
    });

    const pending = await service.submit({
      actor: ACTOR,
      requestId: "archive-order-admin-approval",
      action: updateAction(catalog),
      purpose: "Archive a reviewed order",
    });
    expect(pending.summary.status).toBe("awaiting-approval");

    const admin = { tenantRef: "tenant-a", actorRef: "admin", roleRefs: ["admin"] } as const;
    const visible = await service.capabilities({ actor: admin });
    expect(visible.capabilities).toHaveLength(1);
    expect(visible.capabilities[0]?.capabilityId).not.toBe((await service.capabilities({ actor: ACTOR })).capabilities[0]?.capabilityId);

    const approved = await service.approve({
      actor: admin,
      requestId: "archive-order-admin-approval",
      checkpointId: pending.approval!.checkpointId,
    });
    expect(approved.summary.status).toBe("succeeded");
    expect(mutations).toHaveLength(1);
  });
});

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
          { name: "tenant_id", dataType: "text", nullable: false, ordinal: 3 },
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
      return {
        queryId: "read-query",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      };
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
        durationMs: 3,
      };
    },
    async close() {},
  };
  return { connector, catalog, mutations };
}

function insertAction(catalog: DatabaseCatalog) {
  return {
    version: 1 as const,
    kind: "data.insert" as const,
    connectionRef: catalog.connectorId,
    databaseRef: catalog.databaseName,
    catalogFingerprint: catalog.fingerprint,
    relation: { schema: "public", table: "orders" },
    values: [{ id: "order-1", status: "new" }],
    maxAffectedRows: 1,
  };
}

function updateAction(catalog: DatabaseCatalog) {
  return {
    version: 1 as const,
    kind: "data.update" as const,
    connectionRef: catalog.connectorId,
    databaseRef: catalog.databaseName,
    catalogFingerprint: catalog.fingerprint,
    relation: { schema: "public", table: "orders" },
    patch: { status: "archived" },
    where: { kind: "comparison" as const, column: "id", op: "eq" as const, value: "order-1" },
    maxAffectedRows: 1,
  };
}

function deterministicIds(): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `${prefix}-${++sequence}`;
}
