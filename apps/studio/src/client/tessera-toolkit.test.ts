import { describe, expect, test } from "bun:test";
import { tesseraStudioToolkit } from "./tessera-toolkit";

describe("Tessera Studio toolkit", () => {
  test("registers every current server and generative tool renderer", () => {
    expect(Object.keys(tesseraStudioToolkit).sort()).toEqual([
      "execute_sql",
      "list_catalog",
      "list_database",
      "list_extensions",
      "list_rls_policies",
      "present_ui",
      "run_analysis",
    ]);
  });
});
