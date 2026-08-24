import { describe, expect, test } from "bun:test";
import { tesseraStudioToolkit } from "./tessera-toolkit";

describe("Tessera Studio toolkit", () => {
  test("registers every current business tool renderer", () => {
    expect(Object.keys(tesseraStudioToolkit).sort()).toEqual([
      "execute_sql",
      "list_database",
      "prepare_analysis",
      "search_data_context",
    ]);
  });
});
