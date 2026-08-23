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
        { columnId: "device", label: "Device", valueType: "string" },
        { columnId: "visitors", label: "Visitors", valueType: "number" },
      ],
      rows: [
        { device: "Desktop", visitors: 0.61 },
        { device: "Mobile", visitors: 0.39 },
      ],
      totalRows: 2,
      hasMore: false,
    },
    spec: {
      recipe: "devices-bars",
      title: "Devices",
      deviceColumn: columnIdSchema.parse("device"),
      valueColumn: columnIdSchema.parse("visitors"),
      summary: { column: columnIdSchema.parse("visitors"), aggregate: "sum", label: "Visitors", format: { kind: "percent", maximumFractionDigits: 1 } },
      valueFormat: { kind: "percent", maximumFractionDigits: 1 },
      equivalentView: "table",
      accessibility: { label: "Device visitors chart" },
    },
  });

  expect(surface.event.payload.type).toBe("snapshot-published");
  expect(surface.event.surfaceSessionId).toBe(surface.surfaceSessionId);
});
