import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenGenerativeHost } from "@open-generative/mastra";
import { openGenerativeSurfaceStreamSchema } from "@open-generative/protocol";
import { selectFoundationForSnapshot } from "@open-generative/ui";
import type { DataAgent } from "@open-tessera/data-agent";
import type { DatabaseCatalog, DatabaseQueryResult } from "@open-tessera/database";
import type { TesseraLlmConfig } from "./config";
import { tesseraOpenGenerativeFoundationFor } from "./client/open-generative-foundation";
import { createTesseraStudioAgent } from "./agent";
import type { TesseraUIMessageChunk } from "./protocol";
import { createTesseraSessionMemory } from "./session-memory";

const semanticFingerprint = `sha256:${"a".repeat(64)}`;

describe("Tessera Open Generative E2E", () => {
  test("streams a committed Surface that the Studio demo Foundation accepts", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-open-generative-e2e-"));
    const session = createTesseraSessionMemory({ rootDirectory });
    const host = await createOpenGenerativeHost();
    const reads: unknown[] = [];
    const dataAgent = {
      connectorId: "test",
      dialect: "postgres",
      async inspectCatalog() {
        return {
          catalog: {
            connectorId: "test",
            dialect: "postgres",
            databaseName: "analytics",
            scannedAt: "2026-08-28T00:00:00.000Z",
            fingerprint: semanticFingerprint,
            schemas: [{
              name: "public",
              tables: [{
                schema: "public",
                name: "metrics",
                kind: "table",
                columns: [{ name: "value", dataType: "integer", nullable: false, ordinal: 1 }],
                primaryKey: [],
                foreignKeys: [],
              }],
            }],
          } satisfies DatabaseCatalog,
        };
      },
      async executeReadSql(input: unknown) {
        reads.push(input);
        return {
          queryId: "private-query-id",
          columns: [{ name: "value" }],
          rows: [{ value: 42 }],
          rowCount: 1,
          truncated: false,
          durationMs: 1,
        } satisfies DatabaseQueryResult;
      },
    } as unknown as DataAgent;

    let modelTurn = 0;
    const model = {
      specificationVersion: "v2",
      provider: "tessera-test",
      modelId: "open-generative-e2e",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("The deterministic fixture only supports Agent.stream.");
      },
      async doStream() {
        const turn = modelTurn++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (turn === 0) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "read-metric",
                  toolName: "execute_sql",
                  input: JSON.stringify({
                    sql: "SELECT 42 AS value",
                    parameters: [],
                    purpose: "Verified metric",
                  }),
                  providerExecuted: false,
                });
                controller.enqueue(finish("tool-calls"));
              } else if (turn === 1) {
                controller.enqueue({ type: "text-start", id: "business-final" });
                controller.enqueue({
                  type: "text-delta",
                  id: "business-final",
                  delta: "The verified metric is ready for presentation.",
                });
                controller.enqueue({ type: "text-end", id: "business-final" });
                controller.enqueue(finish("stop"));
              } else {
                controller.enqueue({ type: "text-start", id: "ogl-final" });
                for (const delta of [
                  'root = Report("Verified metric", "Read query result", content)\n',
                  'content = Stack("md", [metric])\n',
                  'metric = Metric("Metric value", @data1, "value", "number")\n',
                ]) {
                  controller.enqueue({ type: "text-delta", id: "ogl-final", delta });
                }
                controller.enqueue({ type: "text-end", id: "ogl-final" });
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
    const llm: TesseraLlmConfig = {
      model: model as unknown as string,
      headers: {},
      temperature: 0,
      maxOutputTokens: 256,
      maxSteps: 4,
      maxRetries: 0,
    };

    try {
      await session.createThread({ id: "thread-open-generative-e2e", resourceId: "local-studio" });
      const agent = createTesseraStudioAgent({
        dataAgent,
        memory: session.memory,
        llm,
        openGenerativeHost: host,
        permissionContext: {
          accessMode: "read-only",
          databaseActionsAvailable: false,
          sqlStatements: { read: "allow", write: "deny", destructive: "deny", unknown: "deny" },
        },
      });
      const source = agent.streamUI?.({
        runId: "run-open-generative-e2e",
        threadId: "thread-open-generative-e2e",
        message: "Show the verified metric as a chart.",
        signal: new AbortController().signal,
      });
      if (source === undefined) throw new Error("Expected Studio Agent streamUI support.");

      const chunks = await readUiChunks(source);
      const surfaceStreams = chunks.flatMap((chunk) => (
        chunk.type === "data-openGenerativeSurface"
          ? [openGenerativeSurfaceStreamSchema.parse(chunk.data)]
          : []
      ));
      const committed = surfaceStreams.find((stream) => (
        stream.events.some((event) => event.payload.type === "revision-committed")
      ));
      if (committed === undefined) {
        throw new Error(`Expected a committed Surface; received ${chunks.map((chunk) => chunk.type).join(", ")}.`);
      }
      const snapshot = committed.events[0];
      if (snapshot?.payload.type !== "snapshot-published") {
        throw new Error("The committed Surface stream did not begin with a snapshot.");
      }
      const commit = committed.events.find((event) => event.payload.type === "revision-committed");
      if (commit?.payload.type !== "revision-committed") {
        throw new Error("The committed Surface stream did not contain a revision commit.");
      }

      const foundation = await tesseraOpenGenerativeFoundationFor("demo");
      const selected = await selectFoundationForSnapshot(foundation, snapshot, true);
      const productionFoundation = await tesseraOpenGenerativeFoundationFor("production");
      selected.registry.assertExactCoverage(
        commit.payload.revision.content.contracts.componentRefs,
        "Tessera deterministic Open Generative E2E",
      );

      expect(modelTurn).toBe(3);
      expect(reads).toEqual([{
        sql: "SELECT 42 AS value",
        parameters: [],
        purpose: "Verified metric",
      }]);
      expect(chunks.some((chunk) => chunk.type === "data-openGenerativeFallback")).toBeFalse();
      expect(surfaceStreams.length).toBeGreaterThan(0);
      expect(committed.events.at(-1)?.payload.type).toBe("revision-committed");
      expect(foundation.integrity.mode).toBe("development");
      expect(selected.registry.mode).toBe("development");
      expect(productionFoundation.integrity.mode).toBe("verified");
      expect(
        String(commit.payload.revision.content.nodes[
          commit.payload.revision.content.rootNodeId
        ]?.contract.componentType),
      ).toBe("analysis.report");
    } finally {
      await host.close();
      await session.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });
});

async function readUiChunks(stream: ReadableStream<TesseraUIMessageChunk>): Promise<TesseraUIMessageChunk[]> {
  const chunks: TesseraUIMessageChunk[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function finish(reason: "tool-calls" | "stop") {
  return {
    type: "finish",
    finishReason: reason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}
