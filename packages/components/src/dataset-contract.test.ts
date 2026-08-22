import { describe, expect, test } from "bun:test";
import { resourceDatasetPayloadSchema } from "@open-generative/protocol";
import { resolvedChartDataSchema } from "./chart-spec";
import { resolvedTableDataSchema } from "./props";

describe("official dataset consumers", () => {
  test("share the canonical Resource Gateway dataset envelope", () => {
    expect(resolvedChartDataSchema).toBe(resourceDatasetPayloadSchema);
    expect(resolvedTableDataSchema).toBe(resourceDatasetPayloadSchema);

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
    expect(resolvedTableDataSchema.parse(gatewayWindow)).toEqual(gatewayWindow);
  });
});
