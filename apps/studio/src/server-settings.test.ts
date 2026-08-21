import { describe, expect, test } from "bun:test";
import { createDataAgent } from "@data-elements/data-agent";
import {
  finalizeCatalog,
  type ConnectionAssessment,
  type DatabaseConnector,
} from "@data-elements/database";
import { defineTesseraConfig } from "./config";
import type { TesseraUIMessageChunk } from "./protocol";
import {
  createStudioApp,
  type StudioAgent,
  type StudioAppDependencies,
  type StudioSettingsChangeKind,
} from "./server";
import {
  createTesseraStudioRuntimeManager,
  type TesseraStudioRuntimeFactory,
  type TesseraStudioSettingsCandidate,
} from "./settings-runtime";
import type { OpenRouterModelCatalogProvider } from "./openrouter-model-catalog";

const DATABASE_SECRET = "runtime-database-secret";
const PROVIDER_SECRET = "runtime-provider-secret";
const IDENTITY = { subject: "alice", tenantId: "tenant-a", roles: ["operator"] } as const;
const ADMIN_IDENTITY = { subject: "admin", tenantId: "tenant-a", roles: ["admin"] } as const;

const baseConfig = defineTesseraConfig({
  database: {
    dialect: "postgres",
    url: `postgresql://readonly:${DATABASE_SECRET}@localhost/warehouse`,
    maxRows: 500,
    statementTimeoutMs: 15_000,
  },
  llm: {
    model: "openrouter/deepseek/deepseek-v4-pro-0813",
    apiKey: PROVIDER_SECRET,
    maxSteps: 4,
  },
});

type RuntimeTracker = {
  builds: Array<{ dialect: "postgres" | "mysql" | "sqlite" | "turso" | "mongodb"; closeCalls: number }>;
};

const modelCatalog: OpenRouterModelCatalogProvider = {
  async list() {
    return {
      models: [
        {
          id: "deepseek/deepseek-v4-pro-0813",
          name: "DeepSeek: DeepSeek V4 Pro 0813",
          family: "DeepSeek",
          reasoning: {
            supportedEfforts: ["max", "high", "low"],
            defaultEffort: "high",
            defaultEnabled: false,
            mandatory: false,
          },
        },
        {
          id: "qwen/qwen3.8-2.4t-a95b",
          name: "Qwen: Qwen3.8 2.4T A95B",
          family: "Qwen",
          reasoning: {
            supportedEfforts: ["xhigh", "medium", "low"],
            defaultEffort: "xhigh",
            defaultEnabled: true,
            mandatory: true,
          },
        },
      ],
    };
  },
  async getReasoning(model) {
    if (model !== "deepseek/deepseek-v4-pro-0813") return undefined;
    return {
      supportedEfforts: ["max", "high", "low"],
      defaultEffort: "high",
      defaultEnabled: false,
      mandatory: false,
    };
  },
};

type SettingsCandidateOverrides = {
  database?: Partial<TesseraStudioSettingsCandidate["database"]>;
  llm?: Partial<TesseraStudioSettingsCandidate["llm"]>;
  limits?: Partial<TesseraStudioSettingsCandidate["limits"]>;
};

function settingsCandidate(overrides: SettingsCandidateOverrides = {}): TesseraStudioSettingsCandidate {
  const { reasoningEffort = "default", ...llmOverrides } = overrides.llm ?? {};
  return {
    database: {
      dialect: "postgres",
      accessMode: "read-only",
      ...(overrides.database ?? {}),
    },
    llm: {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro-0813",
      reasoningEffort,
      ...llmOverrides,
    },
    limits: {
      maxRows: 500,
      timeoutMs: 15_000,
      maxSteps: 4,
      ...(overrides.limits ?? {}),
    },
  };
}

