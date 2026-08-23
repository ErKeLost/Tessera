import { describe, expect, test } from "bun:test";
import { toAISdkStream } from "@mastra/ai-sdk";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createOpenGenerativeHost, type OpenGenerativeTurn } from "@open-generative/host";
import {
  actorAuditRefSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  MASTRA_PRESENT_UI_TRACING_OPTIONS,
  createOpenGenerativeMastraProcessor,
} from "./index";

describe("Mastra Open Generative integration", () => {
  test("publishes a committed Surface data part through the native Agent stream", async () => {
    const host = await createOpenGenerativeHost();
    let resourcesReady = false;
    let turn: OpenGenerativeTurn | undefined;
    let modelStep = 0;

    const runAnalysis = createTool({
      id: "run_analysis",
      description: "Produce a verified dataset.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ status: z.literal("completed") }).strict(),
      execute: async () => {
        resourcesReady = true;
        return { status: "completed" as const };
      },
    });
    const processor = createOpenGenerativeMastraProcessor({
      async resolve() {
        if (!resourcesReady) return undefined;
        turn ??= await host.prepareTurn({
          authority: {
            actorAuditRef: actorAuditRefSchema.parse("actor:mastra-integration"),
            actorBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
            tenantBindingHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
            authorityPolicyRevision: "test:1",
          },
          presentationPolicy: "required",
          resources: [{
            bindingId: "analysis-result",
            label: "Visitors",
            dataset: resourceDatasetPayloadSchema.parse({
              columns: [{ columnId: "visitors", label: "Visitors", valueType: "number" }],
              rows: [{ visitors: 1_000 }],
              totalRows: 1,
              hasMore: false,
            }),
          }],
        });
        return turn;
      },
    });
    const model = {
      specificationVersion: "v2",
      provider: "open-generative-test",
      modelId: "mastra-integration",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("The integration test uses streaming only.");
      },
      async doStream() {
        const step = modelStep++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (step === 0) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "analysis-call",
                  toolName: "run_analysis",
                  input: "{}",
                  providerExecuted: false,
                });
                controller.enqueue(finish("tool-calls"));
              } else if (step === 1) {
                if (!turn) throw new Error("The Host Turn was not prepared.");
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "present-call",
                  toolName: "present_ui",
                  input: JSON.stringify(createProposal(turn)),
                  providerExecuted: false,
                });
                controller.enqueue(finish("tool-calls"));
              } else {
                controller.enqueue({ type: "text-start", id: "text-1" });
                controller.enqueue({ type: "text-delta", id: "text-1", delta: "The analysis is ready." });
                controller.enqueue({ type: "text-end", id: "text-1" });
                controller.enqueue(finish("stop"));
              }
              controller.close();
            },
          }),
          warnings: [],
          request: {},
          response: {},
        };
      },
    } as never;
    const agent = new Agent({
      id: "open-generative-integration",
      name: "Open Generative Integration",
      model,
      instructions: "Analyze the data and present it.",
      inputProcessors: [processor],
      tools: { run_analysis: runAnalysis },
    });

    const output = await agent.stream("Show visitors.", {
      maxSteps: 4,
      tracingOptions: MASTRA_PRESENT_UI_TRACING_OPTIONS,
    });
    const chunks: any[] = [];
    for await (const chunk of toAISdkStream(output, {
      from: "agent",
      version: "v7",
    }) as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    expect(modelStep).toBe(3);
    expect(chunks.some((chunk) => chunk.type === "data-openGenerativeSurface"
      && chunk.data?.payload?.type === "snapshot-published")).toBeTrue();
    expect(chunks.some((chunk) => chunk.type === "text-delta"
      && chunk.delta === "The analysis is ready.")).toBeTrue();
  });
});

function createProposal(turn: OpenGenerativeTurn) {
  const component = (type: string) => turn.catalogSlice.components
    .find((entry) => entry.contract.componentType === type)?.sliceComponentId;
  const resource = turn.catalogSlice.resources[0]?.sliceResourceId;
  if (!component("analysis.report") || !component("layout.stack") || !component("data.metric") || !resource) {
    throw new Error("The Host Turn is missing the official analytical contracts.");
  }
  return {
    kind: "snapshot",
    root: {
      localId: "report",
      component: component("analysis.report"),
      props: { title: "Visitors" },
      slots: {
        body: [{
          localId: "stack",
          component: component("layout.stack"),
          props: { gap: "md" },
          slots: {
            body: [{
              localId: "metric",
              component: component("data.metric"),
              props: {
                label: "Visitors",
                data: { ref: "resource", target: { kind: "resource", localId: "data" } },
                valueColumn: "visitors",
                format: "number",
              },
            }],
          },
        }],
      },
    },
    resourceBindings: [{ localId: "data", value: { source: resource } }],
    meta: { title: "Visitors", tags: [] },
  };
}

function finish(reason: "tool-calls" | "stop") {
  return {
    type: "finish",
    finishReason: reason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}
