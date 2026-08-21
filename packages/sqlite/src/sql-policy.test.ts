import { describe, expect, test } from "bun:test";
import { SqliteQueryPolicyError, validateReadOnlySql } from "./sql-policy";

const policy = {
  allowedSchemas: ["main"],
  knownRelations: [{ schema: "main", name: "orders" }],
};

describe("validateReadOnlySql", () => {
  test("allows discovered SQLite analytics and CTEs", () => {
    expect(validateReadOnlySql(
      "SELECT date(created_at), COUNT(*) FROM main.orders GROUP BY 1",
      policy,
    )).toContain("COUNT");
    expect(validateReadOnlySql(
      "WITH daily AS (SELECT * FROM main.orders) SELECT COUNT(*) FROM daily",
      policy,
    )).toContain("WITH daily");
  });

  test("rejects writes, multiple statements, system tables, and unknown relations", () => {
    expect(() => validateReadOnlySql("DELETE FROM main.orders", policy))
      .toThrow(SqliteQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT 1; SELECT 2", policy))
      .toThrow(SqliteQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT * FROM main.sqlite_schema", policy))
      .toThrow(SqliteQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT * FROM main.users", policy))
      .toThrow(SqliteQueryPolicyError);
  });

  test("rejects extension and filesystem functions", () => {
    expect(() => validateReadOnlySql("SELECT load_extension('unsafe')", policy))
      .toThrow(SqliteQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT readfile('/tmp/secret')", policy))
      .toThrow(SqliteQueryPolicyError);
  });
});
