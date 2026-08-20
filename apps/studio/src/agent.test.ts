import { describe, expect, test } from "bun:test";
import { DataAgentError, fieldIdFor, semanticCatalogSchema, type AnalysisDraft, type DataAgent } from "@data-elements/data-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analysisToolRejection,
  buildDatabaseSchemaInventory,
  buildDatabaseSchemaContext,
  buildDataCopilotInstructions,
  compactDescribeDataForModel,
  compactInspectCurrentContextForModel,
  compactProbeDataForModel,
  createSchemaContextProcessor,
  createTesseraStudioAgent,
  DATABASE_SCHEMA_CONTEXT_LIMITS,
  formatDatabaseSchemaContext,
  inspectDatabaseSchema,
  MAX_DISCOVERY_PROBES_PER_TURN,
  modelEvidenceFromResult,
  modelAnalysisToolInputSchema,
  modelProbeDataInputSchema,
  normalizeAnalysisToolDraft,
  normalizeProbeDataInput,
  hasVisibleCopilotText,
  publicToolOutput,
  safeAssistantNarration,
  planningScopesRequireDiscovery,
  selectPlanningCapabilityScopes,
  selectPlanningCapabilityScopesForProbe,
  toPublicExecutionTraceData,
  toPublicStageData,
} from "./agent";
import type { TesseraLlmConfig } from "./config";
import type { TesseraDataAgentStage } from "./protocol";
import type { DatabaseCatalog, DatabaseQueryResult } from "@data-elements/database";
import { createTesseraSessionMemory } from "./session-memory";

function streamOnlyTestModel() {
  const calls = { stream: 0 };
  return {
    calls,
    model: {
      specificationVersion: "v2",
      provider: "tessera-test",
      modelId: "stream-only-test",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Tessera must use Agent.stream for every model turn.");
      },
      async doStream() {
        calls.stream += 1;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "text-1" });
              controller.enqueue({ type: "text-delta", id: "text-1", delta: "A streamed Tessera response." });
              controller.enqueue({ type: "text-end", id: "text-1" });
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
    } as never,
  };
}

const semanticFingerprint = `sha256:${"a".repeat(64)}`;

function planningScope(input: Readonly<{
  tokenPart: string;
  entities: unknown[];
  relationships?: unknown[];
}>) {
  return {
    capability: { token: `cap_${input.tokenPart.repeat(32)}.${"s".repeat(32)}` },
    catalog: semanticCatalogSchema.parse({
      version: "2",
      ref: {
        manifestId: "test",
        revision: "1",
        fingerprint: semanticFingerprint,
        catalogFingerprint: semanticFingerprint,
      },
      entities: input.entities,
      relationships: input.relationships ?? [],
    }),
  };
}

const userEntity = {
  id: "ent_0123456789abcdef",
  label: "Users",
  aliases: [],
  defaultTimeFieldId: "fld_1111111111111111",
  fields: [
    { id: "fld_0000000000000001", label: "User ID", aliases: [], type: "string", role: "identifier", exposure: "bounded-values" },
    { id: "fld_1111111111111111", label: "Created at", aliases: [], type: "timestamp", role: "time", exposure: "bounded-values" },
  ],
  metrics: [],
};

const operationEntity = {
  id: "ent_abcdef0123456789",
  label: "Operations",
  aliases: [],
  fields: [
    { id: "fld_0000000000000002", label: "User ID", aliases: [], type: "string", role: "identifier", exposure: "bounded-values" },
    { id: "fld_2222222222222222", label: "Operation", aliases: [], type: "string", role: "dimension", exposure: "bounded-values" },
  ],
  metrics: [],
};

function latestUserOperationsDraft(): Extract<AnalysisDraft, { mode: "records" }> {
  return {
    version: "2",
    mode: "records",
    primaryEntityId: "ent_0123456789abcdef",
    relationshipIds: ["rel_0123456789abcdef"],
    fields: [
      { fieldId: "fld_0000000000000001", outputId: "out_user" },
      { fieldId: "fld_1111111111111111", outputId: "out_created" },
      { fieldId: "fld_2222222222222222", outputId: "out_operation" },
    ],
    orderBy: [{ fieldId: "fld_1111111111111111", direction: "desc" }],
    limit: 1,
  };
}

