import { describe, expect, test } from "bun:test";
import {
  finalizeCatalog,
  type DatabaseConnector,
  type DatabaseQueryRequest,
  type DatabaseQueryResult,
} from "@open-tessera/database";
import {
  DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES,
  DATA_AGENT_RELATION_PREVIEW_LIMIT,
  createDataAgent,
  DataAgentError,
} from "./index";
import { entityIdFor, fieldIdFor } from "./compiler";

const catalog = finalizeCatalog({
  connectorId: "warehouse",
  dialect: "postgres",
  databaseName: "analytics",
  scannedAt: "2026-08-16T00:00:00.000Z",
  schemas: [{
    name: "analytics",
    tables: [{
      schema: "analytics",
      name: "orders",
      kind: "table",
      columns: [
        { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
        { name: "status", dataType: "text", nullable: false, ordinal: 2 },
        { name: "total", dataType: "numeric", nullable: false, ordinal: 3 },
        { name: "email", dataType: "text", nullable: false, ordinal: 4 },
        { name: "api_token", dataType: "text", nullable: false, ordinal: 5 },
      ],
      primaryKey: ["id"],
      foreignKeys: [],
    }],
  }],
});

function harness() {
  const requests: DatabaseQueryRequest[] = [];
  const connector: DatabaseConnector = {
    id: "warehouse",
    dialect: "postgres",
    assess: async () => ({
      connectorId: "warehouse",
      dialect: "postgres",
      connected: true,
      readOnlyTransactions: true,
      warnings: [],
    }),
    introspect: async () => catalog,
    query: async (request) => {
      requests.push(request);
      return {
        queryId: "query_1",
        columns: [{ name: "out_revenue", dataTypeId: 1700 }],
        rows: [{ out_revenue: 42 }],
        rowCount: 1,
        truncated: false,
        durationMs: 8,
      } satisfies DatabaseQueryResult;
    },
    close: async () => {},
  };
  return { connector, requests };
}

function revenueDraft() {
  return {
    version: "2" as const,
    primaryEntityId: entityIdFor(catalog, "analytics", "orders"),
    relationshipIds: [],
    measures: [{
      kind: "aggregate" as const,
      aggregate: "sum" as const,
      fieldId: fieldIdFor(catalog, "analytics", "orders", "total"),
      outputId: "out_revenue",
    }],
    dimensions: [],
    filter: {
      kind: "comparison" as const,
      fieldId: fieldIdFor(catalog, "analytics", "orders", "status"),
      op: "eq" as const,
      value: "paid",
    },
    orderBy: [],
    output: "scalar" as const,
    limit: 1,
  };
}

function wideFieldCatalog() {
  return finalizeCatalog({
    connectorId: "warehouse",
    dialect: "postgres",
    databaseName: "analytics",
    scannedAt: "2026-08-16T00:00:00.000Z",
    schemas: [{
      name: "analytics",
      tables: [{
        schema: "analytics",
        name: "profiles",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          ...Array.from({ length: 40 }, (_, index) => ({
            name: `filler_${String(index).padStart(2, "0")}`,
            dataType: "text",
            nullable: true,
            ordinal: index + 2,
          })),
          { name: "profile_alpha", dataType: "text", nullable: true, ordinal: 42 },
          { name: "profile_beta", dataType: "text", nullable: true, ordinal: 43 },
          { name: "profile_gamma", dataType: "text", nullable: true, ordinal: 44 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      }],
    }],
  });
}

function multiEntityCatalog() {
  return finalizeCatalog({
    connectorId: "warehouse",
    dialect: "postgres",
    databaseName: "analytics",
    scannedAt: "2026-08-16T00:00:00.000Z",
    schemas: [{
      name: "analytics",
      tables: [
        {
          schema: "analytics",
          name: "orders",
          kind: "table",
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
            { name: "status", dataType: "text", nullable: false, ordinal: 2 },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        },
        {
          schema: "analytics",
          name: "audit_events",
          kind: "table",
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
            { name: "event_name", dataType: "text", nullable: false, ordinal: 2 },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        },
      ],
    }],
  });
}

describe("vNext data agent runtime", () => {
  test("executes explicit SQL through the connector read boundary", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector, query: { maxRows: 250, timeoutMs: 4_000 } });

    const result = await agent.executeReadSql({
      sql: "SELECT status FROM analytics.orders WHERE id = $1",
      parameters: ["order-1"],
      purpose: "Read one order",
    });

    expect(result.rowCount).toBe(1);
    expect(requests).toEqual([{
      sql: "SELECT status FROM analytics.orders WHERE id = $1",
      parameters: ["order-1"],
      purpose: "Read one order",
      maxRows: 250,
      timeoutMs: 4_000,
    }]);
  });

  test("coalesces catalog discovery when one waiting request is cancelled", async () => {
    const { connector } = harness();
    let introspections = 0;
    let receivedSignal: AbortSignal | undefined;
    let resolveCatalog: ((value: typeof catalog) => void) | undefined;
    const agent = createDataAgent({
      connector: {
        ...connector,
        introspect: async (_options, signal) => {
          introspections += 1;
          receivedSignal = signal;
          return new Promise<typeof catalog>((resolve) => {
            resolveCatalog = resolve;
          });
        },
      },
    });
    const controller = new AbortController();
    const cancelled = agent.inspectCatalog({}, controller.signal);
    const follower = agent.inspectCatalog();

    await Promise.resolve();
    expect(introspections).toBe(1);
    expect(receivedSignal).toBeUndefined();

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    resolveCatalog?.(catalog);

    await expect(follower).resolves.toMatchObject({ cacheStatus: "loaded" });
    await expect(agent.inspectCatalog()).resolves.toMatchObject({ cacheStatus: "hit" });
    expect(introspections).toBe(1);
  });

  test("defaults to administrator visibility for every connector-readable field", async () => {
    const { connector } = harness();
    const agent = createDataAgent({ connector });
    const snapshot = await agent.inspectCatalog();
    const orders = snapshot.semanticCatalog.entities.find((entity) => entity.label === "Orders");

    expect(orders?.fields).toHaveLength(catalog.schemas[0]?.tables[0]?.columns.length ?? 0);
    for (const label of ["Id", "Status", "Total", "Email", "Api Token"]) {
      expect(orders?.fields.find((field) => field.label === label)?.exposure).toBe("bounded-values");
    }
  });

  test("keeps administrator-visible identifier and credential-named fields in the planning catalog", async () => {
    const { connector } = harness();
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog({ query: "email api token id" });
    const orders = planning.semanticCatalog.entities.find((entity) => entity.label === "Orders");

    for (const label of ["Id", "Email", "Api Token"]) {
      expect(orders?.fields.find((field) => field.label === label)?.exposure).toBe("bounded-values");
    }
  });

  test("allows any readable field to participate in a records plan without name-based filtering", async () => {
    const { connector: baseConnector, requests } = harness();
    const connector: DatabaseConnector = {
      ...baseConnector,
      query: async (request) => {
        requests.push(request);
        return {
          queryId: "query_records",
          columns: [
            { name: "out_field_1" },
            { name: "out_field_2" },
            { name: "out_field_3" },
          ],
          rows: [{ out_field_1: "record-id", out_field_2: "person@example.test", out_field_3: "opaque-value" }],
          rowCount: 1,
          truncated: false,
          durationMs: 8,
        };
      },
    };
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog({ query: "email api token id" });
    const primaryEntityId = entityIdFor(catalog, "analytics", "orders");
    const fields = ["id", "email", "api_token"].map((column, index) => ({
      fieldId: fieldIdFor(catalog, "analytics", "orders", column),
      outputId: `out_field_${index + 1}`,
    }));

    await agent.runAnalysis({
      capability: planning.capability,
      draft: {
        version: "2",
        mode: "records",
        primaryEntityId,
        relationshipIds: [],
        fields,
        orderBy: [{ fieldId: fields[0]!.fieldId, direction: "desc" }],
        limit: 10,
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.sql).toContain('"t0"."id"');
    expect(requests[0]?.sql).toContain('"t0"."email"');
    expect(requests[0]?.sql).toContain('"t0"."api_token"');
  });

  test("returns only a model-safe planning catalog to the orchestration layer", async () => {
    const { connector } = harness();
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog({ query: "total" });
    const serialized = JSON.stringify(planning);

    expect("catalog" in planning).toBe(false);
    expect(serialized).not.toContain("analytics.orders");
    expect(serialized).not.toContain("created_at");
    expect(planning.semanticCatalog.entities).toHaveLength(1);
    expect(planning.entityCount).toBe(1);
  });

  test("keeps physical catalog names out of the model catalog and binds driver parameters", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector, requestIdFactory: () => "run_test" });
    const snapshot = await agent.inspectCatalog();
    const modelCatalog = JSON.stringify(snapshot.semanticCatalog);
    expect(modelCatalog).not.toContain("analytics.orders");
    expect(modelCatalog).not.toContain("created_at");

    const planning = await agent.inspectPlanningCatalog();
    const result = await agent.runAnalysis({
      capability: planning.capability,
      draft: revenueDraft(),
    });

    expect(result.execution.queryFingerprint).toMatch(/^query_/u);
    expect(result.columns[0]?.outputId).toBe("out_revenue");
    expect("compiled" in result).toBe(false);
    expect("spec" in result).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      parameters: ["paid"],
      purpose: "Tessera structured analysis",
    });
    expect(requests[0]?.sql).toContain("$1");
    expect(requests[0]?.sql).not.toContain("'paid'");
  });

  test("rejects a raw-SQL-shaped draft before invoking the connector", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog();
    await expect(agent.runAnalysis({
      capability: planning.capability,
      draft: { ...revenueDraft(), sql: "SELECT * FROM analytics.orders" },
    })).rejects.toBeInstanceOf(DataAgentError);
    expect(requests).toHaveLength(0);
  });

  test("normalizes fixed-pipeline binding failures as governed errors", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog();

    await expect(agent.runAnalysis({
      capability: planning.capability,
      draft: { ...revenueDraft(), sql: "SELECT * FROM analytics.orders" },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(0);
  });

  test("rejects a tampered planning capability before invoking the connector", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector });
    const planning = await agent.inspectPlanningCatalog();

    await expect(agent.runAnalysis({
      capability: { token: `${planning.capability.token}x` },
      draft: revenueDraft(),
    })).rejects.toMatchObject({ code: "catalog_stale" });
    expect(requests).toHaveLength(0);
  });

  test("enforces the inspected catalog slice inside the data-agent boundary", async () => {
    const { connector, requests } = harness();
    const scopedCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [
          {
            schema: "analytics",
            name: "orders",
            kind: "table",
            columns: [
              { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
              { name: "total", dataType: "numeric", nullable: false, ordinal: 2 },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
          },
          {
            schema: "analytics",
            name: "audit_events",
            kind: "table",
            columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
            primaryKey: ["id"],
            foreignKeys: [],
          },
        ],
      }],
    });
    const agent = createDataAgent({
      connector: { ...connector, introspect: async () => scopedCatalog },
    });
    const planning = await agent.inspectPlanningCatalog({ query: "total" });

    expect(planning.semanticCatalog.entities.map((entity) => entity.label)).toEqual(["Orders"]);
    await expect(agent.runAnalysis({
      capability: planning.capability,
      draft: {
        version: "2",
        primaryEntityId: entityIdFor(scopedCatalog, "analytics", "audit_events"),
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_events" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(0);
  });

  test("binds a trusted current relation to one model-safe planning scope", async () => {
    const scopedCatalog = multiEntityCatalog();
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector: { ...connector, introspect: async () => scopedCatalog } });
    const context = await agent.inspectRelationPlanningCatalog({
      schema: "analytics",
      table: "orders",
      catalogFingerprint: scopedCatalog.fingerprint,
    });
    const ordersId = entityIdFor(scopedCatalog, "analytics", "orders");
    const auditEventsId = entityIdFor(scopedCatalog, "analytics", "audit_events");

    expect(context.semanticCatalog.entities.map((entity) => entity.id)).toEqual([ordersId]);
    expect(JSON.stringify(context.semanticCatalog)).not.toContain("analytics.orders");
    expect(JSON.stringify(context.semanticCatalog)).not.toContain("\"analytics\"");
    expect(JSON.stringify(context.semanticCatalog)).not.toContain("warehouse");

    await expect(agent.runAnalysis({
      capability: context.capability,
      draft: {
        version: "2",
        primaryEntityId: ordersId,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_orders" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      },
    })).resolves.toMatchObject({ execution: { result: { rowCount: 1 } } });

    await expect(agent.runAnalysis({
      capability: context.capability,
      draft: {
        version: "2",
        primaryEntityId: auditEventsId,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_events" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(1);
  });

  test("rejects stale, missing, and malformed relation context without leaking a physical relation", async () => {
    const { connector, requests } = harness();
    const staleCatalog = multiEntityCatalog();
    const liveCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:01:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "archive",
          kind: "table",
          columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    });
    let currentCatalog = staleCatalog;
    const agent = createDataAgent({ connector: { ...connector, introspect: async () => currentCatalog } });
    currentCatalog = liveCatalog;

    for (const input of [
      { schema: "analytics", table: "orders", catalogFingerprint: staleCatalog.fingerprint },
      { schema: "analytics", table: "orders", catalogFingerprint: liveCatalog.fingerprint },
      { schema: "analytics", table: "orders", catalogFingerprint: "not-a-fingerprint" },
    ]) {
      await expect(agent.inspectRelationPlanningCatalog(input as never)).rejects.toMatchObject({
        code: "invalid_relation_context",
        message: "The selected data context is no longer available.",
      });
    }
    expect(requests).toHaveLength(0);
  });

  test("composes complementary planning scopes without broadening either source slice", async () => {
    const scopedCatalog = wideFieldCatalog();
    const { connector, requests } = harness();
    const agent = createDataAgent({
      connector: {
        ...connector,
        introspect: async () => scopedCatalog,
        query: async (request) => {
          requests.push(request);
          return {
            queryId: "query_composed_scope",
            columns: [{ name: "out_alpha" }, { name: "out_beta" }],
            rows: [{ out_alpha: "a", out_beta: "b" }],
            rowCount: 1,
            truncated: false,
            durationMs: 4,
          } satisfies DatabaseQueryResult;
        },
      },
    });
    const alpha = await agent.inspectPlanningCatalog({ query: "alpha" });
    const beta = await agent.inspectPlanningCatalog({ query: "beta" });
    const alphaFieldId = fieldIdFor(scopedCatalog, "analytics", "profiles", "profile_alpha");
    const betaFieldId = fieldIdFor(scopedCatalog, "analytics", "profiles", "profile_beta");
    const gammaFieldId = fieldIdFor(scopedCatalog, "analytics", "profiles", "profile_gamma");
    const draft = {
      version: "2" as const,
      mode: "records" as const,
      primaryEntityId: entityIdFor(scopedCatalog, "analytics", "profiles"),
      relationshipIds: [],
      fields: [
        { fieldId: alphaFieldId, outputId: "out_alpha" },
        { fieldId: betaFieldId, outputId: "out_beta" },
      ],
      orderBy: [{ fieldId: betaFieldId, direction: "desc" as const }],
      limit: 1,
    };

    expect(alpha.semanticCatalog.entities[0]?.fields.some((field) => field.id === alphaFieldId)).toBe(true);
    expect(alpha.semanticCatalog.entities[0]?.fields.some((field) => field.id === betaFieldId)).toBe(false);
    expect(beta.semanticCatalog.entities[0]?.fields.some((field) => field.id === alphaFieldId)).toBe(false);
    expect(beta.semanticCatalog.entities[0]?.fields.some((field) => field.id === betaFieldId)).toBe(true);
    expect(alpha.semanticCatalog.entities[0]?.fields.some((field) => field.id === gammaFieldId)).toBe(false);
    expect(beta.semanticCatalog.entities[0]?.fields.some((field) => field.id === gammaFieldId)).toBe(false);
    await expect(agent.runAnalysis({ capability: alpha.capability, draft })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    await expect(agent.runAnalysis({ capability: beta.capability, draft })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(0);

    const capability = await agent.composePlanningCapabilities({
      capabilities: [alpha.capability, beta.capability],
    });
    await expect(agent.runAnalysis({ capability, draft })).resolves.toMatchObject({
      execution: { result: { rows: [{ out_alpha: "a", out_beta: "b" }] } },
    });
    await expect(agent.runAnalysis({
      capability,
      draft: {
        ...draft,
        fields: [...draft.fields, { fieldId: gammaFieldId, outputId: "out_gamma" }],
      },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(1);
  });

  test("describes an inspected entity with its bounded fields and issues authority for the expansion", async () => {
    const scopedCatalog = wideFieldCatalog();
    const { connector, requests } = harness();
    const agent = createDataAgent({
      connector: {
        ...connector,
        introspect: async () => scopedCatalog,
        query: async (request) => {
          requests.push(request);
          return {
            queryId: "query_described_field",
            columns: [{ name: "out_beta" }],
            rows: [{ out_beta: "beta" }],
            rowCount: 1,
            truncated: false,
            durationMs: 4,
          } satisfies DatabaseQueryResult;
        },
      },
    });
    const planning = await agent.inspectPlanningCatalog({ query: "alpha" });
    const entityId = entityIdFor(scopedCatalog, "analytics", "profiles");
    const betaFieldId = fieldIdFor(scopedCatalog, "analytics", "profiles", "profile_beta");

    expect(planning.semanticCatalog.entities[0]?.fields.some((field) => field.id === betaFieldId)).toBe(false);

    const described = await agent.describePlanningCatalog({
      capability: planning.capability,
      entityIds: [entityId],
    });
    expect(described.semanticCatalog.entities).toHaveLength(1);
    expect(described.semanticCatalog.entities[0]?.fields.some((field) => field.id === betaFieldId)).toBe(true);

    await expect(agent.runAnalysis({
      capability: described.capability,
      draft: {
        version: "2",
        mode: "records",
        primaryEntityId: entityId,
        relationshipIds: [],
        fields: [{ fieldId: betaFieldId, outputId: "out_beta" }],
        orderBy: [{ fieldId: betaFieldId, direction: "desc" }],
        limit: 1,
      },
    })).resolves.toMatchObject({ execution: { result: { rows: [{ out_beta: "beta" }] } } });
    expect(requests).toHaveLength(1);
  });

  test("rejects describing an entity that was not returned by the inspected planning scope", async () => {
    const scopedCatalog = multiEntityCatalog();
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector: { ...connector, introspect: async () => scopedCatalog } });
    const planning = await agent.inspectPlanningCatalog({ query: "status" });
    const auditEventsId = entityIdFor(scopedCatalog, "analytics", "audit_events");

    expect(planning.semanticCatalog.entities.map((entity) => entity.id)).not.toContain(auditEventsId);
    await expect(agent.describePlanningCatalog({
      capability: planning.capability,
      entityIds: [auditEventsId],
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(0);
  });

  test("runs discovery probes through the typed compiler with a fixed value-domain bound", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({
      connector: {
        ...connector,
        query: async (request) => {
          requests.push(request);
          return {
            queryId: "query_value_domain",
            columns: [{ name: "out_value" }, { name: "out_count" }],
            rows: [{ out_value: "paid", out_count: 42 }],
            rowCount: 1,
            truncated: false,
            durationMs: 4,
          } satisfies DatabaseQueryResult;
        },
      },
    });
    const planning = await agent.inspectPlanningCatalog({ query: "status" });
    const statusFieldId = fieldIdFor(catalog, "analytics", "orders", "status");

    await expect(agent.probePlanningData({
      capability: planning.capability,
      probe: { kind: "value-domain", fieldId: statusFieldId, candidates: ["paid"] },
    })).resolves.toMatchObject({
      probe: { kind: "value-domain", fieldId: statusFieldId, candidates: ["paid"] },
      execution: { result: { rows: [{ out_value: "paid", out_count: 42 }] } },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      parameters: ["paid"],
      purpose: "Tessera governed discovery probe",
      maxRows: DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES,
    });
    expect(requests[0]?.sql).toContain("GROUP BY 1 ORDER BY 2 DESC, 1 ASC");
    expect(requests[0]?.sql).toContain(`LIMIT ${DATA_AGENT_DISCOVERY_PROBE_MAX_VALUES}`);

    await expect(agent.probePlanningData({
      capability: planning.capability,
      probe: { kind: "value-domain", fieldId: statusFieldId, sql: "SELECT * FROM orders" },
    } as never)).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(1);
  });

  test("rejects unauthorized and cross-entity discovery field profiles before querying", async () => {
    const scopedCatalog = multiEntityCatalog();
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector: { ...connector, introspect: async () => scopedCatalog } });
    const statusFieldId = fieldIdFor(scopedCatalog, "analytics", "orders", "status");
    const eventNameFieldId = fieldIdFor(scopedCatalog, "analytics", "audit_events", "event_name");
    const ordersOnly = await agent.inspectPlanningCatalog({ query: "status" });

    await expect(agent.probePlanningData({
      capability: ordersOnly.capability,
      probe: { kind: "field-profile", fieldIds: [eventNameFieldId] },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });

    const broadScope = await agent.inspectPlanningCatalog();
    await expect(agent.probePlanningData({
      capability: broadScope.capability,
      probe: { kind: "field-profile", fieldIds: [statusFieldId, eventNameFieldId] },
    })).rejects.toMatchObject({ code: "invalid_analysis_spec" });
    expect(requests).toHaveLength(0);
  });

  test("rejects expired planning capabilities during composition", async () => {
    const { connector } = harness();
    let currentTime = new Date("2026-08-16T00:00:00.000Z");
    const agent = createDataAgent({ connector, now: () => currentTime });
    const first = await agent.inspectPlanningCatalog({ query: "status" });
    const second = await agent.inspectPlanningCatalog({ query: "total" });

    const composed = await agent.composePlanningCapabilities({
      capabilities: [first.capability, second.capability],
    });
    currentTime = new Date(currentTime.getTime() + 60 * 1_000 + 1);
    await expect(agent.runAnalysis({
      capability: composed,
      draft: revenueDraft(),
    })).rejects.toMatchObject({ code: "catalog_stale" });

    currentTime = new Date(currentTime.getTime() + 4 * 60 * 1_000);
    await expect(agent.composePlanningCapabilities({
      capabilities: [first.capability, second.capability],
    })).rejects.toMatchObject({ code: "catalog_stale" });
  });

  test("rejects tampered capabilities and caller-supplied scope during composition", async () => {
    const { connector } = harness();
    const agent = createDataAgent({ connector });
    const first = await agent.inspectPlanningCatalog({ query: "status" });
    const second = await agent.inspectPlanningCatalog({ query: "total" });

    await expect(agent.composePlanningCapabilities({
      capabilities: [first.capability, { token: `${second.capability.token}x` }],
    })).rejects.toMatchObject({ code: "catalog_stale" });
    await expect(agent.composePlanningCapabilities({
      capabilities: [first.capability, second.capability],
      entityIds: [entityIdFor(catalog, "analytics", "orders")],
    } as never)).rejects.toMatchObject({ code: "catalog_stale" });
  });

  test("rejects planning capabilities from a previous catalog fingerprint during composition", async () => {
    const { connector } = harness();
    let currentCatalog = catalog;
    const agent = createDataAgent({
      connector: { ...connector, introspect: async () => currentCatalog },
    });
    const previous = await agent.inspectPlanningCatalog({ query: "total" });
    currentCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:01:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "accounts",
          kind: "table",
          columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    });
    await agent.inspectCatalog({ refresh: true });
    const current = await agent.inspectPlanningCatalog({ query: "accounts" });

    await expect(agent.composePlanningCapabilities({
      capabilities: [previous.capability, current.capability],
    })).rejects.toMatchObject({ code: "catalog_stale" });
  });

  test("previews only live catalog columns with a fixed PostgreSQL bound", async () => {
    const { connector, requests } = harness();
    const agent = createDataAgent({ connector });
    const preview = await agent.previewRelation({
      schema: "analytics",
      table: "orders",
      columns: ["status", "total"],
    });

    expect(preview).toMatchObject({
      relation: { schema: "analytics", table: "orders" },
      columns: ["status", "total"],
      limit: DATA_AGENT_RELATION_PREVIEW_LIMIT,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sql: 'SELECT "status", "total"\nFROM "analytics"."orders"\nLIMIT 100',
      parameters: [],
      purpose: "Tessera relation preview",
      maxRows: DATA_AGENT_RELATION_PREVIEW_LIMIT,
    });
  });

  test("revalidates a relation preview after the host refreshes the live catalog", async () => {
    const { connector, requests } = harness();
    let currentCatalog = catalog;
    const agent = createDataAgent({
      connector: { ...connector, introspect: async () => currentCatalog },
    });
    await agent.inspectCatalog();
    currentCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:01:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "archive",
          kind: "table",
          columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    });
    await agent.inspectCatalog({ refresh: true });

    try {
      await agent.previewRelation({
        schema: "analytics",
        table: "orders",
        columns: ["status"],
        refresh: true,
      });
      throw new Error("Expected a relation preview against a removed table to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(DataAgentError);
      expect((error as DataAgentError).code).toBe("invalid_relation_preview");
    }
    expect(requests).toHaveLength(0);
  });

  test("uses MySQL identifier quoting for relation previews", async () => {
    const requests: DatabaseQueryRequest[] = [];
    const mysqlCatalog = finalizeCatalog({
      connectorId: "warehouse-mysql",
      dialect: "mysql",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "orders",
          kind: "table",
          columns: [{ name: "select", dataType: "text", nullable: false, ordinal: 1 }],
          primaryKey: [],
          foreignKeys: [],
        }],
      }],
    });
    const connector: DatabaseConnector = {
      id: "warehouse-mysql",
      dialect: "mysql",
      assess: async () => ({
        connectorId: "warehouse-mysql",
        dialect: "mysql",
        connected: true,
        readOnlyTransactions: true,
        warnings: [],
      }),
      introspect: async () => mysqlCatalog,
      query: async (request) => {
        requests.push(request);
        return {
          queryId: "preview_1",
          columns: [{ name: "select" }],
          rows: [{ select: "paid" }],
          rowCount: 1,
          truncated: false,
          durationMs: 4,
        };
      },
      close: async () => {},
    };

    const agent = createDataAgent({ connector });
    await agent.previewRelation({ schema: "analytics", table: "orders", columns: ["select"] });
    expect(requests[0]?.sql).toBe("SELECT `select`\nFROM `analytics`.`orders`\nLIMIT 100");
  });

  test("emits the complete structured execution lifecycle", async () => {
    const { connector } = harness();
    const agent = createDataAgent({ connector, requestIdFactory: () => "run_trace" });
    const planning = await agent.inspectPlanningCatalog();
    const stages: string[] = [];
    const result = await agent.runAnalysis({
      capability: planning.capability,
      draft: revenueDraft(),
      onEvent: (event) => {
        stages.push(`${event.stage}:${event.status}`);
      },
    });

    expect(result.columns).toEqual([expect.objectContaining({ outputId: "out_revenue" })]);
    expect(stages).toEqual([
      "catalog:started", "catalog:completed",
      "semantic:started", "semantic:completed",
      "binding:started", "binding:completed",
      "compiling:started", "compiling:completed",
      "executing:started", "executing:completed",
      "verifying:started", "verifying:completed",
    ]);
  });
});
