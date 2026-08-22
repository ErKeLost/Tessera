import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDataAgent } from "@open-tessera/data-agent";
import {
  finalizeCatalog,
  type ConnectionAssessment,
  type DatabaseConnector,
} from "@open-tessera/database";
import { defineTesseraConfig } from "./config";
import {
  TesseraSettingsRuntimeError,
  createTesseraLocalSettingsStore,
  createTesseraStudioRuntimeManager,
  createTesseraStudioSettingsSnapshot,
  normalizeTesseraStudioSettings,
  type TesseraStudioRuntimeFactory,
  type TesseraStudioSettingsCandidate,
} from "./settings-runtime";
import type { TesseraDatabaseActionService } from "./database-actions";

const baseConfig = defineTesseraConfig({
  database: {
    dialect: "postgres",
    url: "postgresql://readonly:baseline-database-secret@localhost/warehouse",
    maxRows: 500,
    statementTimeoutMs: 15_000,
  },
  llm: {
    model: "openrouter/deepseek/deepseek-v4-pro-0813",
    apiKey: "baseline-provider-secret",
    maxSteps: 4,
  },
});

type SettingsCandidateOverrides = {
  database?: Partial<TesseraStudioSettingsCandidate["database"]>;
  llm?: Partial<TesseraStudioSettingsCandidate["llm"]>;
  limits?: Partial<TesseraStudioSettingsCandidate["limits"]>;
};