describe("Tessera Agent vNext public boundary", () => {
  test("loads a bounded physical schema context without exposing connection metadata", async () => {
    const catalog = {
      connectorId: "secret-connector",
      dialect: "postgres",
      databaseName: "secret-database",
      scannedAt: "2026-08-20T00:00:00.000Z",
      fingerprint: semanticFingerprint,
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "orders",
          kind: "table",
          comment: "Do not send comments to the model.",
          estimatedRows: 42,
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1, defaultValue: "gen_random_uuid()" },
            { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2 },
          ],
          primaryKey: ["id"],
          foreignKeys: [{
            name: "orders_customer_id_fkey",
            columns: ["customer_id"],
            referencedSchema: "analytics",
            referencedTable: "customers",
            referencedColumns: ["id"],
          }],
        }],
      }],
    } as DatabaseCatalog;
    const summary = buildDatabaseSchemaContext(catalog);
    const serialized = JSON.stringify(summary);

    expect(summary.schemas[0]?.name).toBe("analytics");
    expect(summary.schemas[0]?.tables[0]?.name).toBe("orders");
    expect(summary.schemas[0]?.tables[0]?.columns.map((column) => column.name)).toEqual(["id", "created_at"]);
    expect(serialized).not.toContain("orders_customer_id_fkey");
    expect(serialized).not.toContain("secret-connector");
    expect(serialized).not.toContain("secret-database");
    expect(serialized).not.toContain("Do not send comments");
    expect(serialized).not.toContain("gen_random_uuid");
    expect(serialized).not.toContain("estimatedRows");
    expect(formatDatabaseSchemaContext(summary)).toContain("<database_schema>");

    const calls = { inspect: 0 };
    const processor = createSchemaContextProcessor({
      async inspectCatalog() {
        calls.inspect += 1;
        return { catalog };
      },
    });
    const state: Record<string, unknown> = {};
    const processLLMRequest = processor.processLLMRequest!;
    const prompt = [{
      role: "user" as const,
      content: [{ type: "text" as const, text: "Show order counts." }],
    }];
    const processArgs = {
      prompt,
      model: {} as never,
      stepNumber: 0,
      steps: [],
      state,
      abort: (() => { throw new Error("processor aborted"); }) as never,
      retryCount: 0,
    };
    const firstResult = await processLLMRequest(processArgs);
    const secondResult = await processLLMRequest(processArgs);

    expect(calls.inspect).toBe(1);
    expect(firstResult?.prompt).toHaveLength(2);
    expect(JSON.stringify(firstResult?.prompt)).toContain("analytics");
    expect(firstResult?.prompt?.[0]?.role).toBe("assistant");
    expect(firstResult?.prompt?.[1]?.role).toBe("user");
    expect(secondResult).toBeUndefined();

    const oversizedCatalog = {
      dialect: "postgres",
      schemas: [{
        name: "public",
        tables: Array.from({ length: DATABASE_SCHEMA_CONTEXT_LIMITS.maxTables + 1 }, (_, index) => ({
          schema: "public",
          name: `table_${index}`,
          kind: "table" as const,
          columns: [{ name: "id", dataType: "integer", nullable: false, ordinal: 1 }],
          primaryKey: ["id"],
          foreignKeys: [],
        })),
      }],
    } as Pick<DatabaseCatalog, "dialect" | "schemas">;
    const oversized = buildDatabaseSchemaContext(oversizedCatalog);
    expect(oversized.truncated).toBeTrue();
    expect(oversized.omitted.tables).toBe(1);
    expect(JSON.stringify(oversized).length).toBeLessThanOrEqual(DATABASE_SCHEMA_CONTEXT_LIMITS.maxCharacters);
  });

  test("attempts schema inventory only once when the connector is unavailable", async () => {
    const calls = { inspect: 0 };
    const processor = createSchemaContextProcessor({
      async inspectCatalog() {
        calls.inspect += 1;
        throw new Error("catalog unavailable");
      },
    });
    const processLLMRequest = processor.processLLMRequest!;
    const processArgs = {
      prompt: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: "Show order counts." }],
      }],
      model: {} as never,
      stepNumber: 0,
      steps: [],
      state: {} as Record<string, unknown>,
      abort: (() => { throw new Error("processor aborted"); }) as never,
      retryCount: 0,
    };

    await expect(processLLMRequest(processArgs)).resolves.toBeUndefined();
    await expect(processLLMRequest(processArgs)).resolves.toBeUndefined();
    expect(calls.inspect).toBe(1);
  });

  test("discovers physical relations progressively and keeps schema expansion bounded", () => {
    const catalog = {
      connectorId: "secret-connector",
      dialect: "postgres",
      databaseName: "secret-database",
      scannedAt: "2026-08-20T00:00:00.000Z",
      fingerprint: semanticFingerprint,
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "orders",
          kind: "table",
          comment: "private comment",
          estimatedRows: 100,
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1, defaultValue: "secret_default()" },
            { name: "customer_id", dataType: "uuid", nullable: false, ordinal: 2 },
          ],
          primaryKey: ["id"],
          foreignKeys: [{
            name: "orders_customer_id_fkey",
            columns: ["customer_id"],
            referencedSchema: "crm",
            referencedTable: "customers",
            referencedColumns: ["id"],
          }],
        }],
      }, {
        name: "crm",
        tables: [{
          schema: "crm",
          name: "customers",
          kind: "table",
          columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    } as DatabaseCatalog;

    const inventory = buildDatabaseSchemaInventory(catalog);
    expect(inventory.schemas.map((schema) => schema.name)).toEqual(["analytics", "crm"]);
    expect(inventory.schemas[0]?.tables).toEqual([{ name: "orders", kind: "table" }]);
    expect(JSON.stringify(inventory)).not.toContain("customer_id");
    expect(JSON.stringify(inventory)).not.toContain("secret-connector");

    const expanded = inspectDatabaseSchema(catalog, { schema: "analytics", table: "orders" });
    expect(expanded).toMatchObject({
      status: "completed",
      schema: {
        name: "analytics",
        tables: [{
          name: "orders",
          columns: [{ name: "id", dataType: "uuid", nullable: false }, { name: "customer_id", dataType: "uuid", nullable: false }],
          primaryKey: ["id"],
          foreignKeys: [{
            columns: ["customer_id"],
            referencedSchema: "crm",
            referencedTable: "customers",
            referencedColumns: ["id"],
          }],
        }],
      },
      tableCount: 1,
      columnCount: 2,
      foreignKeyCount: 1,
      truncated: false,
    });
    const expandedJson = JSON.stringify(expanded);
    expect(expandedJson).not.toContain("orders_customer_id_fkey");
    expect(expandedJson).not.toContain("secret_default");
    expect(expandedJson).not.toContain("private comment");

    expect(inspectDatabaseSchema(catalog, { schema: "missing" })).toEqual({
      status: "blocked",
      reason: "schema_not_discovered",
      nextAction: "inspect_schema",
    });
    expect(inspectDatabaseSchema(catalog, { schema: "analytics", table: "missing" })).toEqual({
      status: "blocked",
      reason: "table_not_discovered",
      nextAction: "inspect_schema",
    });
  });

  test("projects schema metadata through semantic exposure and the discovered inventory", () => {
    const catalog = {
      connectorId: "secret-connector",
      dialect: "postgres",
      databaseName: "secret-database",
      scannedAt: "2026-08-20T00:00:00.000Z",
      fingerprint: semanticFingerprint,
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "orders",
          kind: "table",
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
            { name: "customer_id", dataType: "uuid", nullable: false, ordinal: 2 },
            { name: "secret_token", dataType: "text", nullable: false, ordinal: 3 },
          ],
          primaryKey: ["id", "secret_token"],
          foreignKeys: [{
            name: "orders_customer_fkey",
            columns: ["customer_id"],
            referencedSchema: "analytics",
            referencedTable: "customers",
            referencedColumns: ["secret_id"],
          }],
        }, {
          schema: "analytics",
          name: "private_events",
          kind: "table",
          columns: [{ name: "secret_id", dataType: "text", nullable: false, ordinal: 1 }],
          primaryKey: ["secret_id"],
          foreignKeys: [],
        }, {
          schema: "analytics",
          name: "customers",
          kind: "table",
          columns: [{ name: "secret_id", dataType: "uuid", nullable: false, ordinal: 1 }],
          primaryKey: ["secret_id"],
          foreignKeys: [],
        }],
      }],
    } as DatabaseCatalog;
    const semanticCatalog = semanticCatalogSchema.parse({
      version: "2",
      ref: {
        manifestId: "test",
        revision: "1",
        fingerprint: semanticFingerprint,
        catalogFingerprint: semanticFingerprint,
      },
      entities: [{
        id: "ent_0123456789abcdef",
        label: "Orders",
        aliases: [],
        fields: [
          {
            id: fieldIdFor(catalog, "analytics", "orders", "id"),
            label: "Id",
            aliases: [],
            type: "string",
            role: "identifier",
            exposure: "bounded-values",
          },
          {
            id: fieldIdFor(catalog, "analytics", "orders", "customer_id"),
            label: "Customer Id",
            aliases: [],
            type: "string",
            role: "identifier",
            exposure: "bounded-values",
          },
        ],
        metrics: [],
      }],
      relationships: [],
    });

    const inventory = buildDatabaseSchemaInventory(catalog, semanticCatalog);
    expect(inventory.schemas).toEqual([{
      name: "analytics",
      tableCount: 1,
      tables: [{ name: "orders", kind: "table" }],
    }]);

    const expanded = inspectDatabaseSchema(catalog, { schema: "analytics", table: "orders" }, inventory, semanticCatalog);
    expect(expanded).toMatchObject({
      status: "completed",
      schema: {
        tables: [{
          name: "orders",
          columns: [
            { name: "id" },
            { name: "customer_id" },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      },
    });
    expect(JSON.stringify(expanded)).not.toContain("secret_token");
    expect(JSON.stringify(expanded)).not.toContain("private_events");

    expect(inspectDatabaseSchema(catalog, { schema: "analytics", table: "customers" }, inventory, semanticCatalog)).toEqual({
      status: "blocked",
      reason: "table_not_discovered",
      nextAction: "inspect_schema",
    });
  });

  test("uses a structured prompt with an explicit trust boundary", () => {
    const instructions = buildDataCopilotInstructions();

    expect(instructions).toContain("<role>");
    expect(instructions).toContain("<trust_boundary>");
    expect(instructions).toContain("<decision_policy>");
    expect(instructions).toContain("<tool_use>");
    expect(instructions).toContain("<sequence>");
    expect(instructions).toContain("<response_contract>");
    expect(instructions).toContain("<examples>");
    expect(instructions).toContain("<system-reminder>");
    expect(instructions).toContain("This is an intent decision, not keyword routing");
    expect(instructions).toContain("make a fresh evidence decision");
    expect(instructions).toContain("<describe_data>");
    expect(instructions).toContain("<probe_data>");
    expect(instructions).toContain("Use at most two probes in one turn");
    expect(instructions).toContain("key fields or relationships were truncated");
  });

  test("keeps the model-facing discovery probe schema flat and normalizes it server-side", () => {
    const jsonSchema = modelProbeDataInputSchema["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(jsonSchema).not.toHaveProperty("oneOf");
    expect(jsonSchema).not.toHaveProperty("anyOf");
    expect(jsonSchema).toHaveProperty("properties.kind");
    expect(normalizeProbeDataInput({
      kind: "value-domain",
      fieldId: "fld_1111111111111111",
      candidates: ["active", "pending"],
    })).toEqual({
      kind: "value-domain",
      fieldId: "fld_1111111111111111",
      candidates: ["active", "pending"],
    });
    expect(() => normalizeProbeDataInput({
      kind: "value-domain",
      fieldId: "fld_1111111111111111",
      candidates: ["unexpected"],
      fieldIds: ["fld_1111111111111111"],
    })).toThrow();
  });

  test("keeps probe scope selection inside previously issued server scopes", () => {
    const users = planningScope({ tokenPart: "u", entities: [userEntity] });
    const operations = planningScope({
      tokenPart: "o",
      entities: [operationEntity],
      relationships: [{
        id: "rel_0123456789abcdef",
        fromEntityId: "ent_0123456789abcdef",
        toEntityId: "ent_abcdef0123456789",
        pairs: [{ fromFieldId: "fld_0000000000000001", toFieldId: "fld_0000000000000002" }],
        cardinality: "one-to-many",
        origin: "foreign-key",
      }],
    });

    expect(selectPlanningCapabilityScopesForProbe([users, operations], {
      kind: "field-profile",
      fieldIds: ["fld_1111111111111111", "fld_2222222222222222"],
    })?.map((scope) => scope.capability.token)).toEqual([
      operations.capability.token,
      users.capability.token,
    ]);
    expect(selectPlanningCapabilityScopesForProbe([users], {
      kind: "join-coverage",
      relationshipId: "rel_0123456789abcdef",
    })).toBeUndefined();
  });

  test("gates unresolved inspect candidates without blocking a grounded join", () => {
    const broadInspect = planningScope({
      tokenPart: "b",
      entities: [userEntity, operationEntity],
      relationships: [{
        id: "rel_0123456789abcdef",
        fromEntityId: "ent_0123456789abcdef",
        toEntityId: "ent_abcdef0123456789",
        pairs: [{ fromFieldId: "fld_0000000000000001", toFieldId: "fld_0000000000000002" }],
        cardinality: "one-to-many",
        origin: "foreign-key",
      }],
    });
    const singleEntityDraft: AnalysisDraft = {
      version: "2",
      mode: "records",
      primaryEntityId: "ent_0123456789abcdef",
      relationshipIds: [],
      fields: [{ fieldId: "fld_0000000000000001", outputId: "out_user" }],
      orderBy: [],
      limit: 1,
    };

    expect(planningScopesRequireDiscovery([broadInspect], singleEntityDraft)).toBeTrue();
    expect(planningScopesRequireDiscovery([broadInspect], latestUserOperationsDraft())).toBeFalse();
    expect(planningScopesRequireDiscovery([{
      ...broadInspect,
      catalog: semanticCatalogSchema.parse({ ...broadInspect.catalog, entities: [userEntity] }),
      discovery: "inspect",
      truncated: true,
    }], singleEntityDraft)).toBeFalse();
    expect(planningScopesRequireDiscovery([{ ...broadInspect, discovery: "describe" }], singleEntityDraft)).toBeFalse();
  });

  test("compacts description and probe results before model delivery", () => {
    const catalog = semanticCatalogSchema.parse({
      version: "2",
      ref: {
        manifestId: "test",
        revision: "1",
        fingerprint: semanticFingerprint,
        catalogFingerprint: semanticFingerprint,
      },
      entities: [{
        ...userEntity,
        description: "Customer account created after verified registration.",
        fields: [{
          ...userEntity.fields[1],
          description: "The timestamp when the customer account was created.",
        }],
      }],
      relationships: [],
    });
    const described = compactDescribeDataForModel({
      status: "completed",
      entityCount: 1,
      truncated: false,
      omitted: { entities: 0, fields: 0, metrics: 0, relationships: 0 },
      catalog,
    });
    expect(JSON.stringify(described)).toContain("Customer account created");
    expect(JSON.stringify(described)).not.toContain("catalogFingerprint");

    const probed = compactProbeDataForModel({
      status: "completed",
      evidence: {
        resultScope: "complete-result",
        rowCount: 1,
        truncated: false,
        columns: [{ key: "out_minimum", label: "Minimum", type: "date" }],
        sampleStrategy: "all",
        sampleRows: [{ out_minimum: "2026-08-01" }],
        numericSummaries: [],
        omitted: { columns: 0, rows: 0 },
      },
    });
    const serializedProbe = JSON.stringify(probed);
    expect(serializedProbe).not.toContain("query_");
    expect(serializedProbe).not.toContain("cap_");
    expect(serializedProbe).not.toContain("sourceName");
    expect(MAX_DISCOVERY_PROBES_PER_TURN).toBe(2);
  });

  test("uses Agent.stream for a completed run and persists that private turn", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-agent-stream-"));
    const session = createTesseraSessionMemory({ rootDirectory });
    const testModel = streamOnlyTestModel();
    const llm: TesseraLlmConfig = {
      model: testModel.model as unknown as string,
      headers: {},
      temperature: 0,
      maxOutputTokens: 256,
      maxSteps: 3,
      maxRetries: 0,
    };

    try {
      await session.createThread({ id: "thread-stream-run", resourceId: "local-studio" });
      const agent = createTesseraStudioAgent({
        dataAgent: {} as DataAgent,
        memory: session.memory,
        llm,
      });
      const run = await agent.run({
        runId: "run-stream",
        threadId: "thread-stream-run",
        message: "Remember the stream marker.",
        signal: new AbortController().signal,
      });

      expect(run.message).toBe("A streamed Tessera response.");
      expect(testModel.calls.stream).toBe(1);
      const memory = await session.memory.getContext({
        threadId: "thread-stream-run",
        resourceId: "local-studio",
      });
      expect(JSON.stringify(memory.messages)).toContain("Remember the stream marker.");
      expect(JSON.stringify(memory.messages)).toContain("A streamed Tessera response.");
    } finally {
      await session.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("loads schema once across the Agent loop and returns inspected metadata to the model", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-agent-schema-loop-"));
    const session = createTesseraSessionMemory({ rootDirectory });
    const physicalCatalog = {
      connectorId: "test-connector",
      dialect: "postgres",
      databaseName: "test-database",
      scannedAt: "2026-08-20T00:00:00.000Z",
      fingerprint: semanticFingerprint,
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "orders",
          kind: "table",
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
            { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2 },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    } as DatabaseCatalog;
    const calls = { inspect: 0, streams: 0 };
    const prompts: string[] = [];
    const dataAgent = {
      connectorId: "test-connector",
      async inspectCatalog() {
        calls.inspect += 1;
        return { catalog: physicalCatalog };
      },
    } as unknown as DataAgent;
    let modelTurn = 0;
    const model = {
      specificationVersion: "v2",
      provider: "tessera-test",
      modelId: "schema-loop-test",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Tessera must use Agent.stream for every model turn.");
      },
      async doStream(options: { prompt?: unknown }) {
        calls.streams += 1;
        prompts.push(JSON.stringify(options.prompt));
        const inspect = modelTurn++ === 0;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (inspect) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "schema-call-1",
                  toolName: "inspect_schema",
                  input: JSON.stringify({ schema: "analytics", table: "orders" }),
                  providerExecuted: false,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
              } else {
                controller.enqueue({ type: "text-start", id: "text-1" });
                controller.enqueue({ type: "text-delta", id: "text-1", delta: "The orders schema is available." });
                controller.enqueue({ type: "text-end", id: "text-1" });
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
    const llm: TesseraLlmConfig = {
      model: model as unknown as string,
      headers: {},
      temperature: 0,
      maxOutputTokens: 256,
      maxSteps: 4,
      maxRetries: 0,
    };

    try {
      await session.createThread({ id: "thread-schema-loop", resourceId: "local-studio" });
      const agent = createTesseraStudioAgent({ dataAgent, memory: session.memory, llm });
      const run = await agent.run({
        runId: "run-schema-loop",
        threadId: "thread-schema-loop",
        message: "Describe the orders schema.",
        signal: new AbortController().signal,
      });

      expect(run.message).toBe("The orders schema is available.");
      expect(calls.inspect).toBe(1);
      expect(calls.streams).toBe(2);
      expect(prompts[0]).toContain("<database_schema_inventory>");
      expect(prompts[0]).toContain("orders");
      expect(prompts[1]).toContain("created_at");
      expect(prompts[1]).not.toContain("<database_schema_inventory>");
    } finally {
      await session.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("binds inspected current context as a planning scope without exposing server references to the model", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-agent-current-context-"));
    const session = createTesseraSessionMemory({ rootDirectory });
    const current = planningScope({ tokenPart: "c", entities: [userEntity] });
    const omitted = { entities: 0, fields: 0, metrics: 0, relationships: 0 } as const;
    const describeCapabilities: string[] = [];
    const dataAgent = {
      connectorId: "test",
      async describePlanningCatalog(input: { capability: { token: string }; entityIds: readonly string[] }) {
        describeCapabilities.push(input.capability.token);
        return {
          capability: current.capability,
          semanticCatalog: current.catalog,
          truncated: false,
          omitted,
        };
      },
    } as unknown as DataAgent;
    const toolTurns = [
      { toolName: "inspect_current_context", input: {} },
      { toolName: "describe_data", input: { entityIds: ["ent_0123456789abcdef"] } },
    ] as const;
    let modelTurn = 0;
    const model = {
      specificationVersion: "v2",
      provider: "tessera-test",
      modelId: "current-context-test",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Tessera must use Agent.stream for every model turn.");
      },
      async doStream() {
        const tool = toolTurns[modelTurn++];
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (tool) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${modelTurn}`,
                  toolName: tool.toolName,
                  input: JSON.stringify(tool.input),
                  providerExecuted: false,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
              } else {
                controller.enqueue({ type: "text-start", id: "text-1" });
                controller.enqueue({ type: "text-delta", id: "text-1", delta: "The selected data definition is ready." });
                controller.enqueue({ type: "text-end", id: "text-1" });
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
    const llm: TesseraLlmConfig = {
      model: model as unknown as string,
      headers: {},
      temperature: 0,
      maxOutputTokens: 256,
      maxSteps: 5,
      maxRetries: 0,
    };

    try {
      await session.createThread({ id: "thread-current-context", resourceId: "local-studio" });
      const agent = createTesseraStudioAgent({ dataAgent, memory: session.memory, llm });
      const run = await agent.run({
        runId: "run-current-context",
        threadId: "thread-current-context",
        message: "Describe this table.",
        signal: new AbortController().signal,
        turnContext: {
          workspace: { hasLocalFilter: true, view: "definition" },
          currentRelation: {
            capability: current.capability,
            semanticCatalog: current.catalog,
            truncated: false,
            omitted,
          },
        },
      });

      expect(run.message).toBe("The selected data definition is ready.");
      expect(describeCapabilities).toEqual([current.capability.token]);
      expect(modelTurn).toBe(3);

      const modelOutput = compactInspectCurrentContextForModel({
        status: "completed",
        entityCount: current.catalog.entities.length,
        truncated: false,
        omitted,
        catalog: current.catalog,
      });
      const serialized = JSON.stringify(modelOutput);
      expect(serialized).not.toContain("catalogFingerprint");
      expect(serialized).not.toContain(semanticFingerprint);
      expect(serialized).not.toContain(current.capability.token);
      expect(serialized).not.toContain("cap_");
    } finally {
      await session.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("registers describe_data and bounded probe_data as real Agent tools", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "tessera-agent-discovery-"));
    const session = createTesseraSessionMemory({ rootDirectory });
    const initial = planningScope({ tokenPart: "i", entities: [userEntity] });
    const described = planningScope({
      tokenPart: "d",
      entities: [{
        ...userEntity,
        description: "A verified customer account.",
        fields: [{ ...userEntity.fields[1], description: "Account registration timestamp." }],
      }],
    });
    const catalogRef = {
      connectorId: "test",
      catalogFingerprint: semanticFingerprint,
      capturedAt: "2026-08-16T00:00:00.000Z",
    };
    const calls = { inspect: 0, describe: [] as string[], probe: [] as string[] };
    const dataAgent = {
      connectorId: "test",
      async inspectPlanningCatalog() {
        calls.inspect += 1;
        return {
          ref: catalogRef,
          capability: initial.capability,
          semanticCatalog: initial.catalog,
          cacheStatus: "loaded" as const,
          entityCount: 1,
          truncated: false,
          omitted: { entities: 0, fields: 0, metrics: 0, relationships: 0 },
        };
      },
      async describePlanningCatalog(input: { capability: { token: string } }) {
        calls.describe.push(input.capability.token);
        return {
          ref: catalogRef,
          capability: described.capability,
          semanticCatalog: described.catalog,
          cacheStatus: "hit" as const,
          truncated: false,
          omitted: { entities: 0, fields: 0, metrics: 0, relationships: 0 },
        };
      },
      async probePlanningData(input: { capability: { token: string } }) {
        calls.probe.push(input.capability.token);
        return {
          catalog: catalogRef,
          semanticCatalog: described.catalog.ref,
          probe: { kind: "value-domain" as const, fieldId: "fld_1111111111111111", candidates: ["active"] },
          columns: [{ outputId: "out_value", label: "Value", type: "string" }],
          execution: {
            specId: "spec_test",
            probeId: "probe_test",
            queryFingerprint: "query_private",
            result: {
              queryId: "private-query-id",
              columns: [{ name: "out_value" }],
              rows: [{ out_value: "active" }],
              rowCount: 1,
              truncated: false,
              durationMs: 1,
            },
            resultScope: "complete-result" as const,
          },
        };
      },
    } as unknown as DataAgent;

    let modelTurn = 0;
    const toolTurns = [
      { toolName: "inspect_catalog", input: { query: "new users" } },
      { toolName: "describe_data", input: { entityIds: ["ent_0123456789abcdef"] } },
      { toolName: "probe_data", input: { kind: "value-domain", fieldId: "fld_1111111111111111", candidates: ["active"] } },
      { toolName: "probe_data", input: { kind: "value-domain", fieldId: "fld_1111111111111111", candidates: ["active"] } },
      { toolName: "probe_data", input: { kind: "value-domain", fieldId: "fld_1111111111111111", candidates: ["active"] } },
    ];
    const model = {
      specificationVersion: "v2",
      provider: "tessera-test",
      modelId: "tool-loop-test",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("Tessera must use Agent.stream for every model turn.");
      },
      async doStream() {
        const tool = toolTurns[modelTurn++];
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              if (tool) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${modelTurn}`,
                  toolName: tool.toolName,
                  input: JSON.stringify(tool.input),
                  providerExecuted: false,
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                });
              } else {
                controller.enqueue({ type: "text-start", id: "text-1" });
                controller.enqueue({ type: "text-delta", id: "text-1", delta: "I need one clarification before I can continue." });
                controller.enqueue({ type: "text-end", id: "text-1" });
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
    const llm: TesseraLlmConfig = {
      model: model as unknown as string,
      headers: {},
      temperature: 0,
      maxOutputTokens: 256,
      maxSteps: 8,
      maxRetries: 0,
    };

    try {
      await session.createThread({ id: "thread-discovery-tools", resourceId: "local-studio" });
      const agent = createTesseraStudioAgent({ dataAgent, memory: session.memory, llm });
      const run = await agent.run({
        runId: "run-discovery-tools",
        threadId: "thread-discovery-tools",
        message: "Find the newest users.",
        signal: new AbortController().signal,
      });

      expect(run.message).toBe("I need one clarification before I can continue.");
      expect(calls.inspect).toBe(1);
      expect(calls.describe).toEqual([initial.capability.token]);
      expect(calls.probe).toEqual([described.capability.token, described.capability.token]);
      expect(modelTurn).toBe(6);
    } finally {
      await session.close();
      rmSync(rootDirectory, { force: true, recursive: true });
    }
  });

  test("normalizes a semantic model plan into a governed draft without model-generated output ids", () => {
    const draft = normalizeAnalysisToolDraft({
      mode: "aggregate",
      primaryEntityId: "ent_0123456789abcdef",
      measures: [{ kind: "aggregate", aggregate: "count" }],
      dimensions: [],
      relationshipIds: [],
      aggregateOrderBy: [],
      output: "scalar",
      limit: 100,
    });

    expect(draft.filter).toBeUndefined();
    expect(draft).toMatchObject({
      mode: "aggregate",
      measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_measure_1" }],
    });
  });

  test("uses a flat native model schema instead of a recursive union", () => {
    const jsonSchema = modelAnalysisToolInputSchema["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(jsonSchema).not.toHaveProperty("default");
    expect(jsonSchema).not.toHaveProperty("oneOf");
    expect(jsonSchema).toHaveProperty("properties.recordOrderBy");
    expect(jsonSchema).toHaveProperty("properties.aggregateOrderBy");

    const invalid = modelAnalysisToolInputSchema["~standard"].validate({ action: "run_governed_analysis" });
    expect("issues" in invalid).toBeTrue();
  });

  test("leaves mode-specific plan errors for the governed tool to correct", () => {
    const incompleteRecordsPlan = {
      mode: "records" as const,
      primaryEntityId: "ent_0123456789abcdef",
      fields: ["fld_0123456789abcdef"],
      relationshipIds: [],
      limit: 1,
    };
    const accepted = modelAnalysisToolInputSchema["~standard"].validate(incompleteRecordsPlan);
    expect("value" in accepted).toBeTrue();
    if ("value" in accepted) {
      expect(() => normalizeAnalysisToolDraft(accepted.value)).toThrow();
    }
  });

  test("keeps records ordering semantic while the server assigns projection output ids", () => {
    const draft = normalizeAnalysisToolDraft({
      mode: "records",
      primaryEntityId: "ent_0123456789abcdef",
      relationshipIds: [],
      fields: ["fld_0123456789abcdef"],
      recordOrderBy: [{ fieldId: "fld_0123456789abcdef", direction: "desc" }],
      limit: 1,
    });

    expect(draft).toMatchObject({
      mode: "records",
      fields: [{ fieldId: "fld_0123456789abcdef", outputId: "out_field_1" }],
      orderBy: [{ fieldId: "fld_0123456789abcdef", direction: "desc" }],
    });
  });

  test("preserves relevant planning authority across multiple catalog inspections", () => {
    const users = planningScope({ tokenPart: "u", entities: [userEntity] });
    const operations = planningScope({
      tokenPart: "o",
      entities: [
        { ...userEntity, fields: [userEntity.fields[0]] },
        operationEntity,
      ],
      relationships: [{
        id: "rel_0123456789abcdef",
        fromEntityId: "ent_0123456789abcdef",
        toEntityId: "ent_abcdef0123456789",
        pairs: [{ fromFieldId: "fld_0000000000000001", toFieldId: "fld_0000000000000002" }],
        cardinality: "one-to-many",
        origin: "foreign-key",
      }],
    });

    const selected = selectPlanningCapabilityScopes([users, operations], latestUserOperationsDraft());

    expect(selected?.map((scope) => scope.capability.token)).toEqual([
      operations.capability.token,
      users.capability.token,
    ]);
  });

  test("does not broaden a composed planning scope to unseen identifiers", () => {
    const users = planningScope({ tokenPart: "u", entities: [userEntity] });
    const draft = latestUserOperationsDraft();
    const unseenFieldDraft: Extract<AnalysisDraft, { mode: "records" }> = {
      ...draft,
      relationshipIds: [],
      fields: [...draft.fields, { fieldId: "fld_3333333333333333", outputId: "out_unseen" }],
    };

    expect(selectPlanningCapabilityScopes([users], unseenFieldDraft)).toBeUndefined();
  });

  test("turns governed failures into actionable but detail-free model feedback", () => {
    expect(analysisToolRejection(new DataAgentError("catalog_stale"))).toEqual({
      status: "rejected",
      reason: "catalog_changed",
      nextAction: "inspect_catalog",
    });
    expect(analysisToolRejection(new DataAgentError("invalid_analysis_spec"))).toEqual({
      status: "rejected",
      reason: "invalid_plan",
      nextAction: "revise_plan",
    });
    expect(analysisToolRejection(new Error("postgresql://private-host/warehouse"))).toEqual({
      status: "rejected",
      reason: "data_unavailable",
      nextAction: "respond",
    });
  });

  test("sanitizes only genuinely unsafe assistant output", () => {
    expect(safeAssistantNarration("Revenue increased by 12%. Review the Artifact for the verified result.")).toBe(
      "Revenue increased by 12%. Review the Artifact for the verified result.",
    );
    expect(safeAssistantNarration("SELECT total FROM private.orders")).toBeUndefined();
    expect(safeAssistantNarration("The internal field is ent_0123456789abcdef.")).toBe("The internal field is [internal identifier].");
    expect(safeAssistantNarration("Authorization: Bearer private-token-value")).toBeUndefined();
  });

  test("preserves complete selected record evidence instead of truncating cell text", () => {
    const transcript = [
      "用户：分析这个 session 的完整聊天内容。",
      "助手：我会读取消息正文并按时间顺序整理。",
      "助手：这是需要保留的长文本，不能因为模型证据预算而被截断。",
    ].join("\n").repeat(20);
    const result: DatabaseQueryResult = {
      queryId: "query-transcript",
      columns: [{ name: "body" }],
      rows: [{ body: transcript }],
      rowCount: 1,
      truncated: false,
      durationMs: 1,
    };

    const evidence = modelEvidenceFromResult(
      result,
      [{ outputId: "out_body", label: "Message body", type: "string" }],
      32,
    );

    expect(evidence.sampleRows).toEqual([{ out_body: transcript }]);
    expect(new TextEncoder().encode(transcript).byteLength).toBeGreaterThan(160);
  });

  test("does not treat an empty model turn as a visible copilot response", () => {
    expect(hasVisibleCopilotText("")).toBeFalse();
    expect(hasVisibleCopilotText(" \n\t ")).toBeFalse();
    expect(hasVisibleCopilotText("Verified result available.")).toBeTrue();
  });

  test("emits only allowlisted public tool summaries", () => {
    expect(publicToolOutput("inspect_catalog", "completed", {
      tableCount: 3,
      truncated: true,
      catalog: { entities: [{ label: "private_orders" }] },
      connectionString: "postgres://user:password@private-host/warehouse",
    })).toEqual({ status: "completed", tableCount: 3, truncated: true });

    expect(publicToolOutput("describe_data", "completed", {
      entityCount: 2,
      truncated: true,
      catalog: { entities: [{ id: "ent_0123456789abcdef" }] },
      capability: { token: `cap_${"x".repeat(32)}.${"y".repeat(32)}` },
    })).toEqual({ status: "completed", entityCount: 2, truncated: true });

    expect(publicToolOutput("run_analysis", "completed", {
      rowCount: 2,
      evidence: { sampleRows: [{ email: "customer@example.test" }] },
      rawCommand: "select raw_sql_marker from private.orders",
    })).toEqual({ status: "completed", rowCount: 2 });
  });

  test("maps private runtime lifecycle into product stages without details", () => {
    expect(toPublicStageData("run-5", {
      type: "stage",
      requestId: "private-request",
      stage: "semantic",
      status: "completed",
      at: "2026-08-16T10:00:00.000Z",
      durationMs: 5,
    })).toEqual({ runId: "run-5", stage: "retrieval", status: "completed", durationMs: 5 });

    expect(toPublicStageData("run-5", {
      type: "stage",
      requestId: "private-request",
      stage: "binding",
      status: "started",
      at: "2026-08-16T10:00:00.000Z",
    })).toEqual({ runId: "run-5", stage: "planning", status: "started" });

    expect(toPublicStageData("run-5", {
      type: "stage",
      requestId: "private-request",
      stage: "probing",
      status: "skipped",
      at: "2026-08-16T10:00:00.000Z",
    })).toBeUndefined();
  });

  test("keeps a connected canonical timeline when a run has no public probe tool", () => {
    const stages = new Map<TesseraDataAgentStage, { status: "completed" }>([
      ["catalog", { status: "completed" as const }],
      ["retrieval", { status: "completed" as const }],
      ["planning", { status: "completed" as const }],
      ["compiling", { status: "completed" as const }],
      ["executing", { status: "completed" as const }],
      ["verifying", { status: "completed" as const }],
      ["publishing", { status: "completed" as const }],
      ["narrating", { status: "completed" as const }],
    ]);

    expect(toPublicExecutionTraceData("run-6", stages)).toEqual({
      runId: "run-6",
      status: "completed",
      stages: [
        { stage: "catalog", status: "completed" },
        { stage: "retrieval", status: "completed" },
        { stage: "planning", status: "completed" },
        { stage: "compiling", status: "completed" },
        { stage: "executing", status: "completed" },
        { stage: "verifying", status: "completed" },
        { stage: "publishing", status: "completed" },
        { stage: "narrating", status: "completed" },
      ],
    });
  });

  test("treats a published agent result as a completed execution without a narrator stage", () => {
    const stages = new Map<TesseraDataAgentStage, { status: "completed" }>([
      ["catalog", { status: "completed" as const }],
      ["executing", { status: "completed" as const }],
      ["publishing", { status: "completed" as const }],
    ]);

    expect(toPublicExecutionTraceData("run-7", stages).status).toBe("completed");
  });
});
