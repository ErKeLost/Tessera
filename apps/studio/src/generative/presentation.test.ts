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

describe("Tessera Open Generative presentation", () => {
  test("projects a governed dimension and metric into the fixed chart recipe", () => {
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
      identity: { subject: "member-42", tenantId: "tenant-7" },
    });

    expect(presentation).toMatchObject({
      title: "Orders by device",
      dataset: {
        totalRows: 2,
        hasMore: false,
        columns: [
          { columnId: "device", label: "Device", valueType: "string" },
          { columnId: "orders", label: "Orders", valueType: "number" },
        ],
        rows: [
          { device: "Desktop", orders: 42 },
          { device: "Mobile", orders: 31.5 },
        ],
      },
      spec: {
        recipe: "devices-bars",
        deviceColumn: "device",
        valueColumn: "orders",
        equivalentView: "table",
      },
    });
  });

  test("uses opaque stable audience bindings rather than Studio identities", () => {
    const authority = createTesseraPresentationAuthority({
      subject: "member-42",
      tenantId: "tenant-7",
    });

    expect(authority.actorBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.tenantBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(authority)).not.toContain("member-42");
    expect(JSON.stringify(authority)).not.toContain("tenant-7");
  });

  test("projects a monthly aggregate into the chart recipe", () => {
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
      identity: { subject: "member-42", tenantId: "tenant-7" },
    });

    expect(presentation).toMatchObject({
      dataset: {
        columns: [
          { columnId: "out_month", valueType: "date" },
          { columnId: "out_registrations", valueType: "number" },
        ],
        rows: [
          { out_month: "2025-10", out_registrations: 55 },
          { out_month: "2025-11", out_registrations: 44 },
          { out_month: "2025-12", out_registrations: 242 },
        ],
      },
      spec: {
        recipe: "devices-bars",
        deviceColumn: "out_month",
        valueColumn: "out_registrations",
      },
    });
  });

  test("declines results without a safe categorical dimension and numeric metric", () => {
    const presentation = createTesseraDataChartPresentation({
      analysis: {
        title: "Unsupported result",
        result: completedResult({
          columns: [{ outputId: "active", label: "Active", type: "boolean" }],
          rows: [{ active: true }],
        }),
      },
      identity: { subject: "member-42", tenantId: "tenant-7" },
    });

    expect(presentation).toBeUndefined();
  });
});
