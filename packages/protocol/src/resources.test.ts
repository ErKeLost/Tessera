import { describe, expect, test } from "bun:test";
import { resourceDatasetPayloadSchema } from "./resources";

describe("resource dataset envelope", () => {
  test("normalizes one strict window shape for every dataset consumer", () => {
    expect(resourceDatasetPayloadSchema.parse({
      columns: [
        { columnId: "region", label: "Region", valueType: "string" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ region: "North", revenue: 42 }],
      totalRows: 2,
    })).toEqual({
      columns: [
        { columnId: "region", label: "Region", valueType: "string" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ region: "North", revenue: 42 }],
      totalRows: 2,
      hasMore: false,
    });
  });

  test("rejects duplicate columns, undeclared row keys, and non-scalar cells", () => {
    const column = { columnId: "region", label: "Region", valueType: "string" };
    expect(resourceDatasetPayloadSchema.safeParse({
      columns: [column, column],
      rows: [],
    }).success).toBe(false);
    expect(resourceDatasetPayloadSchema.safeParse({
      columns: [column],
      rows: [{ country: "US" }],
    }).success).toBe(false);
    expect(resourceDatasetPayloadSchema.safeParse({
      columns: [column],
      rows: [{ region: { name: "North" } }],
    }).success).toBe(false);
  });
});
