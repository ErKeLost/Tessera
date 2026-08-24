import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import type {
  ProcessInputStepArgs,
  ProcessInputStepResult,
  ProcessOutputStepArgs,
  ProcessOutputStreamArgs,
  ProcessorStreamWriter,
} from "@mastra/core/processors";
import type { ChunkType } from "@mastra/core/stream";
import { createTool } from "@mastra/core/tools";
import {
  actorAuditRefSchema,
  resourceDatasetPayloadSchema,
  sha256HashSchema,
  type OpenGenerativeSurfaceStream,
} from "@open-generative/protocol";
import { createOpenGenerativeHost } from "@open-generative/host";
import {
  createOpenGenerativeProcessor,
  type OpenGenerativeDatasetResource,
} from "./index";
import { z } from "zod";

describe("Open Generative Mastra Processor", () => {
  test("keeps candidate tools available and compiles final text deltas into one cumulative Surface part", async () => {
    const tools = { execute_sql: { description: "query" } };
    const processor = createOpenGenerativeProcessor({
      host: createOpenGenerativeHost(),
      resources: async () => [{
        bindingId: "analysis-result",
        label: "Visitors by device",
        dataset: resourceDatasetPayloadSchema.parse({
          columns: [
            { columnId: "device", label: "Device", valueType: "string" },
            { columnId: "visitors", label: "Visitors", valueType: "number" },
          ],
          rows: [
            { device: "Desktop", visitors: 610 },
            { device: "Mobile", visitors: 390 },
          ],
          totalRows: 2,
          hasMore: false,
        }),
      }],
      authority: async () => authority(),
      turn: { presentationPolicy: "required" },
    });
    const state: Record<string, unknown> = {};
    const input = inputArgs(state, tools);
    const prepared = await processor.processInputStep!(input);
    const preparedResult = prepared as ProcessInputStepResult | undefined;

    expect(prepared).toBeDefined();
    expect(prepared).not.toHaveProperty("tools");
    expect(prepared).not.toHaveProperty("activeTools");
    expect(prepared).not.toHaveProperty("toolChoice");
    expect(input.tools).toBe(tools);
    expect(preparedResult?.systemMessages?.at(-1)?.content).toContain(
      "Output only OGL assignment statements",
    );
    expect(JSON.stringify(prepared)).toContain("This is the final response format");

    const writes: Array<{ type: string; id?: string; data?: OpenGenerativeSurfaceStream }> = [];
    const writer: ProcessorStreamWriter = {
      async custom(data) {
        writes.push(structuredClone(data) as typeof writes[number]);
      },
    };
    for (const delta of [
      'root = Report("Device visitors", "Verified result", content)\n',
      'content = Stack("md", [visitors])\n',
      'visitors = Metric("Total visitors", @data1, "visitors", "number")\n',
    ]) {
      const part = chunk("text-delta", { id: "text-1", text: delta });
      expect(await processor.processOutputStream!(outputArgs(state, writer, part))).toBeNull();
    }
    const stepFinish = chunk("step-finish", {
      stepResult: { reason: "stop" },
      output: { usage: {} },
      metadata: {},
    });
    expect(await processor.processOutputStream!(outputArgs(state, writer, stepFinish))).toBe(stepFinish);
    await processor.processOutputStep!(outputStepArgs(state, writer));

    expect(writes.length).toBeGreaterThan(1);
    expect(new Set(writes.map((write) => write.id)).size).toBe(1);
    const stream = writes.at(-1)?.data;
    expect(stream?.events[0]?.payload.type).toBe("snapshot-published");
    expect(stream?.events.some((event) => event.payload.type === "preview-applied")).toBe(true);
    expect(stream?.events.at(-1)?.payload.type).toBe("revision-committed");
  }, { timeout: 30_000 });

  test("stays transparent until resources exist", async () => {
    const processor = createOpenGenerativeProcessor({
      resources: async () => [],
      authority: async () => authority(),
    });
    const state: Record<string, unknown> = {};
    expect(await processor.processInputStep!(inputArgs(state, {}))).toBeUndefined();
    const part = chunk("text-delta", { id: "text-1", text: "Normal answer" });
    expect(await processor.processOutputStream!(outputArgs(state, undefined, part))).toBe(part);
  });

  test("preserves an upstream abort after rejecting a tool chunk", async () => {
    const processor = createOpenGenerativeProcessor({
      host: createOpenGenerativeHost(),
      authority: async () => authority(),
    });
    const state: Record<string, unknown> = {};
    await processor.processInputStep!(inputArgs(state, { query_data: {} }));
    await processor.processOutputStream!(outputArgs(
      state,
      undefined,
      chunk("text-delta", {
        id: "text-1",
        text: 'root = Report("Result", "Verified", content)\ncontent = Stack("md", [])\n',
      }),
    ));
    expect(await processor.processOutputStream!(outputArgs(
      state,
      undefined,
      chunk("tool-call", { toolCallId: "call-1", toolName: "query_data", args: {} }),
    ))).toBeNull();

    const abort = chunk("abort", { reason: "cancelled" });
    expect(await processor.processOutputStream!(outputArgs(state, undefined, abort))).toBe(abort);
  }, { timeout: 30_000 });

  test("runs inside a real Mastra Agent after a business tool produces resources", async () => {
    const resources: OpenGenerativeDatasetResource[] = [];
    const processor = createOpenGenerativeProcessor({
      host: createOpenGenerativeHost(),
      resources: async () => resources,
      authority: async () => authority(),
      turn: { presentationPolicy: "required" },
    });
    let queryExecutions = 0;
    const query = createTool({
      id: "query_data",
      description: "Returns verified device visitors.",
      inputSchema: z.object({}),
      outputSchema: z.object({ rowCount: z.number() }),
      execute: async () => {
        queryExecutions += 1;
        resources.push(deviceResource());
        return { rowCount: 2 };
      },
    });
    let modelTurn = 0;
    const prompts: string[] = [];
    const availableTools: string[][] = [];
    const model = {
      specificationVersion: "v2",
      provider: "open-generative-test",
      modelId: "mastra-processor-e2e",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("This fixture exercises Agent.stream only.");
      },
      async doStream(options: { prompt?: unknown; tools?: Array<{ name: string }> }) {
        prompts.push(JSON.stringify(options.prompt));
        availableTools.push(options.tools?.map((tool) => tool.name) ?? []);
        const turn = modelTurn++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (turn === 0) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "query-call-1",
                  toolName: "query_data",
                  input: "{}",
                  providerExecuted: false,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
              } else if (turn === 1) {
                controller.enqueue({ type: "text-start", id: "interrupted-ogl" });
                controller.enqueue({
                  type: "text-delta",
                  id: "interrupted-ogl",
                  delta: 'root = Report("Device visitors", "Verified result", content)\ncontent = Stack("md", [])\n',
                });
                controller.enqueue({ type: "text-end", id: "interrupted-ogl" });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "query-call-repeated",
                  toolName: "query_data",
                  input: "{}",
                  providerExecuted: false,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
              } else {
                const deltas = [
                  'root = Report("Device visitors", "Verified result", content)\n',
                  'content = Stack("md", [chart])\n',
                  'chart = Chart(@data1, {"recipe":"devices-bars","title":"Visitors by device","deviceColumn":"device","valueColumn":"visitors"})\n',
                ];
                controller.enqueue({ type: "text-start", id: "ogl-final" });
                for (const delta of deltas) {
                  controller.enqueue({ type: "text-delta", id: "ogl-final", delta });
                }
                controller.enqueue({ type: "text-end", id: "ogl-final" });
                controller.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
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
      id: "open-generative-mastra-e2e",
      name: "Open Generative Mastra E2E",
      model,
      instructions: "Use the business tool, then answer with the verified result.",
      tools: { query_data: query },
      inputProcessors: [processor],
      outputProcessors: [processor],
      maxProcessorRetries: 1,
    });

    const result = await agent.stream("Show visitors by device.", { maxSteps: 4 });
    const chunks: unknown[] = [];
    for await (const part of result.fullStream) chunks.push(part);
    const serialized = JSON.stringify(chunks);

    expect(modelTurn).toBe(3);
    expect(queryExecutions).toBe(1);
    expect(availableTools[0]).toContain("query_data");
    expect(availableTools[1]).toContain("query_data");
    expect(availableTools[2]).toEqual([]);
    expect(prompts[0]).not.toContain("open-generative-language");
    expect(prompts[1]).toContain("Output only OGL assignment statements");
    expect(prompts[2]).toContain("[Processor Feedback]");
    expect(prompts[2]).toContain("This is the final response format");
    expect(prompts[2]).toContain("query_data");
    expect(prompts[2]).toContain('"rowCount":2');
    expect(serialized).toContain("query_data");
    expect(serialized).toContain("data-openGenerativeSurface");
    expect(serialized).toContain("revision-committed");
    expect(surfaceSessionIds(chunks)).toHaveLength(1);
    expect(committedSurfaceSessionIds(chunks)).toHaveLength(1);
    expect(serialized).not.toContain('root = Report("Device visitors"');
    expect(serialized).not.toContain("query-call-repeated");
  }, { timeout: 30_000 });
});

