import { describe, expect, test } from "bun:test";
import { CompilerDiagnosticError, compilerDiagnostic } from "@data-elements/compiler";
import { isArtifactPart } from "@data-elements/runtime";
import type { UIMessageChunk } from "ai";
import {
  createArtifactUI,
  decodeArtifactUIDataPart,
  type ArtifactUIDataPart,
  type ArtifactUIStreamResult,
} from "./artifact-ui";

const proposal = {
  root: {
    id: "revenue",
    type: "artifact.metric",
    props: {
      title: "Revenue",
      description: "Validated revenue",
      metrics: [
        { id: "mrr", label: "MRR", value: 461400, format: "currency", currency: "USD" },
      ],
    },
  },
};

function ids() {
  let next = 0;
  return (kind: string, hint = "artifact") => `${kind}:${hint}:${next += 1}`;
}

function rejectedArtifactInputResult(input: unknown): ArtifactUIStreamResult {
  return {
    toUIMessageStream: () => new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({ type: "start" });
        controller.enqueue({ type: "tool-input-start", toolCallId: "call-rejected", toolName: "renderArtifact" });
        controller.enqueue({
          type: "tool-input-error",
          toolCallId: "call-rejected",
          toolName: "renderArtifact",
          input,
          errorText: "data-elements:authoring.unknown_field",
        });
        controller.enqueue({ type: "finish", finishReason: "tool-calls" });
        controller.close();
      },
    }),
  };
}

