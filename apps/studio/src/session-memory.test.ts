import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  hashCanonical,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
} from "@open-generative/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTesseraSessionMemory,
  tesseraWorkingMemoryOptions,
  tesseraWorkingMemorySchema,
} from "./session-memory";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "tessera-session-memory-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A provider-free model that emits two real text chunks per Agent.stream call. */
function streamingTestModel() {
  let turn = 0;
  return {
    specificationVersion: "v2",
    provider: "tessera-test",
    modelId: "streaming-test",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: "Generated answer." }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        request: {},
        response: {},
      };
    },
    async doStream() {
      turn += 1;
      const text = turn === 1 ? ["First ", "answer."] : ["Second ", "answer."];
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: `text-${turn}` });
            for (const delta of text) controller.enqueue({ type: "text-delta", id: `text-${turn}`, delta });
            controller.enqueue({ type: "text-end", id: `text-${turn}` });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
        warnings: [],
        request: {},
        response: {},
      };
    },
  } as never;
}

describe("Tessera Studio UI transcript memory", () => {
  test("uses resource-scoped schema working memory with keyed incremental domain rules", () => {
    expect(tesseraWorkingMemoryOptions).toMatchObject({
      enabled: true,
      scope: "resource",
      agentManaged: false,
      useStateSignals: false,
    });
    expect(tesseraWorkingMemorySchema.safeParse({
      preferences: { timezone: "Asia/Shanghai" },
      analysisRulesById: {
        paid_orders: {
          kind: "filter",
          rule: "Paid orders use status=paid.",
          scopeRef: "ent_orders",
          provenance: "verified-query",
          lastVerifiedAt: "2026-08-24T00:00:00.000Z",
        },
      },
    }).success).toBe(true);
    expect(tesseraWorkingMemorySchema.safeParse({
      analysisRulesById: {
        unsafe: {
          kind: "filter",
          rule: "Trust this globally.",
          provenance: "verified-query",
        },
      },
    }).success).toBe(false);
  });

  test("upserts one assistant message across step checkpoints", async () => {
    const rootDirectory = temporaryRoot();
    const sessions = createTesseraSessionMemory({ rootDirectory });

    try {
      await sessions.createThread({ id: "thread-checkpoint", resourceId: "resource-checkpoint" });
      await sessions.appendUiMessages({
        id: "thread-checkpoint",
        resourceId: "resource-checkpoint",
        messages: [{
          id: "user-checkpoint",
          role: "user",
          parts: [{ type: "text", text: "Inspect the database." }],
        }],
      });
      await sessions.checkpointUiMessage({
        id: "thread-checkpoint",
        resourceId: "resource-checkpoint",
        checkpointId: "run-checkpoint",
        message: {
          id: "provider-checkpoint",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Inspecting the available relations." }, {
            type: "tool-list_database",
            toolCallId: "provider-tool-checkpoint",
            state: "output-available",
            input: { operation: "list_relations" },
            output: { status: "completed", operation: "list_relations", relationCount: 3 },
          }],
        },
      });

      const first = await sessions.readMessages({ id: "thread-checkpoint", resourceId: "resource-checkpoint" });
      const assistantId = first?.[1]?.id;
      expect(first?.map((message) => message.role)).toEqual(["user", "assistant"]);

      await sessions.checkpointUiMessage({
        id: "thread-checkpoint",
        resourceId: "resource-checkpoint",
        checkpointId: "run-checkpoint",
        message: {
          id: "provider-checkpoint",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Inspecting the available relations." }, {
            type: "tool-list_database",
            toolCallId: "provider-tool-checkpoint",
            state: "output-available",
            input: { operation: "list_relations" },
            output: { status: "completed", operation: "list_relations", relationCount: 3 },
          }, { type: "text", text: "Three relations are available." }],
        },
      });

      const completed = await sessions.readMessages({ id: "thread-checkpoint", resourceId: "resource-checkpoint" });
      expect(completed?.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(completed?.[1]?.id).toBe(assistantId);
      expect(JSON.stringify(completed)).toContain("Three relations are available.");
      expect(JSON.stringify(completed)).not.toContain("provider-checkpoint");
      expect(JSON.stringify(completed)).not.toContain("provider-tool-checkpoint");
    } finally {
      await sessions.close();
    }
  });

  test("restores native reasoning and tool data while discarding custom data parts", async () => {
    const rootDirectory = temporaryRoot();
    const sessions = createTesseraSessionMemory({ rootDirectory });
    const rawSql = "select raw_secret_value from private.customer_rows";
    const rawRow = "raw-result-row-marker";
    const credential = "sk-or-v1-credential-marker-123456789";
    const providerError = "provider-error-marker-do-not-retain";
    const safeReasoning = "Compared the verified result with the requested period.";

    try {
      await sessions.createThread({ id: "thread-1", resourceId: "resource-1", title: "Orders" });
      await sessions.appendUiMessages({
        id: "thread-1",
        resourceId: "resource-1",
        messages: [{
          id: "browser-message-id",
          role: "user",
          parts: [{ type: "text", text: `Show revenue. api_key=${credential}` }],
        }, {
          id: "provider-message-id",
          role: "assistant",
          metadata: { providerError },
          parts: [{ type: "text", text: "Revenue increased during the selected period." }, {
            type: "reasoning",
            text: safeReasoning,
          }, {
            type: "tool-search_data_context",
            toolCallId: "provider-catalog-call-id",
            state: "output-available",
            input: { query: rawSql, password: credential },
            output: {
              status: "completed",
              mode: "search",
              entityCount: 3,
              truncated: true,
              tables: [{ name: "private.customer_rows" }],
            },
            callProviderMetadata: { providerError },
          }, {
            type: "tool-list_database",
            toolCallId: "provider-schema-call-id",
            state: "output-available",
            input: { operation: "describe_schema", schema: "private", token: credential },
            output: {
              status: "completed",
              operation: "describe_schema",
              schema: {
                name: "private",
                tables: [{
                  name: "customer_rows",
                  columns: [{ name: "secret_token", dataType: "text", nullable: false }],
                  primaryKey: ["secret_token"],
                  foreignKeys: [{
                    name: "customer_rows_owner_fkey",
                    columns: ["owner_id"],
                    referencedSchema: "private",
                    referencedTable: "owners",
                    referencedColumns: ["id"],
                  }],
                }],
              },
              tableCount: 1,
              columnCount: 1,
              foreignKeyCount: 1,
              truncated: false,
            },
            callProviderMetadata: { providerError },
          }, {
            type: "tool-execute_sql",
            toolCallId: "provider-sql-call-id",
            state: "output-available",
            input: { sql: rawSql, token: credential },
            output: {
              status: "approval_required",
              mode: "mutation",
              requestId: "database-action-request-1",
              checkpointId: "database-action-checkpoint-1",
              rows: [rawRow],
            },
          }, {
            type: "tool-prepare_analysis",
            toolCallId: "provider-analysis-call-id",
            state: "output-available",
            input: { sql: rawSql, token: credential },
            output: {
              status: "completed",
              rowCount: 1,
              truncated: false,
              rows: [{ secret: rawRow }],
              providerError,
            },
          }, {
            type: "data-tessera-stage",
            id: "provider-stage-id",
            data: {
              runId: "provider-run-id",
              stage: "executing",
              status: "completed",
              durationMs: 12.4,
              sql: rawSql,
            },
          }, {
            type: "data-tessera-execution",
            id: "provider-execution-id",
            data: {
              runId: "provider-run-id",
              status: "completed",
              stages: [
                { stage: "catalog", status: "completed", durationMs: 4 },
                { stage: "retrieval", status: "completed", durationMs: 3 },
                { stage: "planning", status: "completed", durationMs: 8 },
                { stage: "probing", status: "completed", durationMs: 2 },
                { stage: "compiling", status: "completed", durationMs: 1 },
                { stage: "executing", status: "completed", durationMs: 12 },
                { stage: "verifying", status: "completed", durationMs: 3 },
                { stage: "publishing", status: "completed", durationMs: 2 },
                { stage: "narrating", status: "completed", durationMs: 1 },
              ],
              rawSql,
            },
          }, {
            type: "data-tessera-artifact",
            id: "provider-artifact-part-id",
            data: {
              artifact: {
                protocolVersion: "1.0",
                id: "provider-artifact-id",
                kind: "query",
                title: "Revenue by day",
                description: "Verified daily revenue.",
                metricDefinition: "Sum of approved order revenue.",
                timeZone: "UTC",
                filters: ["secret filter"],
                warnings: [providerError],
                sql: rawSql,
                columns: [
                  { key: "day", label: "Day", type: "date", format: "plain" },
                  { key: "revenue", label: "Revenue", type: "number", format: "currency", currency: "USD" },
                ],
                rows: [{ day: "2026-08-16", revenue: rawRow }],
                rowCount: 1,
                truncated: false,
                durationMs: 12,
                sourceTables: ["analytics.orders"],
                chart: { kind: "line", xKey: "day", yKeys: ["revenue"] },
              },
              evidence: [{ queryId: "provider-query-id", label: "Daily revenue" }],
            },
          } as unknown as never, {
            type: "data-tessera-artifact",
            id: "provider-artifact-part-id-2",
            data: {
              artifact: {
                protocolVersion: "1.0",
                id: "provider-artifact-id-2",
                kind: "metric",
                title: "Revenue total",
                description: "Verified total revenue.",
                metrics: [{ id: "total", label: "Revenue", value: 42, format: "currency", currency: "USD" }],
              },
              evidence: [],
            },
          } as unknown as never, {
            type: "data-tessera-run",
            id: "provider-run-part-id",
            data: {
              runId: "provider-run-id",
              threadId: "provider-thread-id",
              status: "completed",
              evidence: [{ queryId: "provider-query-id", label: "Daily revenue" }],
            },
          }, {
            type: "source-url",
            sourceId: "source-1",
            url: `https://example.test/?key=${credential}`,
          }],
        }],
      });

      const messages = await sessions.readMessages({ id: "thread-1", resourceId: "resource-1" });
      expect(messages).toHaveLength(2);
      expect(messages?.[0]?.role).toBe("user");
      expect(messages?.[1]?.role).toBe("assistant");

      const assistantParts = messages?.[1]?.parts ?? [];
      expect(assistantParts).toContainEqual(expect.objectContaining({
        type: "tool-search_data_context",
        state: "output-available",
        input: { action: "search_data_context" },
        output: { status: "completed", mode: "search", entityCount: 3, truncated: true },
      }));
      expect(assistantParts).toContainEqual(expect.objectContaining({
        type: "tool-list_database",
        state: "output-available",
        input: { action: "list_database" },
        output: {
          status: "completed",
          operation: "describe_schema",
          tableCount: 1,
          columnCount: 1,
          foreignKeyCount: 1,
          truncated: false,
        },
      }));
      expect(assistantParts).toContainEqual(expect.objectContaining({
        type: "tool-execute_sql",
        state: "output-available",
        input: { action: "execute_sql" },
        output: {
          status: "approval_required",
          mode: "mutation",
          requestId: "database-action-request-1",
          checkpointId: "database-action-checkpoint-1",
        },
      }));
      expect(assistantParts).toContainEqual(expect.objectContaining({
        type: "tool-prepare_analysis",
        state: "output-available",
        input: { action: "prepare_analysis" },
        output: { status: "completed" },
      }));
      expect(assistantParts).toContainEqual(expect.objectContaining({
        type: "reasoning",
        text: safeReasoning,
        state: "done",
      }));

      const publicJson = JSON.stringify(messages);
      expect(publicJson).toContain("Revenue increased");
      expect(publicJson).toContain(safeReasoning);
      expect(publicJson).not.toContain(rawSql);
      expect(publicJson).not.toContain(rawRow);
      expect(publicJson).not.toContain("private.customer_rows");
      expect(publicJson).not.toContain("secret_token");
      expect(publicJson).not.toContain("customer_rows_owner_fkey");
      expect(publicJson).not.toContain("data-tessera-");
      expect(publicJson).not.toContain(credential);
      expect(publicJson).not.toContain(providerError);
      expect(publicJson).not.toContain("provider-query-id");
      expect(publicJson).not.toContain("provider-message-id");
    } finally {
      await sessions.close();
    }

    const restoredSessions = createTesseraSessionMemory({ rootDirectory });
    try {
      const restored = await restoredSessions.readMessages({ id: "thread-1", resourceId: "resource-1" });
      const restoredJson = JSON.stringify(restored);
      expect(restoredJson).not.toContain(rawSql);
      expect(restoredJson).not.toContain(rawRow);
      expect(restoredJson).not.toContain("private.customer_rows");
      expect(restoredJson).not.toContain("secret_token");
      expect(restoredJson).not.toContain("customer_rows_owner_fkey");
      expect(restoredJson).toContain(safeReasoning);
      expect(restoredJson).not.toContain("data-tessera-");
      expect(restoredJson).not.toContain(credential);
      expect(restoredJson).not.toContain(providerError);
    } finally {
      await restoredSessions.close();
    }
  });

  test("restores a validated Open Generative surface while discarding arbitrary custom data", async () => {
    const rootDirectory = temporaryRoot();
    const sessions = createTesseraSessionMemory({ rootDirectory });
    const payload = {
      type: "rejected" as const,
      transactionId: "transaction-session-surface",
      diagnostics: [{
        phase: "validate" as const,
        code: "validate.fixture",
        severity: "error" as const,
        recoverable: true,
        modelCorrectable: true,
        message: "Fixture rejection.",
      }],
    };
    const event = surfaceEventEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      surfaceSessionId: "surface-session-memory",
      streamId: "stream-session-memory",
      epoch: 1,
      sequence: 1,
      eventId: "event-session-memory-1",
      cursor: "cursor-session-memory-0001",
      committedRevisionId: "revision-session-memory",
      audienceBindingHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
      contractSetHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
      correlationId: "correlation-session-memory",
      payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload),
      payload,
    });
    const nextPayload = {
      ...payload,
      transactionId: "transaction-session-surface-next",
    };
    const nextEvent = surfaceEventEnvelopeSchema.parse({
      ...event,
      sequence: 2,
      eventId: "event-session-memory-2",
      cursor: "cursor-session-memory-0002",
      payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, nextPayload),
      payload: nextPayload,
    });

    try {
      await sessions.createThread({ id: "thread-surface", resourceId: "resource-surface" });
      await sessions.appendUiMessages({
        id: "thread-surface",
        resourceId: "resource-surface",
        messages: [{
          id: "message-surface",
          role: "assistant",
          parts: [{ type: "text", text: "The analysis is complete." }, {
            type: "data-openGenerativeSurface",
            id: `open-generative:${event.surfaceSessionId}`,
            data: {
              surfaceSessionId: event.surfaceSessionId,
              events: [event],
            },
          }, {
            type: "data-openGenerativeSurface",
            id: `open-generative:${event.surfaceSessionId}`,
            data: {
              surfaceSessionId: event.surfaceSessionId,
              events: [event, nextEvent],
            },
          }, {
            type: "data-untrusted-custom-part",
            data: { secret: "discard-me" },
          }],
        }],
      });

      const messages = await sessions.readMessages({ id: "thread-surface", resourceId: "resource-surface" });
      expect(messages?.[0]?.parts).toContainEqual({
        type: "data-openGenerativeSurface",
        id: `open-generative:${event.surfaceSessionId}`,
        data: {
          surfaceSessionId: event.surfaceSessionId,
          events: [event, nextEvent],
        },
      });
      expect(messages?.[0]?.parts.filter((part) => part.type === "data-openGenerativeSurface")).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("discard-me");
    } finally {
      await sessions.close();
    }
  });

  test("persists the bounded Open Generative fallback without compiler diagnostics", async () => {
    const rootDirectory = temporaryRoot();
    const sessions = createTesseraSessionMemory({ rootDirectory });
    try {
      await sessions.createThread({ id: "thread-generative-fallback", resourceId: "resource-generative-fallback" });
      await sessions.appendUiMessages({
        id: "thread-generative-fallback",
        resourceId: "resource-generative-fallback",
        messages: [{
          id: "message-generative-fallback",
          role: "assistant",
          parts: [{
            type: "data-openGenerativeFallback",
            id: "open-generative-fallback:surface-rejected",
            data: { state: "discarded", reason: "invalid-presentation" },
          }],
        }],
      });

      const messages = await sessions.readMessages({
        id: "thread-generative-fallback",
        resourceId: "resource-generative-fallback",
      });
      expect(messages?.[0]?.parts).toEqual([{
        type: "data-openGenerativeFallback",
        id: "open-generative-fallback:surface-rejected",
        data: { state: "discarded", reason: "invalid-presentation" },
      }]);
      expect(JSON.stringify(messages)).not.toContain("diagnostic");
    } finally {
      await sessions.close();
    }
  });

  test("preserves list_database lookup and availability states without turning them into failures", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-session-list-database-status-"));
    const sessions = createTesseraSessionMemory({ rootDirectory });
    try {
      await sessions.createThread({ id: "thread-status", resourceId: "resource-status" });
      await sessions.appendUiMessages({
        id: "thread-status",
        resourceId: "resource-status",
        messages: [{
          id: "assistant-status",
          role: "assistant",
          parts: [{
            type: "tool-list_database",
            toolCallId: "lookup-status",
            state: "output-available",
            input: { operation: "describe_relation", schema: "public", relation: "users" },
            output: {
              status: "not_found",
              operation: "describe_relation",
              reason: "relation_not_found",
              message: "The exact relation was not found.",
            },
          }],
        }],
      });

      const messages = await sessions.readMessages({ id: "thread-status", resourceId: "resource-status" });
      expect(messages?.[0]?.parts).toEqual([expect.objectContaining({
        state: "output-available",
        output: expect.objectContaining({
          status: "not_found",
          reason: "relation_not_found",
        }),
      })]);
    } finally {
      await sessions.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("restores prepare_analysis outcomes with their public completed and blocked states", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-session-analysis-status-"));
    const sessions = createTesseraSessionMemory({ rootDirectory });
    try {
      await sessions.createThread({ id: "thread-analysis-status", resourceId: "resource-analysis-status" });
      await sessions.appendUiMessages({
        id: "thread-analysis-status",
        resourceId: "resource-analysis-status",
        messages: [{
          id: "assistant-analysis-status",
          role: "assistant",
          parts: [{
            type: "tool-prepare_analysis",
            toolCallId: "prepared-analysis",
            state: "output-available",
            input: { title: "Private plan input" },
            output: { status: "prepared", analysisRef: "private-analysis-reference" },
          }, {
            type: "tool-prepare_analysis",
            toolCallId: "rejected-analysis",
            state: "output-available",
            input: { title: "Private rejected input" },
            output: {
              status: "rejected",
              reason: "catalog_incomplete",
              message: "Expand the selected catalog entity before retrying.",
            },
          }],
        }],
      });

      const messages = await sessions.readMessages({
        id: "thread-analysis-status",
        resourceId: "resource-analysis-status",
      });
      expect(messages?.[0]?.parts).toEqual([
        expect.objectContaining({
          type: "tool-prepare_analysis",
          state: "output-available",
          input: { action: "prepare_analysis" },
          output: { status: "completed" },
        }),
        expect.objectContaining({
          type: "tool-prepare_analysis",
          state: "output-available",
          input: { action: "prepare_analysis" },
          output: {
            status: "blocked",
            reason: "catalog_incomplete",
            message: "Expand the selected catalog entity before retrying.",
          },
        }),
      ]);
      expect(JSON.stringify(messages)).not.toContain("private-analysis-reference");
      expect(JSON.stringify(messages)).not.toContain("Private plan input");
    } finally {
      await sessions.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("preserves a safe concrete tool error while removing SQL and credentials", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-session-tool-error-"));
    const sessions = createTesseraSessionMemory({ rootDirectory });
    try {
      await sessions.createThread({ id: "thread-error", resourceId: "resource-error" });
      await sessions.appendUiMessages({
        id: "thread-error",
        resourceId: "resource-error",
        messages: [{
          id: "assistant-error",
          role: "assistant",
          parts: [{
            type: "tool-list_database",
            toolCallId: "private-tool-call-id",
            state: "output-error",
            input: { operation: "describe_schema", schema: "private" },
            errorText: 'column "missing_total" does not exist. api_key=sk-or-private-error-key-123456 sql: SELECT missing_total FROM private.billing',
          }],
        }],
      });

      const messages = await sessions.readMessages({ id: "thread-error", resourceId: "resource-error" });
      const errorPart = messages?.[0]?.parts[0];
      expect(errorPart).toEqual(expect.objectContaining({
        type: "tool-list_database",
        state: "output-error",
        errorText: expect.stringContaining('column "missing_total" does not exist.'),
      }));
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("[REDACTED]");
      expect(serialized).toContain("[REDACTED_SQL]");
      expect(serialized).not.toContain("sk-or-private-error-key-123456");
      expect(serialized).not.toContain("SELECT missing_total");
      expect(serialized).not.toContain("private-tool-call-id");
    } finally {
      await sessions.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("never returns a UI transcript across resource ownership boundaries", async () => {
    const sessions = createTesseraSessionMemory({ rootDirectory: temporaryRoot() });
    try {
      await sessions.createThread({ id: "thread-owned", resourceId: "resource-owner" });
      await sessions.appendUiMessages({
        id: "thread-owned",
        resourceId: "resource-owner",
        messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "Show orders" }] }],
      });

      expect(await sessions.readMessages({ id: "thread-owned", resourceId: "resource-owner" })).toHaveLength(1);
      expect(await sessions.readMessages({ id: "thread-owned", resourceId: "resource-other" })).toBeUndefined();
    } finally {
      await sessions.close();
    }
  });

  test("clears every thread for one resource without touching another resource", async () => {
    const sessions = createTesseraSessionMemory({ rootDirectory: temporaryRoot() });
    try {
      await sessions.createThread({ id: "thread-a-1", resourceId: "resource-a" });
      await sessions.createThread({ id: "thread-a-2", resourceId: "resource-a" });
      await sessions.createThread({ id: "thread-b-1", resourceId: "resource-b" });

      expect(await sessions.clearThreads({ resourceId: "resource-a" })).toEqual(expect.arrayContaining([
        "thread-a-1",
        "thread-a-2",
      ]));
      expect(await sessions.listThreads({ resourceId: "resource-a" })).toEqual([]);
      expect((await sessions.listThreads({ resourceId: "resource-b" })).map((thread) => thread.id)).toEqual(["thread-b-1"]);
    } finally {
      await sessions.close();
    }
  });

  test("does not treat private Mastra model history as a browser transcript", async () => {
    const sessions = createTesseraSessionMemory({ rootDirectory: temporaryRoot() });
    try {
      await sessions.createThread({ id: "thread-empty", resourceId: "resource-1" });
      expect(await sessions.readMessages({ id: "thread-empty", resourceId: "resource-1" })).toEqual([]);
    } finally {
      await sessions.close();
    }
  });

  test("persists native Agent streams privately by thread and resource", async () => {
    const sessions = createTesseraSessionMemory({ rootDirectory: temporaryRoot() });
    try {
      await sessions.createThread({ id: "thread-stream", resourceId: "resource-owner" });
      const agent = new Agent({
        id: "memory-stream-test",
        name: "Memory stream test",
        model: streamingTestModel(),
        instructions: "Reply with the provided test response.",
        memory: sessions.memory,
      });

      const first = await agent.stream("Remember that the fiscal period is April.", {
        memory: { thread: "thread-stream", resource: "resource-owner" },
      });
      const firstDeltas: string[] = [];
      for await (const event of first.fullStream) {
        if (event.type !== "text-delta") continue;
        const payload = event.payload as { text?: unknown };
        if (typeof payload.text === "string") firstDeltas.push(payload.text);
      }
      expect(firstDeltas).toEqual(["First ", "answer."]);

      const second = await agent.stream("Use the remembered fiscal period.", {
        memory: { thread: "thread-stream", resource: "resource-owner" },
      });
      for await (const _ of second.fullStream) {
        // Consuming the stream lets Mastra finish its automatic memory write.
      }

      const context = await sessions.memory.getContext({
        threadId: "thread-stream",
        resourceId: "resource-owner",
      });
      const privateHistory = JSON.stringify(context.messages);
      expect(privateHistory).toContain("Remember that the fiscal period is April.");
      expect(privateHistory).toContain("Use the remembered fiscal period.");
      expect(privateHistory).toContain("First answer.");
      expect(privateHistory).toContain("Second answer.");

      const otherResource = await sessions.memory.getContext({
        threadId: "thread-stream",
        resourceId: "resource-other",
      });
      expect(otherResource.messages).toEqual([]);
      expect(await sessions.readMessages({ id: "thread-stream", resourceId: "resource-owner" })).toEqual([]);
    } finally {
      await sessions.close();
    }
  });
});
