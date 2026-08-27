import { describe, expect, test } from "bun:test";
import type { DataAgentRunResult } from "@open-tessera/data-agent";
import {
  createTesseraDataResources,
  createTesseraPresentationIntent,
  createTesseraPresentationAuthority,
} from "./presentation";

function completedResult(): DataAgentRunResult {
  return {
    columns: [
      { outputId: "out_day", label: "Day", type: "date" },
      { outputId: "out_revenue", label: "Revenue", type: "decimal" },
      { outputId: "out_active", label: "Active", type: "boolean" },
      { outputId: "out_metadata", label: "Metadata", type: "json" },
    ],
    execution: {
      result: {
        rows: [{
          out_day: "2026-08-23",
          out_revenue: 128.4,
          out_active: true,
          out_metadata: { region: "APAC" },
        }],
        rowCount: 1,
        truncated: false,
      },
    },
  } as unknown as DataAgentRunResult;
}

describe("Tessera Open Generative resource projection", () => {
  test("delegates component selection to resource shape and only requests tabs for peer resources", () => {
    expect(createTesseraPresentationIntent([])).toBeUndefined();
    expect(createTesseraPresentationIntent([{} as never])).toBeUndefined();
    expect(createTesseraPresentationIntent([{} as never, {} as never])).toEqual({
      kind: "auto",
      interactions: ["tabs"],
    });
  });

  test("publishes verified analysis rows without choosing a component recipe", () => {
    const resources = createTesseraDataResources({
      analyses: [{ title: "Daily revenue", result: completedResult() }],
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      bindingId: "analysis-1",
      label: "Daily revenue",
      classification: "internal",
      sensitivity: "internal",
      dataset: {
        columns: [
          { columnId: "out_day", valueType: "date" },
          { columnId: "out_revenue", valueType: "number" },
          { columnId: "out_active", valueType: "boolean" },
          { columnId: "out_metadata", valueType: "string" },
        ],
        rows: [{
          out_day: "2026-08-23",
          out_revenue: 128.4,
          out_active: true,
          out_metadata: '{"region":"APAC"}',
        }],
      },
    });
    expect(JSON.stringify(resources)).not.toContain("recipe");
  });

  test("publishes every completed analysis as an independently bindable resource", () => {
    const resources = createTesseraDataResources({
      analyses: [
        { title: "Revenue", result: completedResult() },
        { title: "Conversion", result: completedResult() },
      ],
    });

    expect(resources.map((resource) => resource.bindingId)).toEqual(["analysis-1", "analysis-2"]);
    expect(resources.map((resource) => resource.label)).toEqual(["Revenue", "Conversion"]);
  });

  test("does not publish an empty result as a renderable resource", () => {
    const result = completedResult();
    const resources = createTesseraDataResources({
      analyses: [{
        title: "No rows",
        result: {
          ...result,
          execution: {
            ...result.execution,
            result: { ...result.execution.result, rows: [], rowCount: 0 },
          },
        },
      }],
    });

    expect(resources).toEqual([]);
  });

  test("uses opaque stable audience bindings rather than Studio identities", () => {
    const identity = { subject: "member-42", tenantId: "tenant-7" };
    const authority = createTesseraPresentationAuthority(identity);
    expect(authority.actorBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(authority.tenantBindingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(authority)).not.toContain(identity.subject);
    expect(JSON.stringify(authority)).not.toContain(identity.tenantId);
  });

  test("publishes explicit read results without requiring a semantic analysis", () => {
    const resources = createTesseraDataResources({
      analyses: [],
      queries: [{
        title: "Average value by category",
        result: {
          queryId: "query-1",
          columns: [{ name: "category" }, { name: "average_value" }],
          rows: [
            { category: "pricing", average_value: "80.8" },
            { category: "credits", average_value: "16.4375" },
          ],
          rowCount: 2,
          truncated: false,
          durationMs: 3,
        },
      }],
    });

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({
      bindingId: "query-1",
      dataset: {
        columns: [
          { columnId: "category", valueType: "string" },
          { columnId: "average_value", valueType: "number" },
        ],
        rows: [
          { category: "pricing", average_value: 80.8 },
          { category: "credits", average_value: 16.4375 },
        ],
      },
    });
  });
});
