import { describe, expect, test } from "bun:test";
import { validateCreateTableDraft, type CreateTableDraft } from "./create-table-dialog";

const validDraft: CreateTableDraft = {
  columns: [
    { dataType: "uuid", name: "id", nullable: false, primaryKey: true },
    { dataType: "text", name: "display_name", nullable: true, primaryKey: false },
  ],
  name: "customers",
  schema: "public",
};

describe("Create Table form contract", () => {
  test("accepts a bounded, catalog-safe table draft", () => {
    expect(validateCreateTableDraft(validDraft, [])).toBeUndefined();
  });

  test("rejects invalid and duplicate identifiers before submission", () => {
    expect(validateCreateTableDraft({ ...validDraft, name: "bad table" }, [])).toContain("Table names");
    expect(validateCreateTableDraft({
      ...validDraft,
      columns: [...validDraft.columns, { ...validDraft.columns[0]!, name: "ID" }],
    }, [])).toBe("Column ID is duplicated.");
  });

  test("rejects an existing relation in the selected schema", () => {
    expect(validateCreateTableDraft(validDraft, [{ name: "Customers", schema: "public" }]))
      .toBe("A table named public.customers already exists.");
  });
});
