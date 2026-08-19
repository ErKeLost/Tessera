import { describe, expect, test } from "bun:test";
import {
  createDatabaseScopedPermissionPolicy,
  evaluateDatabaseActionPolicy,
} from "./scoped-policy";

const catalogFingerprint = `sha256:${"b".repeat(64)}`;
const actor = { tenantRef: "tenant-a", actorRef: "alice", roleRefs: ["analyst"] };
const ordersRelation = { schema: "public", table: "orders" };
const scopedColumns = [
  { ...ordersRelation, column: "id" },
  { ...ordersRelation, column: "status" },
  { ...ordersRelation, column: "deleted_at" },
];

const updateAction = {
  version: 1 as const,
  kind: "data.update" as const,
  connectionRef: "warehouse",
  databaseRef: "analytics",
  catalogFingerprint,
  relation: ordersRelation,
  patch: { status: "archived" },
  where: { kind: "comparison" as const, column: "id", op: "eq" as const, value: "o-1" },
  maxAffectedRows: 1,
};

const deleteAction = {
  version: 1 as const,
  kind: "data.delete" as const,
  connectionRef: "warehouse",
  databaseRef: "analytics",
  catalogFingerprint,
  relation: ordersRelation,
  where: { kind: "comparison" as const, column: "id", op: "eq" as const, value: "o-1" },
  maxAffectedRows: 1,
};

const insertAction = {
  version: 1 as const,
  kind: "data.insert" as const,
  connectionRef: "warehouse",
  databaseRef: "analytics",
  catalogFingerprint,
  relation: ordersRelation,
  values: [{ status: "new" }],
  maxAffectedRows: 1,
};

describe("scoped database action policy", () => {
  test("keeps Datus profile defaults for structured actions", () => {
    expect(evaluateDatabaseActionPolicy(createDatabaseScopedPermissionPolicy({ profile: "normal" }), {
      action: insertAction,
      actor,
    })).toMatchObject({ permission: "ask", outcome: "require-approval", source: "profile" });

    expect(evaluateDatabaseActionPolicy(createDatabaseScopedPermissionPolicy({ profile: "auto" }), {
      action: insertAction,
      actor,
    })).toMatchObject({ permission: "allow", outcome: "allow", source: "profile" });

    expect(evaluateDatabaseActionPolicy(createDatabaseScopedPermissionPolicy({ profile: "dangerous" }), {
      action: deleteAction,
      actor,
    })).toMatchObject({ permission: "allow", outcome: "allow", source: "profile" });
  });

  test("uses the outer resource scope as a hard boundary before profile defaults", () => {
    const policy = createDatabaseScopedPermissionPolicy({
      profile: "auto",
      subject: { tenantRefs: ["tenant-a"] },
      resource: {
        connectionRefs: ["warehouse"],
        relationRefs: [ordersRelation],
        columnRefs: scopedColumns,
      },
    });

    const allowed = evaluateDatabaseActionPolicy(policy, { action: updateAction, actor });
    const outsideRelation = evaluateDatabaseActionPolicy(policy, {
      action: {
        version: 1,
        kind: "data.read",
        connectionRef: "warehouse",
        databaseRef: "analytics",
        catalogFingerprint,
        relation: { schema: "public", table: "customers" },
        columns: ["id"],
        limit: 10,
      },
      actor,
    });
    const outsideColumn = evaluateDatabaseActionPolicy(policy, {
      action: { ...updateAction, patch: { email: "customer@example.com" } },
      actor,
    });

    expect(allowed).toMatchObject({ permission: "ask", outcome: "require-approval" });
    expect(outsideRelation).toMatchObject({ permission: "deny", source: "scope", reasonCodes: ["scope.denied"] });
    expect(outsideColumn).toMatchObject({ permission: "deny", source: "scope" });
  });

  test("evaluates matching rules in order and preserves a trusted risk floor", () => {
    const policy = createDatabaseScopedPermissionPolicy({
      profile: "normal",
      rules: [
        { id: "all-analyst-updates", permission: "allow", actionKinds: ["data.update"], subject: { roleRefs: ["analyst"] } },
        { id: "orders-still-review", permission: "ask", actionKinds: ["data.update"], resource: { relationRefs: [ordersRelation] } },
      ],
    });

    const result = evaluateDatabaseActionPolicy(policy, {
      action: updateAction,
      actor,
      riskFloor: "low",
    });

    expect(result).toMatchObject({
      permission: "ask",
      outcome: "require-approval",
      source: "rule",
      risk: "high",
      matchedRuleIds: ["all-analyst-updates", "orders-still-review"],
    });
  });

  test("allows a concrete session/project grant only at an ASK boundary and never through deny", () => {
    const askPolicy = createDatabaseScopedPermissionPolicy({ profile: "normal" });
    const allowed = evaluateDatabaseActionPolicy(askPolicy, {
      action: deleteAction,
      actor,
      grants: [{
        id: "delete-orders-once",
        mode: "session",
        actionKinds: ["data.delete"],
        subject: { actorRefs: ["alice"] },
        resource: { connectionRefs: ["warehouse"], relationRefs: [ordersRelation] },
      }],
    });
    const notExact = evaluateDatabaseActionPolicy(askPolicy, {
      action: deleteAction,
      actor,
      grants: [{
        id: "update-only",
        mode: "session",
        actionKinds: ["data.update"],
      }],
    });
    const denied = evaluateDatabaseActionPolicy(createDatabaseScopedPermissionPolicy({
      profile: "normal",
      rules: [{ id: "never-delete", permission: "deny", actionKinds: ["data.delete"] }],
    }), {
      action: deleteAction,
      actor,
      grants: [{ id: "cannot-bypass-deny", mode: "project", actionKinds: ["data.delete"] }],
    });

    expect(allowed).toMatchObject({ permission: "allow", outcome: "allow", source: "grant", matchedGrantId: "delete-orders-once" });
    expect(notExact).toMatchObject({ permission: "ask", outcome: "require-approval", source: "profile" });
    expect(denied).toMatchObject({ permission: "deny", outcome: "deny", source: "rule" });
  });

  test("requires a server-generated row predicate when the scope declares one", () => {
    const policy = createDatabaseScopedPermissionPolicy({
      profile: "auto",
      resource: { rowPredicateRefs: ["tenant-isolation"] },
    });

    expect(evaluateDatabaseActionPolicy(policy, { action: updateAction, actor }))
      .toMatchObject({ permission: "deny", source: "scope" });
    expect(evaluateDatabaseActionPolicy(policy, {
      action: updateAction,
      actor,
      trustedRowPredicateRefs: ["tenant-isolation"],
    })).toMatchObject({ permission: "ask", outcome: "require-approval" });
  });

  test("checks both sides of a cross-schema table rename", () => {
    const policy = createDatabaseScopedPermissionPolicy({
      profile: "dangerous",
      resource: { relationRefs: [ordersRelation] },
    });
    const action = {
      version: 1 as const,
      kind: "data.ddl" as const,
      connectionRef: "warehouse",
      databaseRef: "analytics",
      catalogFingerprint,
      relation: ordersRelation,
      operation: { kind: "rename-table" as const, to: { schema: "archive", table: "orders" } },
    };

    expect(evaluateDatabaseActionPolicy(policy, { action, actor })).toMatchObject({
      permission: "deny",
      source: "scope",
    });
  });
});
