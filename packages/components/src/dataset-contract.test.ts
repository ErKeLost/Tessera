import { describe, expect, test } from "bun:test";
import { resourceDatasetPayloadSchema } from "@open-generative/protocol";
import { resolvedChartDataSchema } from "./chart-spec";

describe("Data Chart dataset contract", () => {
  test("uses the canonical Resource Gateway dataset envelope", () => {
    expect(resolvedChartDataSchema).toBe(resourceDatasetPayloadSchema);
    const gatewayWindow = resourceDatasetPayloadSchema.parse({
      columns: [
        { columnId: "month", label: "Month", valueType: "date" },
        { columnId: "revenue", label: "Revenue", valueType: "number" },
      ],
      rows: [{ month: "2026-08-01", revenue: 42 }],
      totalRows: 12,
      hasMore: true,
    });
    expect(resolvedChartDataSchema.parse(gatewayWindow)).toEqual(gatewayWindow);
  });
});
