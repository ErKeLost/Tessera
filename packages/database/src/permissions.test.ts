import { describe, expect, test } from "bun:test";
import {
  classifyDatabaseSqlStatement,
  createDatabasePermissionPolicy,
  evaluateDatabaseSqlPermission,
} from "./permissions";

describe("database permissions", () => {
  test("matches Datus profile defaults", () => {
    expect(createDatabasePermissionPolicy()).toEqual({
      profile: "normal",
      sqlStatements: {
        read: "allow",
        write: "ask",
        destructive: "ask",
        unknown: "ask",
      },
    });
    expect(evaluateDatabaseSqlPermission(createDatabasePermissionPolicy({ profile: "auto" }), "INSERT INTO notes VALUES (1)"))
      .toEqual({ statementClass: "write", permission: "allow" });
    expect(evaluateDatabaseSqlPermission(createDatabasePermissionPolicy({ profile: "auto" }), "DELETE FROM notes"))
      .toEqual({ statementClass: "destructive", permission: "ask" });
    expect(evaluateDatabaseSqlPermission(createDatabasePermissionPolicy({ profile: "dangerous" }), "DROP TABLE notes"))
      .toEqual({ statementClass: "destructive", permission: "allow" });
  });

  test("layers class-level overrides after the selected profile", () => {
    const policy = createDatabasePermissionPolicy({
      profile: "auto",
      sqlStatements: { destructive: "deny", unknown: "deny" },
    });

    expect(evaluateDatabaseSqlPermission(policy, "UPDATE notes SET title = 'revised'")).toEqual({
      statementClass: "destructive",
      permission: "deny",
    });
    expect(evaluateDatabaseSqlPermission(policy, "read")).toEqual({
      statementClass: "read",
      permission: "allow",
    });
  });

  test("classifies documented statement groups after leading comments", () => {
    expect(classifyDatabaseSqlStatement("/* report */ -- latest\nSELECT * FROM notes")).toBe("read");
    expect(classifyDatabaseSqlStatement("SHOW TABLES")).toBe("read");
    expect(classifyDatabaseSqlStatement("EXPLAIN SELECT * FROM notes")).toBe("read");
    expect(classifyDatabaseSqlStatement("COMMENT ON TABLE notes IS 'tracked'")).toBe("write");
    expect(classifyDatabaseSqlStatement("GRANT SELECT ON notes TO analyst")).toBe("write");
    expect(classifyDatabaseSqlStatement("REPLACE INTO notes VALUES (1)")).toBe("destructive");
  });

  test("fails closed for unsafe or ambiguous SQL", () => {
    expect(classifyDatabaseSqlStatement("SELECT 1; DROP TABLE notes")).toBe("unknown");
    expect(classifyDatabaseSqlStatement("WITH removed AS (DELETE FROM notes RETURNING id) SELECT * FROM removed")).toBe("unknown");
    expect(classifyDatabaseSqlStatement("EXPLAIN ANALYZE DELETE FROM notes")).toBe("unknown");
    expect(classifyDatabaseSqlStatement("SELECT * INTO backup_notes FROM notes")).toBe("unknown");
    expect(classifyDatabaseSqlStatement("SELECT 'unfinished")).toBe("unknown");
  });

  test("permits a single terminal semicolon and quoted semicolons", () => {
    expect(classifyDatabaseSqlStatement("SELECT ';' AS punctuation;")).toBe("read");
    expect(classifyDatabaseSqlStatement("SELECT 1; /* completed */")).toBe("read");
  });
});