describe("createArtifactUI", () => {
  test("turns a validated authoring proposal into the runtime ArtifactPart", async () => {
    const artifactUI = createArtifactUI({
      idFactory: ids(),
      now: () => "2026-08-15T00:00:00.000Z",
    });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Show revenue as a metric." }],
      requestedNodeTypes: ["artifact.metric"],
    });

    const part = await turn.accept(proposal);
    expect(isArtifactPart(part)).toBe(true);
    expect(part.kind).toBe("artifact-snapshot");
    if (part.kind !== "artifact-snapshot") throw new Error("Expected snapshot.");
    expect(part.snapshot.document.root).toBe("revenue");
    expect(part.snapshot.document.nodes.revenue?.props.protocolVersion).toBeUndefined();
    expect(part.snapshot.document.revision.contentHash).not.toBe("pending");
  });

  test("publishes only validated data-artifact parts in the UI stream", async () => {
    const artifactUI = createArtifactUI({
      idFactory: ids(),
      now: () => "2026-08-15T00:00:00.000Z",
    });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Show revenue as a metric." }],
      requestedNodeTypes: ["artifact.metric"],
    });
    const execute = turn.tools.renderArtifact.execute;
    if (!execute) throw new Error("renderArtifact must execute on the server.");
    const wire = await execute(proposal, {
      toolCallId: "call-1",
      messages: [],
      abortSignal: new AbortController().signal,
      context: {},
    });
    const chunks: UIMessageChunk[] = [
      { type: "start" },
      { type: "tool-input-start", toolCallId: "call-1", toolName: "renderArtifact" },
      { type: "tool-input-available", toolCallId: "call-1", toolName: "renderArtifact", input: proposal },
      { type: "tool-output-available", toolCallId: "call-1", output: wire },
      { type: "finish", finishReason: "tool-calls" },
    ];
    const result = {
      toUIMessageStream: () => new ReadableStream<UIMessageChunk>({
        start(controller) {
          chunks.forEach((chunk) => controller.enqueue(chunk));
          controller.close();
        },
      }),
    };

    const response = turn.toUIMessageStreamResponse(result);
    const body = await response.text();
    expect(body).toContain("data-artifact");
    expect(body).not.toContain("tool-input-available");
    expect(body).not.toContain("tool-output-available");
  });

  test("maps an artifact tool failure from a safe diagnostic code without exposing its raw error", async () => {
    const artifactUI = createArtifactUI({ idFactory: ids() });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Show revenue as a metric." }],
      requestedNodeTypes: ["artifact.metric"],
    });
    let receivedArtifactError = "";
    const result: ArtifactUIStreamResult = {
      toUIMessageStream(options) {
        const rawError = new CompilerDiagnosticError([compilerDiagnostic({
          phase: "validate",
          code: "authoring.unknown_field",
          message: "Unknown field private-value.",
        })]);
        const chunks: UIMessageChunk[] = [
          { type: "start" },
          { type: "tool-input-start", toolCallId: "call-invalid", toolName: "renderArtifact" },
          { type: "tool-input-available", toolCallId: "call-invalid", toolName: "renderArtifact", input: proposal },
          {
            type: "tool-output-error",
            toolCallId: "call-invalid",
            errorText: options?.onError?.(rawError) ?? "missing error mapper",
          },
          { type: "finish", finishReason: "tool-calls" },
        ];
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            chunks.forEach((chunk) => controller.enqueue(chunk));
            controller.close();
          },
        });
      },
    };

    const response = turn.toUIMessageStreamResponse(result, {
      onError: () => "The model request failed.",
      onArtifactError: (error) => {
        receivedArtifactError = String(error);
        return "Artifact needs repair.";
      },
    });
    const body = await response.text();

    expect(receivedArtifactError).toBe("data-elements:authoring.unknown_field");
    expect(body).toContain("Artifact needs repair.");
    expect(body).not.toContain("private-value");
    expect(body).not.toContain("authoring.unknown_field");
  });

  test("repairs a schema-rejected artifact input before emitting a trusted data part", async () => {
    let repairCalls = 0;
    const artifactUI = createArtifactUI({ idFactory: ids() });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Create a summary." }],
      requestedNodeTypes: ["content.text"],
      repairProvider: {
        id: "repair",
        repair: async () => {
          repairCalls += 1;
          return {
            root: {
              id: "summary",
              type: "content.text",
              props: { text: "Recovered summary" },
            },
          };
        },
      },
    });

    const response = turn.toUIMessageStreamResponse(rejectedArtifactInputResult({
      root: {
        id: "summary",
        type: "content.text",
        props: { text: "Broken", unsupported: "not-for-client" },
      },
    }));
    const body = await response.text();

    expect(repairCalls).toBe(1);
    expect(body).toContain('"type":"data-artifact"');
    expect(body).not.toContain('"type":"error"');
    expect(body).not.toContain("not-for-client");
  });

  test("keeps a schema-rejected artifact input failure safe when repair fails", async () => {
    let repairCalls = 0;
    let receivedArtifactError = "";
    const artifactUI = createArtifactUI({ idFactory: ids() });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Create a summary." }],
      requestedNodeTypes: ["content.text"],
      repairProvider: {
        id: "repair",
        repair: async () => {
          repairCalls += 1;
          throw new Error("repair-provider-secret");
        },
      },
    });

    const response = turn.toUIMessageStreamResponse(rejectedArtifactInputResult({
      root: {
        id: "summary",
        type: "content.text",
        props: { text: "Broken", unsupported: "not-for-client" },
      },
    }), {
      onArtifactError: (error) => {
        receivedArtifactError = String(error);
        return "Artifact needs repair.";
      },
    });
    const body = await response.text();

    expect(repairCalls).toBe(1);
    expect(receivedArtifactError).toContain("repair.provider_failed");
    expect(receivedArtifactError).not.toContain("repair-provider-secret");
    expect(body).toContain("Artifact needs repair.");
    expect(body).not.toContain('"type":"data-artifact"');
    expect(body).not.toContain("not-for-client");
    expect(body).not.toContain("repair-provider-secret");
  });

  test("decodes a serialized UI data part back into a branded part", async () => {
    const artifactUI = createArtifactUI({
      idFactory: ids(),
      now: () => "2026-08-15T00:00:00.000Z",
    });
    const turn = await artifactUI.prepareTurn({
      messages: [{ role: "user", content: "Show revenue as a metric." }],
      requestedNodeTypes: ["artifact.metric"],
    });
    const part = await turn.accept(proposal);
    const dataPart: ArtifactUIDataPart = {
      type: "data-artifact",
      data: {
        artifactProtocol: "2.0",
        contractFingerprint: turn.contractFingerprint,
        part: part.kind === "artifact-snapshot"
          ? { kind: part.kind, snapshot: part.snapshot }
          : { kind: part.kind, base: part.base, events: part.events },
      },
    };

    expect(isArtifactPart(await decodeArtifactUIDataPart(dataPart))).toBe(true);
  });
});
