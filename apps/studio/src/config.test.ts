import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  DEFAULT_TESSERA_STUDIO_HOST,
  DEFAULT_TESSERA_STUDIO_PORT,
  DEFAULT_TESSERA_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_TESSERA_LLM_MAX_RETRIES,
  DEFAULT_TESSERA_LLM_MAX_STEPS,
  DEFAULT_TESSERA_LLM_MODEL,
  DEFAULT_TESSERA_LLM_REASONING_EFFORT,
  DEFAULT_TESSERA_LLM_TEMPERATURE,
  TESSERA_AGENT_MODEL,
  TESSERA_CONFIG_FILE,
  TesseraConfigError,
  createTesseraConfigFromDatabaseUrl,
  defineTesseraConfig,
  inferTesseraDatabaseDialect,
  isTesseraLlmConfigured,
  loadTesseraEnvironment,
  loadTesseraConfig,
  resolveTesseraLlmConfig,
  withTesseraDatabaseUrl,
  withTesseraStudioOverrides,
} from "./config";
import { parseStudioCommandLine, resolveStudioConfig } from "./main";

const database = { dialect: "postgres" as const, url: "postgresql://readonly:secret@localhost/warehouse" };

describe("Tessera configuration", () => {
  test("uses a local listener and a server-side OpenRouter fallback by default", () => {
    const config = defineTesseraConfig({ database });

    expect(config.database.schemas).toBeUndefined();
    expect(config.database.permissions).toMatchObject({
      policyId: "database",
      policyVersion: "1",
      profile: "normal",
      sqlStatements: {
        read: "allow",
        write: "ask",
        destructive: "ask",
        unknown: "ask",
      },
    });
    expect(config.studio).toEqual({
      host: DEFAULT_TESSERA_STUDIO_HOST,
      port: DEFAULT_TESSERA_STUDIO_PORT,
      allowRemote: false,
      requireAuthentication: false,
      allowedOrigins: [],
      catalogCacheTtlMs: 60_000,
    });
    expect(TESSERA_AGENT_MODEL).toBe(DEFAULT_TESSERA_LLM_MODEL);
    expect(resolveTesseraLlmConfig(config)).toEqual({
      model: DEFAULT_TESSERA_LLM_MODEL,
      headers: {},
      reasoningEffort: DEFAULT_TESSERA_LLM_REASONING_EFFORT,
      temperature: DEFAULT_TESSERA_LLM_TEMPERATURE,
      maxOutputTokens: DEFAULT_TESSERA_LLM_MAX_OUTPUT_TOKENS,
      maxSteps: DEFAULT_TESSERA_LLM_MAX_STEPS,
      maxRetries: DEFAULT_TESSERA_LLM_MAX_RETRIES,
    });
  });

  test("requires enough Agent steps to complete tool execution and narration", () => {
    expect(() => defineTesseraConfig({
      database,
      llm: {
        model: "openrouter/deepseek/deepseek-v4-pro-0813",
        maxSteps: 2,
      },
    })).toThrow(TesseraConfigError);

    const config = defineTesseraConfig({
      database,
      llm: {
        model: "openrouter/deepseek/deepseek-v4-pro-0813",
        maxSteps: 3,
      },
    });
    expect(config.llm?.maxSteps).toBe(3);
  });

  test("uses every schema visible to the configured database credential unless explicitly narrowed", () => {
    const allAccessible = defineTesseraConfig({ database });
    const narrowed = defineTesseraConfig({
      database: { ...database, schemas: ["analytics", "reporting"] },
    });

    expect(allAccessible.database.schemas).toBeUndefined();
    expect(narrowed.database.schemas).toEqual(["analytics", "reporting"]);
  });

  test("resolves Datus-style database permission profiles and class overrides server-side", () => {
    const config = defineTesseraConfig({
      database: {
        ...database,
        permissions: {
          profile: "auto",
          sqlStatements: { destructive: "deny" },
        },
      },
    });

    expect(config.database.permissions).toMatchObject({
      policyId: "database",
      policyVersion: "1",
      profile: "auto",
      sqlStatements: {
        read: "allow",
        write: "allow",
        destructive: "deny",
        unknown: "ask",
      },
    });
    expect(config.database.permissions.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("preserves an optional semantic manifest without changing database visibility", () => {
    const config = defineTesseraConfig({
      database,
      semantic: {
        manifestId: "business",
        revision: "2",
        entities: [{
          relation: { schema: "analytics", table: "user_details" },
          label: "用户",
          aliases: ["users"],
          defaultTimeColumn: "created_at",
          fields: [{ column: "created_at", label: "创建时间" }],
        }],
      },
    });

    expect(config.semantic).toMatchObject({
      manifestId: "business",
      revision: "2",
      entities: [{
        relation: { schema: "analytics", table: "user_details" },
        label: "用户",
        defaultTimeColumn: "created_at",
      }],
    });
    expect(config.database.schemas).toBeUndefined();
  });

  test("normalizes an explicit provider or OpenAI-compatible LLM without exposing it through Studio", () => {
    const config = defineTesseraConfig({
      database,
      llm: {
        model: "anthropic/claude-sonnet-4-6",
        apiKey: "server-only-test-key",
        baseUrl: "https://gateway.example.test/v1/",
        headers: { "X-Tenant-Route": "analytics" },
        reasoningEffort: "high",
        temperature: 0.2,
        maxOutputTokens: 1_200,
        maxSteps: 5,
        maxRetries: 1,
      },
    });

    expect(config.llm).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      apiKey: "server-only-test-key",
      baseUrl: "https://gateway.example.test/v1",
      headers: { "X-Tenant-Route": "analytics" },
      reasoningEffort: "high",
      temperature: 0.2,
      maxOutputTokens: 1_200,
      maxSteps: 5,
      maxRetries: 1,
    });
    expect(isTesseraLlmConfigured(config)).toBe(true);
  });

  test("rejects accidental remote exposure and validates CLI overrides through the same policy", () => {
    expect(() => defineTesseraConfig({ database, studio: { host: "0.0.0.0" } })).toThrow(TesseraConfigError);

    const local = defineTesseraConfig({ database });
    expect(() => withTesseraStudioOverrides(local, { host: "0.0.0.0" })).toThrow(TesseraConfigError);

    const remote = defineTesseraConfig({
      database,
      studio: {
        host: "0.0.0.0",
        allowRemote: true,
        allowedOrigins: ["https://studio.example.test"],
      },
    });
    expect(remote.studio.allowedOrigins).toEqual(["https://studio.example.test"]);
    expect(remote.studio.requireAuthentication).toBe(true);
    expect(() => defineTesseraConfig({
      database,
      studio: {
        host: "0.0.0.0",
        allowRemote: true,
        requireAuthentication: false,
        allowedOrigins: ["https://studio.example.test"],
      },
    })).toThrow("studio.requireAuthentication");
  });

  test("loads the conventional tessera.config.ts file without exposing its database value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessera-config-"));
    const nestedDirectory = join(directory, "apps", "studio");
    try {
      await mkdir(nestedDirectory, { recursive: true });
      await Bun.write(join(directory, TESSERA_CONFIG_FILE), [
        "export default {",
        '  database: { dialect: "postgres", url: "postgresql://readonly:loader-secret@localhost/warehouse" },',
        "};",
      ].join("\n"));

      const loaded = await loadTesseraConfig({ cwd: nestedDirectory });

      expect(loaded.path).toBe(join(directory, TESSERA_CONFIG_FILE));
      expect(loaded.config.database.dialect).toBe("postgres");
      expect(loaded.config.studio.host).toBe(DEFAULT_TESSERA_STUDIO_HOST);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("discovers a parent .env without overriding deployment environment variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessera-env-"));
    const nestedDirectory = join(directory, "apps", "studio");
    const environment: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: "provided-by-host",
    };
    try {
      await mkdir(nestedDirectory, { recursive: true });
      await Bun.write(join(directory, ".env"), [
        "DATABASE_URL=postgresql://readonly:env-loader-secret@localhost/warehouse",
        "OPENROUTER_API_KEY=from-dotenv",
      ].join("\n"));

      const loaded = await loadTesseraEnvironment({ cwd: nestedDirectory, environment });

      expect(loaded.path).toBe(join(directory, ".env"));
      expect(environment.DATABASE_URL).toBe("postgresql://readonly:env-loader-secret@localhost/warehouse");
      expect(environment.OPENROUTER_API_KEY).toBe("provided-by-host");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("infers PostgreSQL and MySQL from a URL while rejecting explicit dialect conflicts", () => {
    expect(inferTesseraDatabaseDialect("postgres://readonly:secret@localhost/warehouse")).toBe("postgres");
    expect(inferTesseraDatabaseDialect("mysql://readonly:secret@localhost/warehouse")).toBe("mysql");
    expect(() => defineTesseraConfig({
      database: { dialect: "postgres", url: "mysql://readonly:secret@localhost/warehouse" },
    })).toThrow("does not match");
    expect(() => inferTesseraDatabaseDialect("sqlite:///tmp/warehouse.db"))
      .toThrow("PostgreSQL and MySQL");
  });

  test("creates an isolated URL config and keeps a project dialect guard when a URL overrides it", () => {
    const direct = createTesseraConfigFromDatabaseUrl("mysql://readonly:secret@localhost/warehouse");
    expect(direct.database.dialect).toBe("mysql");

    const inferredProjectDialect = defineTesseraConfig({
      database: { url: "postgresql://readonly:secret@localhost/warehouse" },
    });
    expect(withTesseraDatabaseUrl(inferredProjectDialect, "mysql://readonly:temporary@localhost/warehouse").database.dialect)
      .toBe("mysql");

    const configured = defineTesseraConfig({ database });
    expect(withTesseraDatabaseUrl(configured, "postgres://readonly:temporary@localhost/warehouse").database.url)
      .toBe("postgres://readonly:temporary@localhost/warehouse");
    expect(() => withTesseraDatabaseUrl(configured, "mysql://readonly:temporary@localhost/warehouse"))
      .toThrow("does not match");
  });
});