function candidate(overrides: SettingsCandidateOverrides = {}): TesseraStudioSettingsCandidate {
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

type BuildTracker = {
  closed: number;
  records: Array<{ generationUrl: string; closeCalls: number }>;
};

function createFactory(
  tracker: BuildTracker,
  connected: (url: string) => boolean = () => true,
): TesseraStudioRuntimeFactory {
  return {
    async create(config) {
      const record = { generationUrl: config.database.url, closeCalls: 0 };
      tracker.records.push(record);
      const connector = createFakeConnector(config.database.dialect, config.database.url, connected(config.database.url));
      return {
        connector,
        dataAgent: createDataAgent({ connector }),
        async close() {
          record.closeCalls += 1;
          tracker.closed += 1;
          await connector.close();
        },
      };
    },
  };
}

function createFakeConnector(
  dialect: "postgres" | "mysql" | "sqlite" | "turso" | "mongodb",
  databaseUrl: string,
  connected: boolean,
): DatabaseConnector {
  const catalog = finalizeCatalog({
    connectorId: `${dialect}:test`,
    dialect,
    databaseName: "warehouse",
    scannedAt: "2026-08-16T00:00:00.000Z",
    schemas: [],
  });
  return {
    id: `${dialect}:test`,
    dialect,
    async assess(): Promise<ConnectionAssessment> {
      return {
        connectorId: `${dialect}:private-connector-id`,
        dialect,
        connected,
        ...(connected ? { databaseName: "warehouse" } : {}),
        host: new URL(databaseUrl).hostname,
        readOnlyTransactions: true,
        credentialCanWrite: false,
        latencyMs: 3,
        warnings: ["private connection diagnostic"],
      };
    },
    async introspect() {
      return catalog;
    },
    async query() {
      return {
        queryId: "query-id",
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

describe("Tessera Studio settings runtime", () => {
  test("does not publish database mutations from a read-only generation", async () => {
    const manager = await createTesseraStudioRuntimeManager({
      config: baseConfig,
      factory: {
        async create(config) {
          const connector = createFakeConnector(config.database.dialect, config.database.url, true);
          return {
            connector,
            dataAgent: createDataAgent({ connector }),
            // The injected factory deliberately returns a marker service so
            // the manager's read-only stripping invariant is exercised.
            databaseActions: {} as TesseraDatabaseActionService,
            async close() {},
          };
        },
      },
    });

    try {
      const lease = manager.acquire();
      expect(lease.runtime.accessMode).toBe("read-only");
      expect(lease.runtime.databaseActions).toBeUndefined();
      await lease.release();

      await manager.replace(candidate({
        database: { accessMode: "read-write" },
      }));
      const writableLease = manager.acquire();
      expect(writableLease.runtime.databaseActions).toBeDefined();
      await writableLease.release();
    } finally {
      await manager.close();
    }
  });

  test("normalizes a candidate while returning a redacted settings snapshot", () => {
    const next = normalizeTesseraStudioSettings(baseConfig, candidate({
      database: {
        dialect: "mysql",
        accessMode: "read-write",
        url: "mysql://readonly:replacement-database-secret@localhost/analytics",
      },
      llm: {
        provider: "OpenRouter",
        model: "deepseek/deepseek-v4-pro-0813",
        reasoningEffort: "low",
        apiKey: "replacement-provider-secret",
        baseUrl: "https://gateway.example.test/v1/",
      },
      limits: { maxRows: 250, timeoutMs: 9_000, maxSteps: 6 },
    }));

    expect(next.config.database.dialect).toBe("mysql");
    expect(next.config.database.maxRows).toBe(250);
    expect(next.config.llm?.model).toBe("openrouter/deepseek/deepseek-v4-pro-0813");
    expect(next.config.llm?.baseUrl).toBe("https://gateway.example.test/v1");
    expect(next.config.llm?.reasoningEffort).toBe("low");
    expect(next.accessMode).toBe("read-write");

    const publicJson = JSON.stringify(createTesseraStudioSettingsSnapshot(next.config, next.accessMode));
    expect(publicJson).not.toContain("replacement-database-secret");
    expect(publicJson).not.toContain("replacement-provider-secret");
    expect(publicJson).not.toContain("baseline-database-secret");
    expect(publicJson).toContain("gateway.example.test");
    expect(publicJson).toContain('"reasoningEffort":"low"');
    expect(createTesseraStudioSettingsSnapshot(next.config, next.accessMode).llm.apiKeySource).toBe("explicit");
    const providerSwitch = normalizeTesseraStudioSettings(baseConfig, candidate({
      llm: { provider: "openai", model: "gpt-5" },
    }));
    expect(providerSwitch.config.llm?.apiKey).toBeUndefined();
    expect(() => normalizeTesseraStudioSettings(baseConfig, candidate({
      database: {
        dialect: "postgres",
        accessMode: "read-only",
        url: "mysql://readonly:not-for-error-text@localhost/analytics",
      },
    }))).toThrow("does not match");
  });

  test("distinguishes environment model credentials from locally configured keys", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "environment-provider-secret";
    try {
      const config = defineTesseraConfig({
        database: {
          dialect: "postgres",
          url: "postgresql://readonly:database-secret@localhost/warehouse",
        },
        llm: {
          model: "openai/gpt-5",
          baseUrl: "https://api.openai.com/v1",
        },
      });
      const snapshot = createTesseraStudioSettingsSnapshot(config);

      expect(snapshot.llm).toMatchObject({
        apiKeyConfigured: true,
        apiKeySource: "environment",
      });
      expect(JSON.stringify(snapshot)).not.toContain("environment-provider-secret");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("keeps Turso tokens server-only and enforces read-only access", () => {
    const next = normalizeTesseraStudioSettings(baseConfig, candidate({
      database: {
        dialect: "turso",
        accessMode: "read-only",
        url: "libsql://warehouse-example.turso.io",
        authToken: "private-turso-token",
      },
    }));
    expect(next.config.database.dialect).toBe("turso");
    expect(next.config.database.authToken).toBe("private-turso-token");

    const snapshot = createTesseraStudioSettingsSnapshot(next.config, next.accessMode);
    expect(snapshot.database.authTokenConfigured).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("private-turso-token");
    expect(() => normalizeTesseraStudioSettings(baseConfig, candidate({
      database: {
        dialect: "turso",
        accessMode: "read-write",
        url: "libsql://warehouse-example.turso.io",
      },
    }))).toThrow("read-only");
  });

  test("keeps an old runtime alive until its acquired lease releases", async () => {
    const tracker: BuildTracker = { closed: 0, records: [] };
    const manager = await createTesseraStudioRuntimeManager({
      config: baseConfig,
      factory: createFactory(tracker),
    });
    const firstLease = manager.acquire();

    const snapshot = await manager.replace(candidate({
      database: {
        dialect: "mysql",
        accessMode: "read-write",
        url: "mysql://readonly:next-database-secret@localhost/analytics",
      },
      limits: { maxRows: 200, timeoutMs: 8_000, maxSteps: 5 },
    }));
    const secondLease = manager.acquire();

    expect(firstLease.runtime.generation).toBe(1);
    expect(secondLease.runtime.generation).toBe(2);
    expect(snapshot.database.dialect).toBe("mysql");
    expect(snapshot.database.accessMode).toBe("read-write");
    expect(tracker.records[0]?.closeCalls).toBe(0);

    await secondLease.release();
    expect(tracker.records[0]?.closeCalls).toBe(0);
    await firstLease.release();
    expect(tracker.records[0]?.closeCalls).toBe(1);

    await manager.close();
    expect(tracker.closed).toBe(2);
  });

  test("does not replace a healthy generation when the candidate database is disconnected", async () => {
    const tracker: BuildTracker = { closed: 0, records: [] };
    const manager = await createTesseraStudioRuntimeManager({
      config: baseConfig,
      factory: createFactory(tracker, (url) => !url.includes("unreachable")),
    });

    await expect(manager.replace(candidate({
      database: {
        dialect: "postgres",
        accessMode: "read-only",
        url: "postgresql://readonly:unreachable-database-secret@localhost/warehouse",
      },
    }))).rejects.toMatchObject({ code: "connection_unavailable" } satisfies Partial<TesseraSettingsRuntimeError>);

    await manager.withRuntime((runtime) => {
      expect(runtime.generation).toBe(1);
      expect(runtime.connector.dialect).toBe("postgres");
    });
    expect(tracker.records).toHaveLength(2);
    expect(tracker.records[0]?.closeCalls).toBe(0);
    expect(tracker.records[1]?.closeCalls).toBe(1);

    const testResult = await manager.test(candidate());
    expect(testResult.connection).toEqual({
      connected: true,
      dialect: "postgres",
      databaseName: "warehouse",
      readOnlyTransactions: true,
      credentialCanWrite: false,
      latencyMs: 3,
    });
    expect(JSON.stringify(testResult.connection)).not.toContain("private-connector-id");
    expect(JSON.stringify(testResult.connection)).not.toContain("private connection diagnostic");
    await manager.close();
  });

  test("keeps earlier local URL overrides when a later save changes only limits", async () => {
    const tracker: BuildTracker = { closed: 0, records: [] };
    const persisted: TesseraStudioSettingsCandidate[] = [];
    const store = {
      async read() {
        return undefined;
      },
      async write(value: TesseraStudioSettingsCandidate) {
        persisted.push(value);
      },
    };
    const manager = await createTesseraStudioRuntimeManager({
      config: baseConfig,
      factory: createFactory(tracker),
      store,
    });
    const selectedUrl = "mysql://readonly:local-override-secret@localhost/analytics";
    await manager.replace(candidate({
      database: { dialect: "mysql", accessMode: "read-only", url: selectedUrl },
    }));
    await manager.replace(candidate({
      database: { dialect: "mysql", accessMode: "read-only" },
      limits: { maxRows: 250, timeoutMs: 9_000, maxSteps: 5 },
    }));

    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.database.url).toBe(selectedUrl);
    await manager.close();
  });

  test("persists only in a restricted local .tessera directory", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "tessera-settings-store-"));
    try {
      const store = createTesseraLocalSettingsStore({ rootDirectory });
      const value = candidate({
        database: {
          dialect: "postgres",
          accessMode: "read-only",
          url: "postgresql://readonly:stored-database-secret@localhost/warehouse",
        },
        llm: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-pro-0813",
          apiKey: "stored-provider-secret",
        },
      });
      await store.write(value);

      const directoryStatus = await stat(join(rootDirectory, ".tessera"));
      const fileStatus = await stat(join(rootDirectory, ".tessera", "settings.json"));
      expect(directoryStatus.mode & 0o777).toBe(0o700);
      expect(fileStatus.mode & 0o777).toBe(0o600);
      expect(await store.read()).toEqual(value);
      await store.clear?.();
      expect(await store.read()).toBeUndefined();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  test("resets local overrides to the startup configuration", async () => {
    const tracker: BuildTracker = { closed: 0, records: [] };
    let cleared = 0;
    const store = {
      async read() {
        return undefined;
      },
      async write(_value: TesseraStudioSettingsCandidate) {},
      async clear() {
        cleared += 1;
      },
    };
    const manager = await createTesseraStudioRuntimeManager({
      config: baseConfig,
      factory: createFactory(tracker),
      store,
    });

    try {
      await manager.replace(candidate({
        database: {
          dialect: "mysql",
          accessMode: "read-write",
          url: "mysql://readonly:temporary-secret@localhost/analytics",
        },
      }));
      const beforeReset = manager.acquire();
      expect(beforeReset.runtime.generation).toBe(2);
      expect(beforeReset.runtime.connector.dialect).toBe("mysql");
      await beforeReset.release();

      const snapshot = await manager.reset();
      expect(cleared).toBe(1);
      expect(snapshot.database.dialect).toBe("postgres");
      expect(snapshot.database.urlConfigured).toBe(true);
      expect(snapshot.database.accessMode).toBe("read-only");
      await manager.withRuntime((runtime) => {
        expect(runtime.generation).toBe(3);
        expect(runtime.connector.dialect).toBe("postgres");
      });
    } finally {
      await manager.close();
    }
  });
});
