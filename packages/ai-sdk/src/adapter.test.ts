import { describe, expect, test } from "bun:test";
import { artifactKinds } from "@data-elements/schema";
import { createRenderArtifactTool, getArtifactFromToolPart } from "./index";

describe("AI SDK adapter", () => {
  test("uses the generated complete catalog schema", () => {
    const tool = createRenderArtifactTool();
    const schema = (tool.inputSchema as unknown as { jsonSchema: Record<string, unknown> }).jsonSchema;
    expect(schema.oneOf).toBeArrayOfSize(artifactKinds.length);
    const encoded = JSON.stringify(schema);
    for (const kind of artifactKinds) {
      expect(encoded).toContain(`"const":"${kind}"`);
    }
    expect(encoded).toContain('"confidenceLevel"');
    expect(encoded).toContain('"drivers"');
    expect(encoded).toContain('"highlightId"');
    expect(encoded).toContain('"deadline"');
    expect(encoded).toContain('"events"');
  });

  test("extracts validated tool output", () => {
    expect(getArtifactFromToolPart({ type: "tool-renderArtifact", state: "output-available", output: { protocolVersion: "1.0", kind: "calculator", id: "a", title: "A", description: "", calculatorId: "compound-interest", initialValues: {}, currency: "USD", locale: "en-US" } })?.kind).toBe("calculator");
  });

  test("ignores untrusted output", () => {
    expect(getArtifactFromToolPart({ type: "tool-renderArtifact", state: "output-available", output: { kind: "html", html: "<script />" } })).toBeUndefined();
  });
});
