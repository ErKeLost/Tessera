import { describe, expect, test } from "bun:test";
import {
  formatDatabaseConnectionContext,
  formatDatabasePermissionContext,
  formatRequestContext,
  formatWorkspaceContext,
} from "./request-context";

describe("request context projection", () => {
  test("projects unavailable connection and authorization as facts", () => {
    const connection = formatDatabaseConnectionContext(undefined);
    const authorization = formatDatabasePermissionContext(undefined, undefined);
    expect(connection).toContain("availability=unavailable");
    expect(connection).toContain("dialect=unknown");
    expect(authorization).toContain("availability=unavailable");
    expect(authorization).not.toContain("Do not attempt");
  });

  test("does not turn workspace metadata into routing instructions", () => {
    const context = formatWorkspaceContext({
      hasCurrentRelation: true,
      hasLocalFilter: true,
      view: "data",
    });
    expect(context).toContain("has_current_relation=true");
    expect(context).toContain("has_local_filter=true");
    expect(context).toContain("relation_identity=hidden");
    expect(context).not.toContain("call list_database");
  });

  test("marks request context as bounded server data", () => {
    const context = formatRequestContext({
      snapshot: undefined,
      permissionContext: undefined,
    });
    expect(context).toContain("source=server; scope=request; bounded=true");
    expect(context).toContain("<database_context>");
  });
});
