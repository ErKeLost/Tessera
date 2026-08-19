import { describe, expect, test } from "bun:test";
import { MySqlQueryPolicyError, validateReadOnlySql } from "./sql-policy";

const policy = {
  allowedSchemas: ["warehouse"],
  knownRelations: [{ schema: "warehouse", name: "orders" }],
};

describe("validateReadOnlySql", () => {
  test("allows one discovered SELECT and common analytic functions", () => {
    expect(
      validateReadOnlySql(
        " SELECT DATE(created_at), COUNT(*) FROM warehouse.orders GROUP BY 1; ",
        policy,
      ),
    ).toContain("SELECT DATE");
    expect(
      validateReadOnlySql("SELECT o.id FROM warehouse.orders AS o", policy),
    ).toContain("o.id");
  });

  test("rejects multiple statements and unknown relations", () => {
    expect(() => validateReadOnlySql("SELECT 1; SELECT 2", policy)).toThrow(
      MySqlQueryPolicyError,
    );
    expect(() =>
      validateReadOnlySql("SELECT * FROM warehouse.users", policy),
    ).toThrow(MySqlQueryPolicyError);
  });

  test("rejects locking, output, session state, system relations, and unsafe functions", () => {
    expect(() =>
      validateReadOnlySql("SELECT * FROM warehouse.orders FOR UPDATE", policy),
    ).toThrow(MySqlQueryPolicyError);
    expect(() =>
      validateReadOnlySql(
        "SELECT * FROM warehouse.orders INTO OUTFILE '/tmp/result'",
        policy,
      ),
    ).toThrow(MySqlQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT @value := 1", policy)).toThrow(
      MySqlQueryPolicyError,
    );
    expect(() => validateReadOnlySql("SELECT @@hostname", policy)).toThrow(
      MySqlQueryPolicyError,
    );
    expect(() => validateReadOnlySql("SELECT @value", policy)).toThrow(
      MySqlQueryPolicyError,
    );
    expect(() =>
      validateReadOnlySql("SELECT * FROM information_schema.tables", policy),
    ).toThrow(MySqlQueryPolicyError);
    expect(() => validateReadOnlySql("SELECT SLEEP(1)", policy)).toThrow(
      MySqlQueryPolicyError,
    );
  });

  test("allows CTEs that read discovered relations", () => {
    const query = validateReadOnlySql(
      "WITH daily AS (SELECT DATE(created_at) AS day, COUNT(*) AS n FROM orders GROUP BY 1) SELECT * FROM daily",
      policy,
    );
    expect(query).toContain("WITH daily");
  });
});
