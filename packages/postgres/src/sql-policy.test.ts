import { describe, expect, test } from "bun:test";
import { PostgresQueryPolicyError, validateReadOnlySql } from "./sql-policy";

const policy = {
  allowedSchemas: ["public"],
  knownRelations: [{ schema: "public", name: "orders" }],
};

describe("validateReadOnlySql", () => {
  test("allows one discovered SELECT and canonicalizes it", () => {
    expect(validateReadOnlySql(" SELECT id FROM public.orders ; ", policy)).toContain("SELECT id");
  });

  test("rejects multiple statements and write CTEs", () => {
    expect(() => validateReadOnlySql("select 1; select 2", policy)).toThrow(PostgresQueryPolicyError);
    expect(() => validateReadOnlySql("with changed as (delete from public.orders returning *) select * from changed", policy))
      .toThrow(PostgresQueryPolicyError);
  });

  test("rejects locking, system relations, and unsafe functions", () => {
    expect(() => validateReadOnlySql("select * from public.orders for update", policy)).toThrow(PostgresQueryPolicyError);
    expect(() => validateReadOnlySql("select * from pg_catalog.pg_class", policy)).toThrow(PostgresQueryPolicyError);
    expect(() => validateReadOnlySql("select pg_sleep(1)", policy)).toThrow(PostgresQueryPolicyError);
  });

  test("allows a CTE and common analytic functions", () => {
    const query = validateReadOnlySql(
      "with daily as (select date_trunc('day', created_at) day, count(*) n from public.orders group by 1) select * from daily",
      policy,
    );
    expect(query).toContain("WITH");
  });
});
