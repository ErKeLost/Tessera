import { describe, expect, test } from "bun:test";
import {
  bindDatabaseActionRowPredicates,
  canonicalizeDatabaseAction,
  classifyDatabaseAction,
  collectDatabaseActionColumns,
  createDatabaseActionHash,
  databaseActionSchema,
  databasePredicateSchema,
} from "./actions";
import {
  createDatabaseCompiledMutationHash,
  createDatabaseMutationPlan,
  validateDatabaseMutationPlan,
} from "./mutation";

const catalogFingerprint = `sha256:${"a".repeat(64)}`;

const updateAction = {
  version: 1 as const,
  kind: "data.update" as const,
  connectionRef: "warehouse",
  databaseRef: "analytics",
  catalogFingerprint,
  relation: { schema: "public", table: "orders" },
  patch: { status: "archived", reviewed: true },
  where: {
    kind: "all" as const,
    items: [
      { kind: "comparison" as const, column: "id", op: "in" as const, value: ["o-1", "o-2"] },
      { kind: "null" as const, column: "deleted_at", isNull: true },
    ],
  },
  maxAffectedRows: 20,
  returning: ["id", "status"],
};

describe("structured database actions", () => {
  test("classifies a bounded update conservatively and collects every referenced column", () => {
    expect(classifyDatabaseAction(updateAction)).toEqual({ statementClass: "destructive", risk: "high" });
    expect(collectDatabaseActionColumns(updateAction)).toEqual(["status", "reviewed", "id", "deleted_at"]);
  });

  test("canonical hashes are stable across ordinary object key ordering", () => {
    const reordered = {
      ...updateAction,
      patch: { reviewed: true, status: "archived" },
    };

    expect(createDatabaseActionHash(reordered)).toBe(createDatabaseActionHash(updateAction));
    expect(canonicalizeDatabaseAction(reordered)).toBe(canonicalizeDatabaseAction(updateAction));
  });

  test("does not accept raw SQL-shaped action inputs", () => {
    expect(() => databaseActionSchema.parse({ ...updateAction, sql: "UPDATE public.orders SET status = 'archived'" }))
      .toThrow();
    expect(() => databaseActionSchema.parse({ ...updateAction, where: undefined })).toThrow();
    expect(() => databasePredicateSchema.parse({
      kind: "comparison",
      column: "id",
      op: "between",
      value: [1],
    })).toThrow();
  });

  test("binds server row predicates into the action hash rather than treating them as labels", () => {
    const bound = bindDatabaseActionRowPredicates(updateAction, [{
      ref: "tenant-isolation",
      predicate: { kind: "comparison", column: "tenant_id", op: "eq", value: "tenant-a" },
    }]);

    expect(bound).toMatchObject({
      kind: "data.update",
      where: {
        kind: "all",
        items: [
          updateAction.where,
          { kind: "comparison", column: "tenant_id", op: "eq", value: "tenant-a" },
        ],
      },
    });
    expect(createDatabaseActionHash(bound)).not.toBe(createDatabaseActionHash(updateAction));
    expect(() => bindDatabaseActionRowPredicates({
      version: 1,
      kind: "data.insert",
      connectionRef: "warehouse",
      databaseRef: "analytics",
      catalogFingerprint,
      relation: { schema: "public", table: "orders" },
      values: [{ id: "o-3" }],
      maxAffectedRows: 1,
    }, [{
      ref: "tenant-isolation",
      predicate: { kind: "comparison", column: "tenant_id", op: "eq", value: "tenant-a" },
    }])).toThrow("Row predicate bindings only support read, update, and delete actions.");
  });

  test("builds a connector-facing parameterized mutation plan from a typed action", () => {
    const plan = createDatabaseMutationPlan({
      action: updateAction,
      purpose: "Archive reviewed orders",
      compiled: {
        sql: "UPDATE \"public\".\"orders\" SET \"status\" = $1, \"reviewed\" = $2 WHERE \"id\" IN ($3, $4) AND \"deleted_at\" IS NULL",
        parameters: ["archived", true, "o-1", "o-2"],
      },
    });

    expect(plan).toMatchObject({
      catalogFingerprint,
      statementClass: "destructive",
      maxAffectedRows: 20,
      actionHash: createDatabaseActionHash(updateAction),
      compiledHash: createDatabaseCompiledMutationHash(plan.compiled),
    });
    expect(plan.compiled.parameters).toEqual(["archived", true, "o-1", "o-2"]);
    expect(() => validateDatabaseMutationPlan({ ...plan, actionHash: `sha256:${"0".repeat(64)}` })).toThrow();
    expect(() => validateDatabaseMutationPlan({
      ...plan,
      compiled: { ...plan.compiled, sql: "DELETE FROM \"public\".\"orders\"" },
    })).toThrow("Database mutation compiled SQL or parameters do not match their hash.");
    expect(() => validateDatabaseMutationPlan({
      ...plan,
      compiled: { ...plan.compiled, parameters: ["tampered", true, "o-1", "o-2"] },
    })).toThrow("Database mutation compiled SQL or parameters do not match their hash.");
  });
});
