import { describe, expect, test } from "bun:test";
import type { QueryArtifact } from "@data-elements/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable } from "./data-table";

const artifact: QueryArtifact = {
  protocolVersion: "1.0",
  kind: "query",
  id: "credit-ledger",
  title: "Credit ledger",
  description: "Completed credits by business day.",
  metricDefinition: "Sum of completed credit transactions by business day.",
  timeZone: "UTC",
  filters: [],
  warnings: [],
  sql: "select day, credits from credit_ledger",
  columns: [
    { key: "day", label: "Day", type: "date", format: "plain" },
    { key: "credits", label: "Credits", type: "number", format: "compact" },
  ],
  rows: [{ day: "2026-08-16T09:00:00.000Z", credits: 2_481 }],
  rowCount: 1,
  truncated: false,
  sourceTables: ["analytics.credit_ledger"],
};

describe("DataTable", () => {
  test("keeps the inspection region frameless and constrains values to their columns", () => {
    const markup = renderToStaticMarkup(<DataTable artifact={artifact} />);

    expect(markup).toContain('data-slot="data-table"');
    expect(markup).toContain('data-slot="data-table-toolbar"');
    expect(markup).toContain('data-slot="data-table-footer"');
    expect(markup).toContain('data-column-align="end"');
    expect(markup).toContain("de-data-table-data-column is-numeric");
    expect(markup).toContain("de-data-table-cell-content");
    expect(markup).toContain("--de-data-table-column-count:2");
    expect(markup).not.toContain("de-data-table-shell");
  });
});