describe("Tessera Studio command line", () => {
  test("accepts a single positional PostgreSQL or MySQL URL plus safe listen overrides", async () => {
    expect(parseStudioCommandLine([
      "--config",
      "/work/project/tessera.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      "4400",
    ])).toEqual({
      config: { file: "/work/project/tessera.config.ts" },
      overrides: { host: "127.0.0.1", port: 4400 },
    });
    expect(parseStudioCommandLine(["mysql://readonly:secret@localhost/warehouse"])).toEqual({
      config: {},
      overrides: {},
      databaseUrl: "mysql://readonly:secret@localhost/warehouse",
    });
    const direct = await resolveStudioConfig(parseStudioCommandLine([
      "postgresql://readonly:secret@localhost/warehouse",
    ]));
    expect(direct.database.dialect).toBe("postgres");
    expect(() => parseStudioCommandLine(["postgresql://secret@localhost/one", "mysql://secret@localhost/two"])).toThrow(TesseraConfigError);
    expect(() => parseStudioCommandLine(["--demo"])).toThrow("unsupported command-line option");
    expect(() => parseStudioCommandLine(["--database-url", "postgresql://secret"])).toThrow(TesseraConfigError);
    expect(() => parseStudioCommandLine(["--port", "0"])).toThrow(TesseraConfigError);
  });
});
