import { describe, expect, test } from "bun:test";
import {
  answerDatabaseActionToolSpec,
  answerRelationMetricsToolSpec,
  answerRelationPreviewToolSpec,
} from "./openui-answer-tools";
import {
  ANSWER_DATABASE_ACTION_TOOL,
  ANSWER_RELATION_METRICS_TOOL,
  ANSWER_RELATION_PREVIEW_TOOL,
} from "./openui-actions";

function asJsonSchema(spec: { inputSchema: Record<string, unknown> }): {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
} {
  return spec.inputSchema as {
    type?: string;
    required?: string[];
    properties?: Record<string, unknown>;
  };
}

describe("answer read tool specs", () => {
  test("relation_preview is read-only and takes catalog coordinates only", () => {
    const spec = answerRelationPreviewToolSpec();
    expect(spec.name).toBe(ANSWER_RELATION_PREVIEW_TOOL);
    expect(spec.annotations?.readOnlyHint).toBe(true);
    const schema = asJsonSchema(spec);
    expect(schema.required).toEqual(expect.arrayContaining(["schema", "table"]));
    expect(schema.properties?.sql).toBeUndefined();
  });

  test("relation_metrics is read-only and describes the bounded aggregate", () => {
    const spec = answerRelationMetricsToolSpec();
    expect(spec.name).toBe(ANSWER_RELATION_METRICS_TOOL);
    expect(spec.annotations?.readOnlyHint).toBe(true);
    const schema = asJsonSchema(spec);
    expect(schema.required).toEqual(expect.arrayContaining(["schema", "table", "metrics"]));
    expect(schema.properties?.metrics).toBeDefined();
    expect(schema.properties?.groupBy).toBeDefined();
    expect(schema.properties?.sql).toBeUndefined();
  });
});

describe("answer write tool spec", () => {
  test("database_action is destructive and takes the model mutation plus a purpose", () => {
    const spec = answerDatabaseActionToolSpec();
    expect(spec.name).toBe(ANSWER_DATABASE_ACTION_TOOL);
    expect(spec.annotations?.destructiveHint).toBe(true);
    expect(spec.description).toContain("never SQL");
    const schema = asJsonSchema(spec);
    expect(schema.required).toEqual(expect.arrayContaining(["mutation", "purpose"]));
  });

  test("no answer tool ever exposes a sql argument", () => {
    for (const spec of [
      answerRelationPreviewToolSpec(),
      answerRelationMetricsToolSpec(),
      answerDatabaseActionToolSpec(),
    ]) {
      expect(asJsonSchema(spec).properties?.sql).toBeUndefined();
    }
  });
});
