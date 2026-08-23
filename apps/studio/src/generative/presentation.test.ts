import { describe, expect, test } from "bun:test";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import {
  createTesseraDataChartPresentation,
  createTesseraPresentationAuthority,
} from "./presentation";

function completedResult(input: Readonly<{
  columns: readonly Readonly<{ outputId: string; label: string; type: string }>[];
  rows: readonly Record<string, unknown>[];
}>): DataAgentRunResult {
  return {
    columns: input.columns,
    execution: { result: { rows: input.rows } },
  } as DataAgentRunResult;
}

const identity = { subject: "member-42", tenantId: "tenant-7" };

describe("Tessera Open Generative presentation", () => {
  test("maps a categorical analysis to a semantic bar chart", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Orders by device",
        result: completedResult({
          columns: [
            { outputId: "device", label: "Device", type: "string" },
            { outputId: "orders", label: "Orders", type: "number" },
          ],
          rows: [
            { device: "Desktop", orders: 42 },
            { device: "Mobile", orders: "31.5" },
            { device: "Tablet", orders: "not-a-number" },
          ],
        }),
      },
      identity,
    });

    expect(presentation).toMatchObject({
      title: "Orders by device",
      dataset: {
        totalRows: 2,
        columns: [
          { columnId: "device", valueType: "string" },
          { columnId: "orders", valueType: "number" },
        ],
        rows: [{ device: "Desktop", orders: 42 }, { device: "Mobile", orders: 31.5 }],
      },
      spec: {
        mark: "bar",
        x: { field: "device", type: "nominal" },
        y: { field: "orders", type: "quantitative" },
        equivalentView: "table",
      },
    });
  });

  test("maps a temporal analysis to a line chart", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Monthly registrations",
        result: completedResult({
          columns: [
            { outputId: "out_month", label: "Month", type: "date" },
            { outputId: "out_registrations", label: "Registrations", type: "number" },
          ],
          rows: [
            { out_month: "2025-10", out_registrations: 55 },
            { out_month: "2025-11", out_registrations: 44 },
            { out_month: "2025-12", out_registrations: 242 },
          ],
        }),
      },
      identity,
    });

    expect(presentation?.spec).toMatchObject({
      mark: "line",
      x: { field: "out_month", type: "temporal" },
      y: { field: "out_registrations", type: "quantitative" },
    });
  });

  test("maps a second categorical dimension to color without changing the mark", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Revenue by segment and region",
        result: completedResult({
          columns: [
            { outputId: "segment", label: "Segment", type: "string" },
            { outputId: "region", label: "Region", type: "string" },
            { outputId: "revenue", label: "Revenue", type: "decimal" },
          ],
          rows: [{ segment: "Enterprise", region: "Americas", revenue: "48200.25" }],
        }),
      },
      identity,
    });

    expect(presentation?.spec).toMatchObject({
      mark: "bar",
      color: { field: "region", type: "nominal" },
    });
    expect(presentation?.dataset.rows).toEqual([{ segment: "Enterprise", region: "Americas", revenue: 48200.25 }]);
  });

  test("uses a scatter plot only when the result has two numeric measures and no dimension", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Spend and revenue",
        result: completedResult({
          columns: [
            { outputId: "spend", label: "Spend", type: "number" },
            { outputId: "revenue", label: "Revenue", type: "number" },
          ],
          rows: [{ spend: 7800, revenue: 38400 }],
        }),
      },
      identity,
    });
    expect(presentation?.spec).toMatchObject({ mark: "scatter", x: { field: "spend" }, y: { field: "revenue" } });
  });

  test("declines results without a reliable semantic encoding", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Unsupported result",
        result: completedResult({
          columns: [{ outputId: "active", label: "Active", type: "boolean" }],
          rows: [{ active: true }],
        }),
      },
      identity,
    });
    expect(presentation).toBeUndefined();
  });

  test("uses opaque stable audience bindings rather than Studio identities", () => {
    const authority = createTesseraPresentationAuthority(identity);
    expect(authority.actorBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.tenantBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(authority)).not.toContain(identity.subject);
    expect(JSON.stringify(authority)).not.toContain(identity.tenantId);
  });
});
