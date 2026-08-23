import { describe, expect, test } from "bun:test";
import { resourceDatasetPayloadSchema } from "@open-generative/protocol";

describe("Data Chart dataset contract", () => {
  test("uses the canonical Resource Gateway dataset envelope", () => {
    const gatewayWindow = resourceDatasetPayloadSchema.parse({
      columns: [
        { columnId: "month", label: "Month", valueType: "date" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ month: "2026-08-01", revenue: 42 }],
      totalRows: 12,
      hasMore: true,
    });
    expect(resourceDatasetPayloadSchema.parse(gatewayWindow)).toEqual(gatewayWindow);
  });
});