function deviceResource(): OpenGenerativeDatasetResource {
  return {
    bindingId: "analysis-result",
    label: "Visitors by device",
    dataset: resourceDatasetPayloadSchema.parse({
      columns: [
        { columnId: "device", label: "Device", valueType: "string" },
        { columnId: "visitors", label: "Visitors", valueType: "number" },
      ],
      rows: [
        { device: "Desktop", visitors: 610 },
        { device: "Mobile", visitors: 390 },
      ],
      totalRows: 2,
      hasMore: false,
    }),
  };
}

function inputArgs(
  state: Record<string, unknown>,
  tools: Record<string, unknown>,
): ProcessInputStepArgs {
  return {
    stepNumber: 1,
    steps: [],
    state,
    systemMessages: [{ role: "system", content: "Base instructions" }],
    tools,
    activeTools: Object.keys(tools),
    messages: [],
    messageList: {} as never,
    model: "openai/gpt-5" as never,
    retryCount: 0,
    abort(reason) {
      throw new Error(reason ?? "aborted");
    },
  };
}

function outputArgs(
  state: Record<string, unknown>,
  writer: ProcessorStreamWriter | undefined,
  part: ChunkType,
): ProcessOutputStreamArgs {
  return {
    part,
    streamParts: [part],
    state,
    retryCount: 0,
    ...(writer === undefined ? {} : { writer }),
    abort(reason) {
      throw new Error(reason ?? "aborted");
    },
  };
}

