import { describe, expect, test } from "bun:test";
import { createOpenGenerativeHost, type OpenGenerativeTurn } from "@open-generative/host";
import {
  actorAuditRefSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
} from "@open-generative/protocol";
import {
  createUIMessageStream,
  jsonSchema,
  stepCountIs,
  streamText,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createOpenGenerativeAISdkAdapter } from "./server";

describe("AI SDK 7 Open Generative integration", () => {
  test("publishes a committed Surface through the native AI SDK UI stream", async () => {
    const host = await createOpenGenerativeHost();
    let resourcesReady = false;
    let turn: OpenGenerativeTurn | undefined;
    let preparedTurns = 0;
    let modelStep = 0;

    const runAnalysis = {
      description: "Produce a verified dataset.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      execute: async () => {
        resourcesReady = true;
        return { status: "completed" as const };
      },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const step = modelStep++;
        const chunks: any[] = [{ type: "stream-start", warnings: [] }];
        if (step === 0) {
          chunks.push({
            type: "tool-call",
            toolCallId: "analysis-call",
            toolName: "run_analysis",
            input: "{}",
            providerExecuted: false,
          }, finish("tool-calls"));
        } else if (step === 1) {
          if (!turn) throw new Error("The Host Turn was not prepared.");
          chunks.push({
            type: "tool-call",
            toolCallId: "present-call",
            toolName: "present_ui",
            input: JSON.stringify(createProposal(turn)),
            providerExecuted: false,
          }, finish("tool-calls"));
        } else {
          chunks.push(
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "The analysis is ready." },
            { type: "text-end", id: "text-1" },
            finish("stop"),
          );
        }
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const stream = createUIMessageStream({
      async execute({ writer }) {
        const integration = createOpenGenerativeAISdkAdapter({
          tools: { run_analysis: runAnalysis },
          writer,
          async resolve() {
            if (!resourcesReady) return undefined;
            preparedTurns += 1;
            turn = await host.prepareTurn({
              authority: {
                actorAuditRef: actorAuditRefSchema.parse("actor:ai-sdk-integration"),
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
        const result = streamText({
          model,
          prompt: "Show visitors.",
          stopWhen: stepCountIs(4),
          tools: integration.tools,
          prepareStep: integration.prepareStep,
        });
        writer.merge(result.toUIMessageStream());
      },
    });
    const chunks: any[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(modelStep).toBe(3);
    expect(preparedTurns).toBe(1);
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
    finishReason: { unified: reason, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  };
}