function createRuntimeFactory(tracker: RuntimeTracker): TesseraStudioRuntimeFactory {
  return {
    async create(config) {
      const record = { dialect: config.database.dialect, closeCalls: 0 };
      tracker.builds.push(record);
      const connector = createConnector(config.database.dialect);
      const agent: StudioAgent = {
        catalogLoading: "data-agent",
        async run() {
          return { status: "needs_input", message: "Ready." };
        },
        streamUI(input) {
          return sourceStream(input.runId);
        },
      };
      return {
        connector,
        dataAgent: createDataAgent({ connector }),
        agent,
        async close() {
          record.closeCalls += 1;
          await connector.close();
        },
      };
    },
  };
}

function createConnector(dialect: "postgres" | "mysql" | "sqlite" | "turso" | "mongodb"): DatabaseConnector {
  const catalog = finalizeCatalog({
    connectorId: `${dialect}:private-connector-id`,
    dialect,
    databaseName: dialect === "postgres" ? "warehouse" : dialect === "mysql" ? "analytics" : "documents",
    scannedAt: "2026-08-16T00:00:00.000Z",
    schemas: [],
  });
  return {
    id: `${dialect}:private-connector-id`,
    dialect,
    async assess(): Promise<ConnectionAssessment> {
      return {
        connectorId: `${dialect}:private-connector-id`,
        dialect,
        connected: true,
        databaseName: dialect === "postgres" ? "warehouse" : "analytics",
        host: "private-host.internal",
        readOnlyTransactions: true,
        credentialCanWrite: false,
        latencyMs: 2,
        warnings: ["private diagnostic"],
      };
    },
    async introspect() {
      return catalog;
    },
    async query() {
      return {
        queryId: "private-query-id",
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs: 1,
      };
    },
    async close() {},
  };
}