function outputStepArgs(
  state: Record<string, unknown>,
  writer: ProcessorStreamWriter | undefined,
): ProcessOutputStepArgs {
  return {
    state,
    stepNumber: 1,
    steps: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    systemMessages: [],
    messages: [],
    messageList: {} as never,
    retryCount: 0,
    ...(writer === undefined ? {} : { writer }),
    abort(reason) {
      throw new Error(reason ?? "aborted");
    },
  };
}

function chunk(type: string, payload: unknown): ChunkType {
  return { type, payload, runId: "run-test", from: "AGENT" } as ChunkType;
}

function committedSurfaceSessionIds(value: unknown): string[] {
  const sessionIds = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const record = current as Record<string, unknown>;
    if (
      typeof record.surfaceSessionId === "string"
      && Array.isArray(record.events)
      && record.events.some((event) => (
        typeof event === "object"
        && event !== null
        && typeof (event as { payload?: unknown }).payload === "object"
        && (event as { payload: { type?: unknown } }).payload.type === "revision-committed"
      ))
    ) {
      sessionIds.add(record.surfaceSessionId);
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...sessionIds];
}

function surfaceSessionIds(value: unknown): string[] {
  const sessionIds = new Set<string>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const record = current as Record<string, unknown>;
    if (typeof record.surfaceSessionId === "string") sessionIds.add(record.surfaceSessionId);
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...sessionIds];
}

function authority() {
  return {
    actorAuditRef: actorAuditRefSchema.parse("actor:mastra-test"),
    actorBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
    tenantBindingHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
    authorityPolicyRevision: "test:1",
  };
}
