import { describe, expect, test } from "bun:test";
import { CompilerDiagnosticError } from "./diagnostics";
import { createDocumentPolicy } from "./information-flow";
import { isArtifactPart } from "./part";
import { prepareTurn } from "./turn";
import type { ArtifactTransportAdapter, RepairProvider } from "./types";

const validProposal = {
  root: {
    id: "root",
    type: "layout.stack",
    props: { gap: "md" },
    slots: {
      children: [{ id: "summary", type: "content.text", props: { text: "Revenue increased." } }],
    },
  },
};

const adapter: ArtifactTransportAdapter<{ toolInput: unknown }, { data: unknown }> = {
  id: "test-provider",
  extractProposal: (output) => output.toolInput,
  encodePart: (part) => ({ data: part }),
};

describe("prepared turn handoff", () => {
  test("accepts provider-neutral output only after validation and applies a local brand", async () => {
    const turn = await prepareTurn({
      messages: [{ role: "user", content: "Summarize revenue" }],
      requestedNodeTypes: ["layout.stack", "content.text"],
    });
    const part = await turn.accept({ toolInput: validProposal }, adapter);
    expect(part.snapshot.root).toBe("root");
    expect(isArtifactPart(part)).toBe(true);
    expect(isArtifactPart(JSON.parse(JSON.stringify(part)))).toBe(false);

    const response = await turn.respond(part, adapter);
    expect(response.data).toBe(part);
  });

  test("filters messages that are not allowed into model generation", async () => {
    const turn = await prepareTurn({
      messages: [
        { role: "user", content: "visible" },
        {
          role: "tool",
          content: "renderer only",
          provenanceRef: "renderer-only",
          label: {
            scopeRef: "public",
            sensitivity: "public",
            persistence: "session",
            allowedSinks: ["renderer"],
          },
        },
      ],
      requestedNodeTypes: ["content.text"],
    });
    expect(turn.messages).toHaveLength(1);
    expect(turn.messages[0]?.content).toBe("visible");
  });

  test("performs one redacted snapshot repair and never exposes credentials or SQL", async () => {
    let calls = 0;
    const repairProvider: RepairProvider = {
      id: "repair",
      repair(request) {
        calls += 1;
        expect(request.attempt).toBe(1);
        expect(request.system).toContain("Data Elements Artifact Authoring DSL");
        expect(JSON.stringify(request.providerSchema)).toContain("content.text");
        expect(request.prompt).toContain("Active provider JSON Schema");
        expect(request.prompt).not.toContain("super-secret");
        expect(request.prompt).not.toContain("SELECT * FROM customers");
        return { root: { id: "summary", type: "content.text", props: { text: "Repaired" } } };
      },
    };
    const turn = await prepareTurn({
      messages: [{ role: "user", content: "Create a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const part = await turn.accept({
      toolInput: {
        root: {
          id: "summary",
          type: "content.text",
          props: { text: "Broken", password: "super-secret", sql: "SELECT * FROM customers" },
        },
      },
    }, adapter, { repairProvider });
    expect(calls).toBe(1);
    expect(part.snapshot.nodes.summary?.props.text).toEqual({ kind: "literal", value: "Repaired" });
  });

  test("stops after the configured repair bound", async () => {
    let calls = 0;
    const repairProvider: RepairProvider = {
      id: "repair",
      repair() {
        calls += 1;
        return { root: { id: "summary", type: "content.text", props: {} } };
      },
    };
    const turn = await prepareTurn({
      messages: [{ role: "user", content: "Create a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    await expect(turn.accept({
      toolInput: { root: { id: "summary", type: "content.text", props: {} } },
    }, adapter, { repairProvider })).rejects.toBeInstanceOf(CompilerDiagnosticError);
    expect(calls).toBe(1);
  });

  test("does not repair policy denials or turns without a model-repair sink", async () => {
    let calls = 0;
    const policy = createDocumentPolicy({
      policyId: "generation-only",
      scopeRef: "public",
      sensitivity: "public",
      persistence: "session",
      allowedSinks: ["model-generation"],
    });
    const turn = await prepareTurn({
      messages: [{ role: "user", content: "Use resource" }],
      documentPolicy: policy,
      requestedNodeTypes: ["content.text"],
      resourceIds: [],
    });
    await expect(turn.accept({
      toolInput: { root: { id: "summary", type: "content.text", props: {} }, resourceIds: ["private-resource"] },
    }, adapter, {
      repairProvider: { id: "repair", repair: () => { calls += 1; return validProposal; } },
    })).rejects.toBeInstanceOf(CompilerDiagnosticError);
    expect(calls).toBe(0);
  });

  test("keeps adapter errors in the transport phase", async () => {
    const turn = await prepareTurn({
      messages: [{ role: "user", content: "Create a summary" }],
      requestedNodeTypes: ["content.text"],
    });
    const broken: ArtifactTransportAdapter<unknown> = {
      id: "broken",
      extractProposal() { throw new Error("provider internals"); },
    };
    try {
      await turn.accept({}, broken);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CompilerDiagnosticError);
      expect((error as CompilerDiagnosticError).diagnostics[0]?.phase).toBe("transport");
      expect((error as Error).message).not.toContain("provider internals");
    }
  });
});
