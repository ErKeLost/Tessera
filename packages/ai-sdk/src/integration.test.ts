import { describe, expect, test } from "bun:test";
import {
  actorAuditRefSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type OpenGenerativeSurfaceStream,
} from "@open-generative/protocol";
import { createOpenGenerativeHost } from "@open-generative/host";
import { jsonSchema, stepCountIs, streamText } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createOpenGenerativeProcessor } from "./server";

describe("AI SDK v7 Open Generative Processor", () => {
  test("keeps business tools unchanged and renders final OGL text as a cumulative UI data part", async () => {
    let resourcesReady = false;
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
    const tools = { run_analysis: runAnalysis };
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
        } else {
          chunks.push(
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: 'root = Report("Visitors", "Verified result", content)\n' },
            { type: "text-delta", id: "text-1", delta: 'content = Stack("md", [metric])\n' },
            { type: "text-delta", id: "text-1", delta: 'metric = Metric("Total visitors", @data1, "visitors", "number")\n' },
            { type: "text-end", id: "text-1" },
            finish("stop"),
          );
        }
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    const processor = createOpenGenerativeProcessor({
      host: createOpenGenerativeHost(),
      activation: "when-resources",
      resources: async () => resourcesReady ? [{
        bindingId: "analysis-result",
        label: "Visitors",
        dataset: resourceDatasetPayloadSchema.parse({
          columns: [{ columnId: "visitors", label: "Visitors", valueType: "number" }],
          rows: [{ visitors: 1_000 }],
          totalRows: 1,
          hasMore: false,
        }),
      }] : [],
      authority: async () => ({
        actorAuditRef: actorAuditRefSchema.parse("actor:ai-sdk-integration"),
        actorBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
        tenantBindingHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
        authorityPolicyRevision: "test:1",
      }),
      turn: { presentationPolicy: "required" },
    });

    const result = streamText({
      model,
      prompt: "Show visitors.",
      stopWhen: stepCountIs(3),
      tools,
      prepareStep: processor.prepareStep,
      experimental_transform: processor.transform,
    });
    const chunks: any[] = [];
    for await (const chunk of processor.toUIMessageStream(result)) chunks.push(chunk);

    expect(modelStep).toBe(2);
    expect(Object.keys(tools)).toEqual(["run_analysis"]);
    expect(chunks.some((chunk) => chunk.type === "text-delta"
      && String(chunk.delta ?? chunk.text).includes("root = Report"))).toBe(false);
    const surfaceChunks = chunks.filter((chunk) => chunk.type === "data-openGenerativeSurface");
    expect(surfaceChunks.length).toBeGreaterThan(1);
    expect(new Set(surfaceChunks.map((chunk) => chunk.id)).size).toBe(1);
    const stream = surfaceChunks.at(-1)?.data as OpenGenerativeSurfaceStream | undefined;
    expect(stream?.events[0]?.payload.type).toBe("snapshot-published");
    expect(stream?.events.some((event) => event.payload.type === "preview-applied")).toBe(true);
    expect(stream?.events.at(-1)?.payload.type).toBe("revision-committed");
  }, { timeout: 30_000 });
});

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
