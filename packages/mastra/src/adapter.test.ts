import { describe, expect, test } from "bun:test";
import { isValidationError } from "@mastra/core/tools";
import { isArtifactPart } from "@data-elements/runtime";
import type { ZodType } from "zod";
import { createMastraArtifactUI } from "./index";

describe("Mastra Artifact UI facade", () => {
  test("derives a per-turn tool and schema from the compiler catalog", async () => {
    const artifactUI = createMastraArtifactUI();
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Show a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const schema = JSON.stringify(turn.tools.renderArtifact.inputSchema);
    expect(schema).toContain("content.text");
    expect(schema).not.toContain('"kind":{"enum"');
    expect(turn.system).toContain("content.text@1");
    expect(turn.tools.renderArtifact.mcp?.annotations).toEqual({
      title: "Data Elements artifact",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("keeps actions impossible when the selected catalog exposes no action contracts", async () => {
    const turn = await createMastraArtifactUI().prepareTurn({
      messages: [{ role: "user", content: "Show a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const inputSchema = turn.tools.renderArtifact.inputSchema as ZodType | undefined;
    if (!inputSchema) throw new Error("Mastra renderArtifact tool must have an input schema.");

    expect(inputSchema.safeParse({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
      actions: { blocked: { contractId: "form.change", steps: [] } },
    }).success).toBe(false);
  });

  test("validates direct tool input through the prepared compiler turn", async () => {
    const turn = await createMastraArtifactUI().prepareTurn({
      messages: [{ role: "user", content: "Show a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const execute = turn.tools.renderArtifact.execute;
    if (!execute) throw new Error("Mastra renderArtifact tool must be executable.");
    const part = await execute({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
    }, {} as never);
    if (!part || isValidationError(part)) throw new Error("Mastra tool validation failed.");
    expect(part.kind).toBe("artifact-snapshot");
    if (part.kind !== "artifact-snapshot") throw new Error("Expected a snapshot wire part.");
    expect(part.snapshot.document.nodes.summary?.type).toBe("content.text");
    expect(turn.tools.renderArtifact.toModelOutput?.(part)).toEqual({
      type: "text",
      value: "The artifact was validated and is ready to render.",
    });
    expect("~standard" in (turn.tools.renderArtifact.inputSchema ?? {})).toBe(true);
  });

  test("returns a branded part from accept and redacts model input in display transcripts", async () => {
    const turn = await createMastraArtifactUI().prepareTurn({
      messages: [{ role: "user", content: "Show a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const part = await turn.accept({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
    });
    expect(isArtifactPart(part)).toBe(true);
    const displayInput = turn.tools.renderArtifact.transform?.display?.input;
    expect(await displayInput?.({
      target: "display",
      phase: "input-available",
      toolName: "renderArtifact",
      toolCallId: "call-1",
      input: { secret: "raw model input" },
    })).toEqual({ type: "artifact-proposal", redacted: true });
  });

  test("maps Mastra workflow results through the same compiler validation", async () => {
    const turn = await createMastraArtifactUI().prepareTurn({
      messages: [{ role: "user", content: "Show a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const part = await turn.consumeWorkflowEvent({
      type: "workflow-output",
      data: { root: { id: "summary", type: "content.text", props: { text: "Workflow" } } },
    });
    expect(part.kind).toBe("artifact-snapshot");
    if (part.kind !== "artifact-snapshot") throw new Error("Expected a snapshot.");
    expect(part.snapshot.document.nodes.summary?.props.text).toEqual({ kind: "literal", value: "Workflow" });
  });
});
