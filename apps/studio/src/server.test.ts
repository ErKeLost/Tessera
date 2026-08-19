import { describe, expect, test } from "bun:test";
import {
  finalizeCatalog,
  type ConnectionAssessment,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
} from "@data-elements/database";
import {
  createStudioApp,
  createStudioCatalogProvider,
  createTesseraDatabaseConnector,
  TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS,
  type StudioAgentRunInput,
  type StudioLogEvent,
} from "./server";
import { defineTesseraConfig } from "./config";
import type { TesseraUIMessageChunk } from "./protocol";

const catalog = finalizeCatalog({
  connectorId: "postgres:catalog-secret",
  dialect: "postgres",
  databaseName: "warehouse",
  scannedAt: "2026-08-15T00:00:00.000Z",
  schemas: [{
    name: "public",
    tables: [{
      schema: "public",
      name: "orders",
      kind: "table",
      comment: "Orders placed by customers",
      columns: [{
        name: "id",
        dataType: "uuid",
        nullable: false,
        ordinal: 1,
        defaultValue: "gen_random_uuid()",
        comment: "Generated identifier",
      }],
      primaryKey: ["id"],
      foreignKeys: [],
    }],
  }],
});

const connectedAssessment: ConnectionAssessment = {
  connectorId: "postgres:assessment-secret",
  dialect: "postgres",
  connected: true,
  databaseName: "warehouse",
  host: "database-secret.internal",
  serverVersion: "PostgreSQL 17.2",
  readOnlyTransactions: true,
  credentialCanWrite: false,
  latencyMs: 4,
  warnings: ["raw connector warning that must not be returned"],
};

