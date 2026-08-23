import { expect, test } from "bun:test";
import {
  actorAuditRefSchema,
  columnIdSchema,
  sha256HashSchema,
} from "@open-generative/protocol";
import { createOpenGenerativeHost } from "./index";

test("presents a governed data chart from one host call", async () => {
  const host = await createOpenGenerativeHost();
  const surface = await host.presentDataChart({
    authority: {
      actorAuditRef: actorAuditRefSchema.parse("actor:test"),
      actorBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
      tenantBindingHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
      authorityPolicyRevision: "test:1",
    },
    dataset: {
      columns: [
        { columnId: "category", label: "Category", valueType: "string" },
        { columnId: "value", label: "Value", valueType: "number" },
      ],
      rows: [
        { category: "North", value: 12 },
        { category: "South", value: 8 },
      ],
      totalRows: 2,
      hasMore: false,
    },
    spec: {
      mark: "bar",
      title: "Results",
      x: { field: columnIdSchema.parse("category"), type: "nominal", title: "Category" },
      y: { field: columnIdSchema.parse("value"), type: "quantitative", title: "Value" },
      tooltip: { mode: "auto" },
      options: { orientation: "vertical", stack: "none", curve: "monotone", grid: true, legend: "auto" },
      equivalentView: "table",
      accessibility: { label: "Results chart" },
    },
  });

  expect(surface.event.payload.type).toBe("snapshot-published");
  expect(surface.event.surfaceSessionId).toBe(surface.surfaceSessionId);
});
