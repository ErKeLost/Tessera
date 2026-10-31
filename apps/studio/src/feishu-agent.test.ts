import { describe, expect, test } from "bun:test";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { Mastra } from "@mastra/core/mastra";
import { createTesseraFeishuCopilotAgent } from "@open-tessera/agent";
import { createTesseraStudioFeishuAgent } from "./feishu-agent";
import { LOCAL_STUDIO_IDENTITY, createTesseraSessionMemory } from "./session-memory";

describe("Feishu Mastra runtime", () => {
  test("registers only Feishu tools and streams into the host-owned local session", async () => {
    const storage = new LibSQLStore({ id: "feishu-agent-test", url: ":memory:" });
    const memory = new Memory({ storage, vector: false });
    const llm = { model: "test/model", headers: {}, temperature: 0, maxOutputTokens: 256, maxSteps: 5, maxRetries: 0 };
    const reader = { async search() { return { status: "completed" as const, documents: [] }; }, async read() { return { status: "completed" as const, content: "Document text." }; } };
    const model = {
      specificationVersion: "v2", provider: "test", modelId: "feishu-test", supportedUrls: {},
      async doGenerate() { throw new Error("Use streaming"); },
      async doStream() { return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "answer" });
        controller.enqueue({ type: "text-delta", id: "answer", delta: "Document analysis is ready." });
        controller.enqueue({ type: "text-end", id: "answer" });
        controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
        controller.close();
      } }), warnings: [], request: {}, response: {} }; },
    } as never;
    const mastra = new Mastra({ storage, logger: false });
    const input = { runId: "feishu-test-run", threadId: "feishu-test-thread", message: "Read a document.", signal: new AbortController().signal };
    try {
      const copilot = createTesseraFeishuCopilotAgent({ input, reader, memory, model, llm, mastra, defaultIdentity: LOCAL_STUDIO_IDENTITY });
      expect(Object.keys(await copilot.listTools()).sort()).toEqual(["read_feishu_document", "search_feishu_documents"]);
      const sessions = createTesseraSessionMemory({ storage, closeStorage: false });
      await sessions.createThread({ id: input.threadId, resourceId: "local-studio", agentType: "feishu" });
      const agent = createTesseraStudioFeishuAgent({ reader, memory, model, llm, mastra, defaultIdentity: LOCAL_STUDIO_IDENTITY });
      const stream = agent.streamUI(input).getReader();
      let text = "";
      while (true) { const chunk = await stream.read(); if (chunk.done) break; if (chunk.value.type === "text-delta") text += chunk.value.delta; }
      expect(text).toBe("Document analysis is ready.");
      expect(await sessions.getThread({ id: input.threadId, resourceId: "local-studio" })).toMatchObject({ agentType: "feishu" });
      expect((await memory.recall({ threadId: input.threadId, resourceId: "local-studio" })).messages.length).toBeGreaterThan(0);
      await sessions.close();
    } finally { await storage.close(); }
  });
});