function createConnector(overrides: Partial<{
  assess(signal?: AbortSignal): Promise<ConnectionAssessment>;
  introspect(): Promise<DatabaseCatalog>;
  query(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult>;
}> = {}): DatabaseConnector {
  return {
    id: "postgres:connector-secret",
    dialect: "postgres",
    assess: overrides.assess ?? (async () => connectedAssessment),
    introspect: overrides.introspect ?? (async () => catalog),
    query: overrides.query ?? (async () => {
      return {
        queryId: "query-1",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      };
    }),
    async close() {},
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:4317${path}`, init);
}

describe("Tessera Studio Hono app", () => {
  test("uses Bun's maximum global idle allowance for Studio requests", () => {
    expect(TESSERA_STUDIO_IDLE_TIMEOUT_SECONDS).toBe(255);
  });

  test("exposes a non-cacheable health probe", async () => {
    const app = createStudioApp({ connector: createConnector() });
    const response = await app.fetch(request("/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ status: "ok", service: "tessera-studio", readiness: "ready" });
  });

  test("returns connection status without connector ids, hosts, warnings, or credentials", async () => {
    const app = createStudioApp({ connector: createConnector() });
    const response = await app.fetch(request("/api/connection"));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("warehouse");
    expect(text).not.toContain("assessment-secret");
    expect(text).not.toContain("database-secret.internal");
    expect(text).not.toContain("raw connector warning");
    expect(text).not.toContain("readonly:secret");
  });

  test("returns a catalog without connector ids, comments, or defaults", async () => {
    const app = createStudioApp({ connector: createConnector() });
    const response = await app.fetch(request("/api/catalog"));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("orders");
    expect(text).not.toContain("catalog-secret");
    expect(text).not.toContain("Orders placed by customers");
    expect(text).not.toContain("Generated identifier");
    expect(text).not.toContain("gen_random_uuid");
  });

  test("serves a catalog-constrained, bounded table preview without exposing query internals", async () => {
    const requests: DatabaseQueryRequest[] = [];
    const app = createStudioApp({
      connector: createConnector({
        query: async (query) => {
          requests.push(query);
          return {
            queryId: "query-secret-id",
            columns: [{ name: "id" }, { name: "not_in_catalog" }],
            rows: Array.from({ length: 101 }, (_, index) => ({
              id: `order-${index}`,
              not_in_catalog: "must not reach the browser",
            })),
            rowCount: 101,
            truncated: false,
            durationMs: 7,
          };
        },
      }),
    });

    const response = await app.fetch(request("/api/data/public/orders"));
    const preview = await response.json() as {
      table: {
        name: string;
        columns: Array<{ name: string; defaultValue?: string; comment?: string }>;
      };
      columns: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
      rowCount: number;
      truncated: boolean;
      durationMs: number;
    };

    expect(response.status).toBe(200);
    expect(requests).toEqual([{
      sql: 'SELECT "id"\nFROM "public"."orders"\nLIMIT 100',
      parameters: [],
      purpose: "Tessera relation preview",
      maxRows: 100,
      timeoutMs: 15_000,
    }]);
    expect(preview.table.name).toBe("orders");
    expect(preview.table.columns).toEqual([expect.objectContaining({ name: "id" })]);
    expect(preview.table.columns[0]?.defaultValue).toBeUndefined();
    expect(preview.table.columns[0]?.comment).toBeUndefined();
    expect(preview.columns).toEqual([expect.objectContaining({ name: "id" })]);
    expect(preview.rows).toHaveLength(100);
    expect(preview.rows[0]).toEqual({ id: "order-0" });
    expect(preview.rowCount).toBe(100);
    expect(preview.truncated).toBe(true);
    expect(preview.durationMs).toBe(7);
    expect(JSON.stringify(preview)).not.toContain("query-secret-id");
    expect(JSON.stringify(preview)).not.toContain("must not reach the browser");
  });

  test("rejects undiscovered table names before the connector is queried", async () => {
    let queryCount = 0;
    const app = createStudioApp({
      connector: createConnector({
        query: async () => {
          queryCount += 1;
          throw new Error("must not execute");
        },
      }),
    });

    const response = await app.fetch(request("/api/data/public/not-a-table"));

    expect(response.status).toBe(404);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("table_not_found");
    expect(queryCount).toBe(0);
  });

  test("quotes catalog identifiers with MySQL delimiters before running a table preview", async () => {
    const mysqlCatalog = finalizeCatalog({
      connectorId: "mysql:catalog-secret",
      dialect: "mysql",
      databaseName: "warehouse",
      scannedAt: "2026-08-15T00:00:00.000Z",
      schemas: [{
        name: "tenant`blue",
        tables: [{
          schema: "tenant`blue",
          name: "orders`2026",
          kind: "table",
          columns: [{ name: "row`id", dataType: "varchar", nullable: false, ordinal: 1 }],
          primaryKey: ["row`id"],
          foreignKeys: [],
        }],
      }],
    });
    let received: DatabaseQueryRequest | undefined;
    const baseConnector = createConnector({
      introspect: async () => mysqlCatalog,
      query: async (query) => {
        received = query;
        return {
          queryId: "query-1",
          columns: [{ name: "row`id" }],
          rows: [{ "row`id": "row-1" }],
          rowCount: 1,
          truncated: false,
          durationMs: 1,
        };
      },
    });
    const mysqlConnector: DatabaseConnector = { ...baseConnector, dialect: "mysql" };
    const app = createStudioApp({ connector: mysqlConnector });

    const response = await app.fetch(request("/api/data/tenant%60blue/orders%602026"));

    expect(response.status).toBe(200);
    expect(received?.sql).toBe("SELECT `row``id`\nFROM `tenant``blue`.`orders``2026`\nLIMIT 100");
    expect(received?.maxRows).toBe(100);
  });

  test("returns a secret-free capability handshake", async () => {
    const app = createStudioApp({ connector: createConnector() });
    const response = await app.fetch(request("/api/meta"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocolVersion: 1,
      capabilities: { chat: false },
    });
  });

  test("fails closed for a foreign browser origin while allowing an explicit Studio origin", async () => {
    const defaultApp = createStudioApp({ connector: createConnector() });
    const denied = await defaultApp.fetch(request("/api/catalog", {
      headers: { Origin: "https://foreign.example.test" },
    }));
    expect(denied.status).toBe(403);
    expect((await denied.json() as { error: { code: string } }).error.code).toBe("origin_denied");

    const app = createStudioApp({
      connector: createConnector(),
      allowedOrigins: ["https://studio.example.test"],
    });
    const accepted = await app.fetch(request("/api/catalog", {
      headers: { Origin: "https://studio.example.test" },
    }));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe("https://studio.example.test");
  });

  test("keeps runs unavailable until an Agent is injected", async () => {
    const app = createStudioApp({ connector: createConnector() });
    const response = await app.fetch(request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "What changed?" }),
    }));

    expect(response.status).toBe(503);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("agent_unavailable");
  });

  test("accepts image chat payloads larger than the former 64 KB request limit", async () => {
    const inputs: StudioAgentRunInput[] = [];
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run(input) {
          inputs.push(input);
          return { status: "completed", message: "I received the image." };
        },
      },
    });
    const dataUrl = `data:image/png;base64,${"A".repeat(70 * 1024)}`;
    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-large-image",
        threadId: "thread-large-image",
        trigger: "submit-message",
        messages: [{
          id: "user-large-image",
          role: "user",
          parts: [
            { type: "text", text: "Read this image." },
            { type: "file", mediaType: "image/png", url: dataUrl },
          ],
        }],
      }),
    }));

    expect(response.status).toBe(200);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.images).toEqual([{ dataUrl, mediaType: "image/png" }]);
  });

  test("fails closed when authentication is required and scopes an admitted identity into Agent runs", async () => {
    let received: StudioAgentRunInput | undefined;
    const denied = createStudioApp({ connector: createConnector(), requireAuthentication: true });
    const deniedResponse = await denied.fetch(request("/api/meta"));
    expect(deniedResponse.status).toBe(401);

    const app = createStudioApp({
      connector: createConnector(),
      requireAuthentication: true,
      authenticate: async () => ({ subject: "user-1", tenantId: "tenant-1" }),
      agent: {
        async run(input) {
          received = input;
          return { status: "needs_input", message: "Ready." };
        },
      },
    });
    const response = await app.fetch(request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Check orders", threadId: "thread-1" }),
    }));

    expect(response.status).toBe(200);
    expect(received?.identity).toEqual({ subject: "user-1", tenantId: "tenant-1" });
  });

  test("supplies a redacted Catalog to an injected Agent and returns text with evidence", async () => {
    let received: StudioAgentRunInput | undefined;
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run(input) {
          received = input;
          return {
            status: "completed",
            message: "Orders are stable.",
            evidence: [{ queryId: "query-1", label: "Daily order count" }],
          };
        },
      },
    });
    const response = await app.fetch(request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How are orders today?", threadId: "thread-1" }),
    }));
    const payload = await response.json() as {
      run: { id: string; threadId: string; message: string; evidence: Array<{ queryId: string; label: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.run.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(payload.run.threadId).toBe("thread-1");
    expect(payload.run.message).toBe("Orders are stable.");
    expect(payload.run.evidence).toEqual([{ queryId: "query-1", label: "Daily order count" }]);
    expect(payload.run).not.toHaveProperty("artifact");
    expect(payload.run).not.toHaveProperty("artifacts");
    expect(received?.catalog?.connectorId).toBe("tessera");
    expect(JSON.stringify(received)).not.toContain("catalog-secret");
    expect(JSON.stringify(received)).not.toContain("Orders placed by customers");
    expect(Object.keys(received ?? {})).not.toContain("connector");
  });

  test("filters legacy artifact chunks from the direct UI stream", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "text-start", id: "provider-text" });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "Two results are ready." });
              controller.enqueue({ type: "text-end", id: "provider-text" });
              controller.enqueue({
                type: "data-tessera-artifact",
                id: "provider-artifact-id",
                data: {
                  artifact: { id: "provider-artifact-id", title: "Provider result" },
                  evidence: [],
                },
              } as unknown as TesseraUIMessageChunk);
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });
    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-direct-legacy-artifact",
        threadId: "thread-direct-legacy-artifact",
        trigger: "submit-message",
        messages: [{ id: "user-direct-artifacts", role: "user", parts: [{ type: "text", text: "Show both results." }] }],
      }),
    }));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Two results are ready.");
    expect(body).not.toContain('"type":"data-tessera-artifact"');
    expect(body).not.toContain("provider-artifact-id");
  });

  test("streams bounded chat events while keeping tool payloads server-side", async () => {
    const info: StudioLogEvent[] = [];
    const errors: StudioLogEvent[] = [];
    const app = createStudioApp({
      connector: createConnector(),
      logger: {
        info(event) { info.push(event); },
        error(event) { errors.push(event); },
      },
      agent: {
        async run() {
          return { status: "needs_input", message: "Fallback response." };
        },
        async stream(_input, emit) {
          await emit({ type: "tool", tool: "inspect_catalog", state: "started" });
          await emit({ type: "text-delta", text: "I found the relevant table. " });
          await emit({ type: "tool", tool: "inspect_catalog", state: "completed" });
          await emit({ type: "tool", tool: "run_analysis", state: "completed" });
          return {
            status: "needs_input",
            message: "Orders are stable.",
          };
        },
      },
    });
    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-1",
        threadId: "thread-1",
        trigger: "submit-message",
        messages: [{
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "How are orders?" }],
        }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    expect(body).toContain('"type":"start"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain('"type":"data-tessera-tool"');
    expect(body).toContain('"tool":"run_analysis"');
    expect(body).toContain('"type":"data-tessera-run"');
    expect(body).toContain('"type":"finish"');
    expect(body).not.toContain("select secret from orders");

    const toolIds = [...body.matchAll(/"id":"(tessera-tool-[^"]+)"/g)].map((match) => match[1]);
    expect(toolIds).toHaveLength(3);
    expect(toolIds[0]).toBe(toolIds[1]);
    expect(toolIds[2]).not.toBe(toolIds[1]);
    expect(info).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "stream", stage: "tool", tool: "inspect_catalog", toolState: "started" }),
      expect.objectContaining({ event: "stream", stage: "tool", tool: "inspect_catalog", toolState: "completed" }),
      expect.objectContaining({ event: "stream", stage: "tool", tool: "run_analysis", toolState: "completed" }),
      expect.objectContaining({ event: "stream", stage: "completed", outcome: "completed" }),
    ]));
    expect(errors).toEqual([]);
  });

  test("does not expose empty provider iteration markers in a chat stream", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "start-step" });
              controller.enqueue({ type: "finish-step" });
              controller.enqueue({ type: "start-step" });
              controller.enqueue({ type: "text-start", id: "provider-text" });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "The result is ready." });
              controller.enqueue({ type: "text-end", id: "provider-text" });
              controller.enqueue({ type: "finish-step" });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-steps",
        trigger: "submit-message",
        messages: [{ id: "user-steps", role: "user", parts: [{ type: "text", text: "Check orders" }] }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"text-delta"');
    expect(body).not.toContain('"type":"start-step"');
    expect(body).not.toContain('"type":"finish-step"');
  });

  test("keeps ordinary assistant deltas incremental after the public text gate", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "text-start", id: "provider-text" });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "The result " });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "is ready." });
              controller.enqueue({ type: "text-end", id: "provider-text" });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-safe-deltas",
        trigger: "submit-message",
        messages: [{ id: "user-safe-deltas", role: "user", parts: [{ type: "text", text: "Check orders" }] }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect([...body.matchAll(/"type":"text-delta"/g)]).toHaveLength(2);
    expect(body).toContain('"delta":"The result "');
    expect(body).toContain('"delta":"is ready."');
    expect(body.indexOf('"type":"text-start"')).toBeLessThan(body.indexOf('"delta":"The result "'));
    expect(body).toContain('"type":"text-end"');
  });

  test("blocks split raw SQL before any text segment reaches chat SSE", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "text-start", id: "provider-text" });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "select tessera_split_sql_marker " });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "from hidden.orders" });
              controller.enqueue({ type: "text-end", id: "provider-text" });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-split-sql",
        trigger: "submit-message",
        messages: [{ id: "user-split-sql", role: "user", parts: [{ type: "text", text: "Check orders" }] }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("tessera_split_sql_marker");
    expect(body).not.toContain("hidden.orders");
    expect(body).not.toContain('"type":"text-start"');
    expect(body).not.toContain('"type":"text-delta"');
    expect(body).not.toContain('"type":"text-end"');
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"finishReason":"error"');
  });

  test("renders a tool input rejection as a terminal tool error", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "tool-input-start", toolCallId: "provider-tool", toolName: "run_analysis" });
              controller.enqueue({ type: "tool-input-available", toolCallId: "provider-tool", toolName: "run_analysis", input: {} });
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "provider-tool",
                output: { error: true, message: "private validation detail" },
              });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-tool-rejection",
        trigger: "submit-message",
        messages: [{ id: "user-tool-rejection", role: "user", parts: [{ type: "text", text: "Check orders" }] }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"tool-output-error"');
    expect(body).not.toContain('"type":"tool-output-available"');
    expect(body).not.toContain("private validation detail");
  });

  test("renders a recoverable semantic-plan rejection as a completed blocked tool", async () => {
    const app = createStudioApp({
      connector: createConnector(),
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "provider-message" });
              controller.enqueue({ type: "tool-input-start", toolCallId: "provider-tool", toolName: "run_analysis" });
              controller.enqueue({ type: "tool-input-available", toolCallId: "provider-tool", toolName: "run_analysis", input: {} });
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "provider-tool",
                output: { status: "rejected", reason: "invalid_plan", nextAction: "revise_plan" },
              });
              controller.enqueue({ type: "text-start", id: "provider-text" });
              controller.enqueue({ type: "text-delta", id: "provider-text", delta: "Please clarify the requested data." });
              controller.enqueue({ type: "text-end", id: "provider-text" });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-semantic-rejection",
        trigger: "submit-message",
        messages: [{ id: "user-semantic-rejection", role: "user", parts: [{ type: "text", text: "Check orders" }] }],
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"type":"tool-output-available"');
    expect(body).toContain('"status":"blocked"');
    expect(body).not.toContain('"type":"tool-output-error"');
    expect(body).not.toContain("invalid_plan");
    expect(body).not.toContain("revise_plan");
  });

  test("logs redacted API and stream lifecycle metadata without chat content", async () => {
    const info: StudioLogEvent[] = [];
    const errors: StudioLogEvent[] = [];
    const app = createStudioApp({
      connector: createConnector(),
      logger: {
        info(event) { info.push(event); },
        error(event) { errors.push(event); },
      },
      agent: {
        async run() {
          return { status: "completed", message: "Analysis complete." };
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-1",
        threadId: "thread-1",
        trigger: "submit-message",
        messages: [{
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "secret-user-prompt-do-not-log" }],
        }],
      }),
    }));
    await response.text();

    expect(info).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "request", stage: "received", method: "POST", operation: "chat" }),
      expect.objectContaining({ event: "agent", stage: "catalog_started", operation: "chat" }),
      expect.objectContaining({ event: "agent", stage: "catalog_completed", operation: "chat" }),
      expect.objectContaining({ event: "stream", stage: "started", operation: "chat" }),
      expect.objectContaining({ event: "stream", stage: "first_event", operation: "chat" }),
      expect.objectContaining({ event: "stream", stage: "completed", status: 200, outcome: "completed" }),
    ]));
    expect(errors).toEqual([]);

    const requestId = info[0]?.requestId;
    const runIds = [...new Set(info.flatMap((event) => event.runId === undefined ? [] : [event.runId]))];
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(info.every((event) => event.requestId === requestId)).toBe(true);
    expect(runIds).toHaveLength(1);
    expect(runIds[0]).toMatch(/^[a-f0-9-]{36}$/);

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("secret-user-prompt-do-not-log");
    expect(serialized).not.toContain("connector-secret");
    expect(serialized).not.toContain("catalog-secret");
    expect(serialized).not.toContain("warehouse");
    expect(serialized).not.toContain("thread-1");
  });

  test("logs a failed chat stream without exposing the model error", async () => {
    const info: StudioLogEvent[] = [];
    const errors: StudioLogEvent[] = [];
    const app = createStudioApp({
      connector: createConnector(),
      logger: {
        info(event) { info.push(event); },
        error(event) { errors.push(event); },
      },
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        async stream() {
          throw new Error("model-provider-secret-do-not-log");
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-1",
        threadId: "thread-1",
        trigger: "submit-message",
        messages: [{
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Check orders" }],
        }],
      }),
    }));
    await response.text();

    expect(info).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "request", stage: "received", operation: "chat" }),
      expect.objectContaining({ event: "agent", stage: "catalog_completed", operation: "chat" }),
      expect.objectContaining({ event: "stream", stage: "first_event", operation: "chat" }),
    ]));
    expect(errors).toEqual([expect.objectContaining({
      event: "stream",
      stage: "failed",
      method: "POST",
      operation: "chat",
      status: 200,
      outcome: "failed",
    })]);
    expect(JSON.stringify(errors)).not.toContain("model-provider-secret-do-not-log");
  });

  test("logs public Agent stage events with the server-owned run correlation", async () => {
    const info: StudioLogEvent[] = [];
    const app = createStudioApp({
      connector: createConnector(),
      logger: {
        info(event) { info.push(event); },
        error() {},
      },
      agent: {
        async run() {
          return { status: "completed", message: "Unused fallback." };
        },
        streamUI() {
          return new ReadableStream<TesseraUIMessageChunk>({
            start(controller) {
              controller.enqueue({ type: "start", messageId: "message-1" });
              controller.enqueue({
                type: "data-tessera-stage",
                id: "stage-1",
                data: { runId: "source-run-id-do-not-log", stage: "planning", status: "started" },
              });
              controller.enqueue({
                type: "data-tessera-stage",
                id: "stage-1",
                data: { runId: "source-run-id-do-not-log", stage: "planning", status: "completed" },
              });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
      },
    });

    const response = await app.fetch(request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "chat-1",
        trigger: "submit-message",
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Plan an analysis" }] }],
      }),
    }));
    await response.text();

    expect(info).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "agent",
        stage: "analysis_stage",
        agentStage: "planning",
        agentStageStatus: "started",
      }),
      expect.objectContaining({
        event: "agent",
        stage: "analysis_stage",
        agentStage: "planning",
        agentStageStatus: "completed",
      }),
    ]));
    const runIds = [...new Set(info.flatMap((event) => event.runId === undefined ? [] : [event.runId]))];
    expect(runIds).toHaveLength(1);
    expect(JSON.stringify(info)).not.toContain("source-run-id-do-not-log");
  });

  test("redacts connector and Agent failures", async () => {
    const unavailable = createStudioApp({
      connector: createConnector({
        assess: async () => { throw new Error("postgresql://readonly:connection-secret@localhost/warehouse"); },
      }),
    });
    const connection = await unavailable.fetch(request("/api/connection"));
    const connectionText = await connection.text();
    expect(connection.status).toBe(503);
    expect(connectionText).not.toContain("connection-secret");

    const agentFailure = createStudioApp({
      connector: createConnector(),
      agent: { async run() { throw new Error("openrouter-key-super-secret"); } },
    });
    const run = await agentFailure.fetch(request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Run an analysis." }),
    }));
    const runText = await run.text();
    expect(run.status).toBe(502);
    expect(runText).not.toContain("openrouter-key-super-secret");
  });
});

describe("Tessera database connector selection", () => {
  test("selects the configured PostgreSQL or MySQL connector without connecting during construction", async () => {
    const postgres = createTesseraDatabaseConnector(defineTesseraConfig({
      database: { url: "postgresql://readonly:secret@localhost/warehouse" },
    }));
    const mysql = createTesseraDatabaseConnector(defineTesseraConfig({
      database: { url: "mysql://readonly:secret@localhost/warehouse" },
    }));

    try {
      expect(postgres.dialect).toBe("postgres");
      expect(mysql.dialect).toBe("mysql");
    } finally {
      await Promise.all([postgres.close(), mysql.close()]);
    }
  });
});

describe("Studio Catalog cache", () => {
  test("coalesces concurrent scans, reuses fresh values, and allows explicit refresh", async () => {
    let scans = 0;
    const connector = createConnector({
      introspect: async () => {
        scans += 1;
        return catalog;
      },
    });
    const provider = createStudioCatalogProvider(connector, { ttlMs: 60_000 });

    await Promise.all([provider.get(), provider.get()]);
    expect(scans).toBe(1);
    await provider.get();
    expect(scans).toBe(1);
    await provider.get({ refresh: true });
    expect(scans).toBe(2);
  });
});
