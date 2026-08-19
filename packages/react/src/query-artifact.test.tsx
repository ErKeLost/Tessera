import { describe, expect, test } from "bun:test";
import type { QueryArtifact as QueryArtifactData } from "@data-elements/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactUIProvider } from "./bridge";
import { QueryArtifact } from "./query-artifact";

const scalarArtifact: QueryArtifactData = {
  protocolVersion: "1.0",
  kind: "query",
  id: "user-count",
  title: "User count",
  description: "Current users.",
  metricDefinition: "Count rows in the governed user table.",
  timeZone: "UTC",
  filters: [],
  warnings: [],
  sql: "SELECT COUNT(*) AS user_count FROM public.users",
  columns: [{ key: "user_count", label: "User count", type: "number", format: "plain" }],
  rows: [{ user_count: 42 }],
  rowCount: 1,
  truncated: false,
  sourceTables: ["public.users"],
};

describe("QueryArtifact", () => {
  test("shows a scalar result in the table view without an empty chart tab", () => {
    const markup = renderToStaticMarkup(
      <ArtifactUIProvider>
        <QueryArtifact artifact={scalarArtifact} defaultView="chart" />
      </ArtifactUIProvider>,
    );

    expect(markup).not.toContain(">Chart<");
    expect(markup).not.toContain("No chart available");
    expect(markup).toContain(">Table<");
  });

  test("falls back to the table when an artifact carries an invalid chart spec", () => {
    const artifact: QueryArtifactData = {
      ...scalarArtifact,
      chart: { kind: "bar", xKey: "created_at", yKeys: ["missing_total"] },
    };
    const markup = renderToStaticMarkup(
      <ArtifactUIProvider>
        <QueryArtifact artifact={artifact} />
      </ArtifactUIProvider>,
    );

    expect(markup).not.toContain(">Chart<");
    expect(markup).toContain(">Table<");
  });
});