function sourceStream(runId: string): ReadableStream<TesseraUIMessageChunk> {
  return new ReadableStream<TesseraUIMessageChunk>({
    start(controller) {
      controller.enqueue({ type: "start", messageId: `message-${runId}` });
      controller.enqueue({ type: "text-start", id: `text-${runId}` });
      controller.enqueue({ type: "text-delta", id: `text-${runId}`, delta: "The analysis is ready." });
      controller.enqueue({ type: "text-end", id: `text-${runId}` });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1:4317${path}`, init);
}

function jsonRequest(path: string, method: "POST" | "PUT", body: unknown): Request {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type ManagedAppOptions = Pick<StudioAppDependencies,
  "authenticate" | "requireAuthentication" | "authorizeSettingsChange"
>;

async function createManagedApp(options: ManagedAppOptions = {}) {
  const tracker: RuntimeTracker = { builds: [] };
  const manager = await createTesseraStudioRuntimeManager({
    config: baseConfig,
    factory: createRuntimeFactory(tracker),
  });
  return {
    app: createStudioApp({
      connector: createConnector("postgres"),
      settingsRuntime: manager,
      modelCatalog,
      ...options,
    }),
    manager,
    tracker,
  };
}

describe("Tessera Studio Settings routes", () => {
  test("returns redacted settings and test results without credentials or database URLs", async () => {
    const { app, manager } = await createManagedApp();
    try {
      const getResponse = await app.fetch(request("/api/settings"));
      const getBody = await getResponse.text();
      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get("Cache-Control")).toBe("no-store, max-age=0");
      expect(JSON.parse(getBody)).toMatchObject({
        settings: {
          database: { urlConfigured: true },
          llm: { apiKeyConfigured: true },
        },
      });
      expect(getBody).not.toContain(DATABASE_SECRET);
      expect(getBody).not.toContain(PROVIDER_SECRET);

      const testResponse = await app.fetch(jsonRequest("/api/settings/test", "POST", settingsCandidate({
        database: {
          dialect: "mysql",
          accessMode: "read-write",
          url: "mysql://readonly:replacement-database-secret@localhost/analytics",
        },
        llm: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-pro-0813",
          apiKey: "replacement-provider-secret",
        },
      })));
      const testBody = await testResponse.text();
      expect(testResponse.status).toBe(200);
      expect(testBody).toContain("Database connection verified.");
      expect(testBody).not.toContain("replacement-database-secret");
      expect(testBody).not.toContain("replacement-provider-secret");
      expect(testBody).not.toContain("private-connector-id");
      expect(testBody).not.toContain("private-host.internal");
      expect(testBody).not.toContain("private diagnostic");
    } finally {
      await manager.close();
    }
  });

  test("requires explicit host authorization for authenticated Settings changes", async () => {
    const { app, manager, tracker } = await createManagedApp({
      authenticate: () => IDENTITY,
      requireAuthentication: true,
    });
    try {
      const mode = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: { accessMode: "read-write" },
      })));
      expect(mode.status).toBe(403);
      expect(await mode.json()).toMatchObject({ error: { code: "settings_change_denied" } });

      const permission = await app.fetch(jsonRequest("/api/settings/permissions", "PUT", {
        profile: "normal",
        sqlStatements: { read: "allow", write: "ask", destructive: "ask", unknown: "deny" },
      }));
      expect(permission.status).toBe(403);

      const connectionTest = await app.fetch(jsonRequest("/api/settings/test", "POST", settingsCandidate()));
      expect(connectionTest.status).toBe(403);
      expect(tracker.builds).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test("denies anonymous and host-rejected Settings mutations", async () => {
    const anonymous = await createManagedApp({ authenticate: () => undefined });
    try {
      const response = await anonymous.app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: { accessMode: "read-write" },
      })));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "settings_change_denied" } });
    } finally {
      await anonymous.manager.close();
    }

    const rejected = await createManagedApp({
      authenticate: () => IDENTITY,
      requireAuthentication: true,
      authorizeSettingsChange: () => false,
    });
    try {
      const response = await rejected.app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: { accessMode: "read-write" },
      })));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "settings_change_denied" } });
    } finally {
      await rejected.manager.close();
    }
  });

  test("passes the exact sensitive Settings operation to the host administrator policy", async () => {
    const authorized: StudioSettingsChangeKind[] = [];
    const { app, manager } = await createManagedApp({
      authenticate: () => ADMIN_IDENTITY,
      requireAuthentication: true,
      authorizeSettingsChange: ({ identity, kind }) => {
        authorized.push(kind);
        return identity.roles?.includes("admin") === true;
      },
    });
    try {
      const mode = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: { accessMode: "read-write" },
      })));
      expect(mode.status).toBe(200);

      const permission = await app.fetch(jsonRequest("/api/settings/permissions", "PUT", {
        profile: "normal",
        sqlStatements: { read: "allow", write: "ask", destructive: "ask", unknown: "deny" },
      }));
      expect(permission.status).toBe(200);

      const connectionTest = await app.fetch(jsonRequest("/api/settings/test", "POST", settingsCandidate()));
      expect(connectionTest.status).toBe(200);
      expect(authorized).toEqual(["access-mode", "database-permissions", "test"]);
    } finally {
      await manager.close();
    }
  });

  test("does not accept database permissions through the general Settings save route", async () => {
    const authorized: StudioSettingsChangeKind[] = [];
    const { app, manager, tracker } = await createManagedApp({
      authenticate: () => IDENTITY,
      requireAuthentication: true,
      authorizeSettingsChange: ({ identity, kind }) => {
        authorized.push(kind);
        return identity.roles?.includes("operator") === true && kind === "settings";
      },
    });
    try {
      const response = await app.fetch(jsonRequest("/api/settings", "PUT", {
        ...settingsCandidate(),
        permissions: {
          profile: "dangerous",
          sqlStatements: { read: "allow", write: "allow", destructive: "allow", unknown: "allow" },
        },
      }));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_settings" } });
      expect(authorized).toEqual([]);
      expect(tracker.builds).toHaveLength(1);
    } finally {
      await manager.close();
    }
  });

  test("returns a small OpenRouter picker and rejects unsupported reasoning efforts", async () => {
    const { app, manager, tracker } = await createManagedApp();
    try {
      const catalogResponse = await app.fetch(request("/api/settings/models"));
      const catalogBody = await catalogResponse.text();
      expect(catalogResponse.status).toBe(200);
      expect(JSON.parse(catalogBody)).toEqual({
        models: expect.arrayContaining([
          expect.objectContaining({
            id: "deepseek/deepseek-v4-pro-0813",
            reasoning: expect.objectContaining({ supportedEfforts: ["max", "high", "low"] }),
          }),
          expect.objectContaining({
            id: "qwen/qwen3.8-2.4t-a95b",
            reasoning: expect.objectContaining({ mandatory: true }),
          }),
        ]),
      });
      expect(catalogBody).not.toContain(DATABASE_SECRET);
      expect(catalogBody).not.toContain(PROVIDER_SECRET);

      const validResponse = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        llm: { reasoningEffort: "low" },
      })));
      expect(validResponse.status).toBe(200);
      expect(await validResponse.json()).toMatchObject({
        settings: { llm: { reasoningEffort: "low" } },
      });
      expect(tracker.builds).toHaveLength(2);

      const invalidResponse = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        llm: { reasoningEffort: "xhigh" },
      })));
      expect(invalidResponse.status).toBe(400);
      expect(await invalidResponse.json()).toMatchObject({ error: { code: "invalid_settings" } });
      expect(tracker.builds).toHaveLength(2);
    } finally {
      await manager.close();
    }
  });

  test("replaces the active route runtime only after a valid settings save", async () => {
    const { app, manager } = await createManagedApp();
    try {
      const saveResponse = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: {
          dialect: "mysql",
          accessMode: "read-write",
          url: "mysql://readonly:replacement-database-secret@localhost/analytics",
        },
        limits: { maxRows: 120, timeoutMs: 8_000, maxSteps: 5 },
      })));
      const saveBody = await saveResponse.text();
      expect(saveResponse.status).toBe(200);
      expect(saveBody).toContain("Settings saved.");
      expect(saveBody).not.toContain("replacement-database-secret");

      const connectionResponse = await app.fetch(request("/api/connection"));
      expect(connectionResponse.status).toBe(200);
      expect(await connectionResponse.json()).toMatchObject({
        connection: { dialect: "mysql", databaseName: "analytics" },
      });

      const invalidResponse = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: {
          dialect: "postgres",
          accessMode: "read-only",
          url: "mysql://readonly:invalid-settings-secret@localhost/analytics",
        },
      })));
      const invalidBody = await invalidResponse.text();
      expect(invalidResponse.status).toBe(400);
      expect(invalidBody).toContain("invalid_settings");
      expect(invalidBody).not.toContain("invalid-settings-secret");
    } finally {
      await manager.close();
    }
  });

  test("holds a leased Agent runtime until a chat stream is consumed", async () => {
    const { app, manager, tracker } = await createManagedApp();
    try {
      const chat = await app.fetch(jsonRequest("/api/chat", "POST", {
        id: "chat-request-1",
        messages: [{
          id: "user-message-1",
          role: "user",
          parts: [{ type: "text", text: "Summarize sales." }],
        }],
      }));
      expect(chat.status).toBe(200);

      const saveResponse = await app.fetch(jsonRequest("/api/settings", "PUT", settingsCandidate({
        database: {
          dialect: "mysql",
          accessMode: "read-only",
          url: "mysql://readonly:next-generation-secret@localhost/analytics",
        },
      })));
      expect(saveResponse.status).toBe(200);
      expect(tracker.builds).toHaveLength(2);
      expect(tracker.builds[0]?.closeCalls).toBe(0);

      await chat.text();
      expect(tracker.builds[0]?.closeCalls).toBe(1);
    } finally {
      await manager.close();
    }
  });
});
