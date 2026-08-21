import { describe, expect, test } from "bun:test";
import { finalizeCatalog } from "@data-elements/database";
import {
  AnalysisCompilerError,
  bindAnalysisDraft,
  compileAnalysisSpec,
  compileTypedProbe,
  createSemanticCatalog,
  entityIdFor,
  fieldIdFor,
  planTypedProbes,
} from "./compiler";

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
        { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2 },
        { name: "status", dataType: "text", nullable: false, ordinal: 3 },
        { name: "total", dataType: "numeric", nullable: false, ordinal: 4 },
      ],
      primaryKey: ["id"],
      foreignKeys: [],
    }],
  }],
});

const entityId = entityIdFor(catalog, "analytics", "orders");
const idId = fieldIdFor(catalog, "analytics", "orders", "id");
const createdAtId = fieldIdFor(catalog, "analytics", "orders", "created_at");
const statusId = fieldIdFor(catalog, "analytics", "orders", "status");
const totalId = fieldIdFor(catalog, "analytics", "orders", "total");

const fanoutCatalog = finalizeCatalog({
  connectorId: "warehouse",
  dialect: "postgres",
  databaseName: "analytics",
  scannedAt: "2026-08-16T00:00:00.000Z",
  schemas: [{
    name: "analytics",
    tables: [
      {
        schema: "analytics",
        name: "customers",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "credit_limit", dataType: "numeric", nullable: false, ordinal: 2 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      },
      {
        schema: "analytics",
        name: "orders",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "customer_id", dataType: "uuid", nullable: false, ordinal: 2 },
          { name: "total", dataType: "numeric", nullable: false, ordinal: 3 },
        ],
        primaryKey: ["id"],
        foreignKeys: [{
          name: "orders_customer_id_fkey",
          columns: ["customer_id"],
          referencedSchema: "analytics",
          referencedTable: "customers",
          referencedColumns: ["id"],
        }],
      },
      {
        schema: "analytics",
        name: "order_items",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "order_id", dataType: "uuid", nullable: false, ordinal: 2 },
        ],
        primaryKey: ["id"],
        foreignKeys: [{
          name: "order_items_order_id_fkey",
          columns: ["order_id"],
          referencedSchema: "analytics",
          referencedTable: "orders",
          referencedColumns: ["id"],
        }],
      },
    ],
  }],
});

const customerEntityId = entityIdFor(fanoutCatalog, "analytics", "customers");
const orderEntityId = entityIdFor(fanoutCatalog, "analytics", "orders");
const orderItemEntityId = entityIdFor(fanoutCatalog, "analytics", "order_items");
const customerId = fieldIdFor(fanoutCatalog, "analytics", "customers", "id");
const creditLimitId = fieldIdFor(fanoutCatalog, "analytics", "customers", "credit_limit");
const orderTotalId = fieldIdFor(fanoutCatalog, "analytics", "orders", "total");
const fanoutSemanticCatalog = createSemanticCatalog(fanoutCatalog);
const ordersToCustomers = fanoutSemanticCatalog.relationships.find((relationship) => (
  relationship.fromEntityId === orderEntityId && relationship.toEntityId === customerEntityId
));
const customerCountMetric = fanoutSemanticCatalog.entities
  .find((entity) => entity.id === customerEntityId)
  ?.metrics.find((metric) => metric.aggregate === "count");
const itemsToOrders = fanoutSemanticCatalog.relationships.find((relationship) => (
  relationship.fromEntityId === orderItemEntityId && relationship.toEntityId === orderEntityId
));

if (!ordersToCustomers || !customerCountMetric || !itemsToOrders) {
  throw new Error("Expected the fan-out test catalog to contain its relationships and customer metric.");
}

function bindFanoutDraft(draft: unknown) {
  return bindAnalysisDraft({ catalog: fanoutCatalog, semanticCatalog: fanoutSemanticCatalog, draft });
}

function expectFanoutRejection(draft: unknown): void {
  try {
    bindFanoutDraft(draft);
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisCompilerError);
    expect((error as AnalysisCompilerError).code).toBe("invalid_analysis_spec");
    return;
  }
  throw new Error("Expected the aggregate to be rejected for join fan-out.");
}

describe("vNext analysis compiler", () => {
  test("binds opaque IDs and compiles parameterized PostgreSQL without model SQL", () => {
    const semanticCatalog = createSemanticCatalog(catalog, {
      manifestId: "analytics",
      revision: "1",
      entities: [{
        relation: { schema: "analytics", table: "orders" },
        label: "Orders",
        aliases: ["orders", "订单"],
        defaultTimeColumn: "created_at",
        fields: [{ column: "status", aliases: ["state", "状态"] }],
      }],
    });
    expect(JSON.stringify(semanticCatalog)).not.toContain("analytics.orders");
    expect(JSON.stringify(semanticCatalog)).not.toContain("created_at");

    const spec = bindAnalysisDraft({
      catalog,
      semanticCatalog,
      now: new Date("2026-08-16T00:00:00.000Z"),
      draft: {
        version: "2",
        primaryEntityId: entityId,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "sum", fieldId: totalId, outputId: "out_revenue" }],
        dimensions: [{ kind: "time", fieldId: createdAtId, grain: "day", outputId: "out_day" }],
        filter: { kind: "comparison", fieldId: statusId, op: "eq", value: "paid" },
        orderBy: [{ outputId: "out_day", direction: "asc" }],
        output: "series",
        limit: 50,
      },
    });
    const compiled = compileAnalysisSpec({ catalog, semanticCatalog, spec });

    expect(spec.mode).toBe("aggregate");
    expect(compiled.sql).toContain('DATE_TRUNC(\'day\', "t0"."created_at")');
    expect(compiled.sql).toContain('SUM("t0"."total")');
    expect(compiled.sql).toContain('"t0"."status" = $1');
    expect(compiled.sql).toContain('LIMIT 50');
    expect(compiled.parameters).toEqual(["paid"]);
    expect(compiled.sourceRelationIds).toHaveLength(1);
    expect(compiled.resultColumns.map((column) => column.outputId)).toEqual(["out_day", "out_revenue"]);
  });

  test("compiles SQLite SQL for local SQLite and Turso", () => {
    for (const dialect of ["sqlite", "turso"] as const) {
      const sqliteCatalog = finalizeCatalog({
        connectorId: "warehouse-" + dialect,
        dialect,
        databaseName: "analytics",
        scannedAt: "2026-08-16T00:00:00.000Z",
        schemas: structuredClone(catalog.schemas),
      });
      const semanticCatalog = createSemanticCatalog(sqliteCatalog);
      const sqliteEntityId = entityIdFor(sqliteCatalog, "analytics", "orders");
      const sqliteCreatedAtId = fieldIdFor(sqliteCatalog, "analytics", "orders", "created_at");
      const sqliteStatusId = fieldIdFor(sqliteCatalog, "analytics", "orders", "status");
      const sqliteTotalId = fieldIdFor(sqliteCatalog, "analytics", "orders", "total");
      const spec = bindAnalysisDraft({
        catalog: sqliteCatalog,
        semanticCatalog,
        draft: {
          version: "2",
          primaryEntityId: sqliteEntityId,
          relationshipIds: [],
          measures: [{
            kind: "aggregate",
            aggregate: "sum",
            fieldId: sqliteTotalId,
            outputId: "out_revenue",
          }],
          dimensions: [{
            kind: "time",
            fieldId: sqliteCreatedAtId,
            grain: "month",
            outputId: "out_month",
          }],
          filter: {
            kind: "comparison",
            fieldId: sqliteStatusId,
            op: "eq",
            value: "paid",
          },
          orderBy: [{ outputId: "out_month", direction: "asc" }],
          output: "series",
          limit: 25,
        },
      });
      const compiled = compileAnalysisSpec({
        catalog: sqliteCatalog,
        semanticCatalog,
        spec,
      });

      expect(compiled.sql).toContain("strftime('%Y-%m-01', \"t0\".\"created_at\")");
      expect(compiled.sql).toContain("\"t0\".\"status\" = ?");
      expect(compiled.sql).not.toContain("$1");
      expect(compiled.sql).not.toContain(String.fromCharCode(96));
      expect(compiled.parameters).toEqual(["paid"]);
    }
  });

  test("compiles an explicitly ordered row-level query without grouping", () => {
    const semanticCatalog = createSemanticCatalog(catalog);
    const spec = bindAnalysisDraft({
      catalog,
      semanticCatalog,
      draft: {
        version: "2",
        mode: "records",
        primaryEntityId: entityId,
        relationshipIds: [],
        fields: [
          { fieldId: idId, outputId: "out_id" },
          { fieldId: statusId, outputId: "out_status" },
        ],
        filter: { kind: "comparison", fieldId: statusId, op: "eq", value: "active" },
        orderBy: [{ fieldId: createdAtId, direction: "desc" }],
        limit: 1,
      },
    });
    const compiled = compileAnalysisSpec({ catalog, semanticCatalog, spec });

    expect(spec.mode).toBe("records");
    expect(compiled.sql).toContain('SELECT "t0"."id" AS "out_id", "t0"."status" AS "out_status"');
    expect(compiled.sql).toContain('"t0"."status" = $1');
    expect(compiled.sql).toContain('ORDER BY "t0"."created_at" DESC');
    expect(compiled.sql).toContain("LIMIT 1");
    expect(compiled.sql).not.toContain("GROUP BY");
    expect(compiled.sql).not.toContain('"out_created_at" ASC');
    expect(compiled.parameters).toEqual(["active"]);
    expect(compiled.resultColumns.map((column) => column.outputId)).toEqual(["out_id", "out_status"]);
  });

  test("rejects a row-level query without an explicit ordering", () => {
    const semanticCatalog = createSemanticCatalog(catalog);
    expect(() => bindAnalysisDraft({
      catalog,
      semanticCatalog,
      draft: {
        version: "2",
        mode: "records",
        primaryEntityId: entityId,
        relationshipIds: [],
        fields: [{ fieldId: idId, outputId: "out_id" }],
        orderBy: [],
        limit: 10,
      },
    })).toThrow(AnalysisCompilerError);
  });

  test("counts a joined metric through its own non-null primary key", () => {
    const joinedCatalog = finalizeCatalog({
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
              { name: "customer_id", dataType: "uuid", nullable: false, ordinal: 2 },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
          },
          {
            schema: "analytics",
            name: "customers",
            kind: "table",
            columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
            primaryKey: ["id"],
            foreignKeys: [],
          },
        ],
      }],
    });
    const semanticCatalog = createSemanticCatalog(joinedCatalog, {
      relationships: [{
        from: { schema: "analytics", table: "orders" },
        to: { schema: "analytics", table: "customers" },
        pairs: [{ fromColumn: "customer_id", toColumn: "id" }],
        cardinality: "one-to-one",
      }],
    });
    const orders = entityIdFor(joinedCatalog, "analytics", "orders");
    const customers = entityIdFor(joinedCatalog, "analytics", "customers");
    const relationship = semanticCatalog.relationships[0];
    const customerCount = semanticCatalog.entities
      .find((entity) => entity.id === customers)
      ?.metrics.find((metric) => metric.aggregate === "count");
    if (!relationship || !customerCount) throw new Error("Expected a trusted relationship and customer count metric.");

    const spec = bindAnalysisDraft({
      catalog: joinedCatalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: orders,
        relationshipIds: [relationship.id],
        measures: [{ kind: "metric", metricId: customerCount.id, outputId: "out_customer_count" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      },
    });
    const compiled = compileAnalysisSpec({ catalog: joinedCatalog, semanticCatalog, spec });

    expect(compiled.sql).toContain('COUNT("t1"."id")');
    expect(compiled.sql).not.toContain("COUNT(*)");
  });

  test("rejects a joined count metric without a non-null primary key", () => {
    const joinedCatalog = finalizeCatalog({
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
              { name: "customer_id", dataType: "uuid", nullable: false, ordinal: 2 },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
          },
          {
            schema: "analytics",
            name: "customers",
            kind: "table",
            columns: [{ name: "id", dataType: "uuid", nullable: true, ordinal: 1 }],
            primaryKey: ["id"],
            foreignKeys: [],
          },
        ],
      }],
    });
    const semanticCatalog = createSemanticCatalog(joinedCatalog, {
      relationships: [{
        from: { schema: "analytics", table: "orders" },
        to: { schema: "analytics", table: "customers" },
        pairs: [{ fromColumn: "customer_id", toColumn: "id" }],
        cardinality: "one-to-one",
      }],
    });
    const orders = entityIdFor(joinedCatalog, "analytics", "orders");
    const customers = entityIdFor(joinedCatalog, "analytics", "customers");
    const relationship = semanticCatalog.relationships[0];
    const customerCount = semanticCatalog.entities
      .find((entity) => entity.id === customers)
      ?.metrics.find((metric) => metric.aggregate === "count");
    if (!relationship || !customerCount) throw new Error("Expected a trusted relationship and customer count metric.");

    let error: unknown;
    try {
      bindAnalysisDraft({
        catalog: joinedCatalog,
        semanticCatalog,
        draft: {
          version: "2",
          primaryEntityId: orders,
          relationshipIds: [relationship.id],
          measures: [{ kind: "metric", metricId: customerCount.id, outputId: "out_customer_count" }],
          dimensions: [],
          orderBy: [],
          output: "scalar",
          limit: 1,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AnalysisCompilerError);
    expect((error as AnalysisCompilerError).code).toBe("invalid_analysis_spec");
  });

  test("plans and compiles only typed probes", () => {
    const semanticCatalog = createSemanticCatalog(catalog);
    const spec = bindAnalysisDraft({
      catalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: entityId,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_count" }],
        dimensions: [{ kind: "time", fieldId: createdAtId, grain: "day", outputId: "out_day" }],
        filter: { kind: "comparison", fieldId: statusId, op: "eq", value: "paid" },
        orderBy: [{ outputId: "out_day", direction: "asc" }],
        output: "series",
        limit: 20,
      },
    });
    const plan = planTypedProbes(spec, semanticCatalog);
    expect(plan.probes).toHaveLength(2);
    expect(plan.probes.map((probe) => probe.kind)).toEqual(["time-bounds", "value-domain"]);
    const domain = plan.probes.find((probe) => probe.kind === "value-domain");
    if (!domain || domain.kind !== "value-domain") throw new Error("Expected value-domain probe.");
    const compiled = compileTypedProbe({ catalog, semanticCatalog, spec, probe: domain });
    expect(compiled.sql).toContain("GROUP BY 1 ORDER BY 2 DESC, 1 ASC");
    expect(compiled.parameters).toEqual(["paid"]);
  });

  test("rejects a forged opaque ID before SQL compilation", () => {
    const semanticCatalog = createSemanticCatalog(catalog);
    expect(() => bindAnalysisDraft({
      catalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: "ent_aaaaaaaaaaaaaaaaaaaaaaaa",
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_count" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      },
    })).toThrow(AnalysisCompilerError);
  });

  test("rejects direct SQL fields at the model boundary", () => {
    const semanticCatalog = createSemanticCatalog(catalog);
    expect(() => bindAnalysisDraft({
      catalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: entityId,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_count" }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
        sql: "SELECT * FROM analytics.orders",
      },
    })).toThrow();
  });

  test("rejects a raw count when a selected join can multiply the primary entity", () => {
    expectFanoutRejection({
      version: "2",
      primaryEntityId: customerEntityId,
      relationshipIds: [ordersToCustomers.id],
      measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_customer_count" }],
      dimensions: [],
      orderBy: [],
      output: "scalar",
      limit: 1,
    });
  });

  test("allows aggregates whose entity is not multiplied by the selected join", () => {
    const orderCount = bindFanoutDraft({
      version: "2",
      primaryEntityId: orderEntityId,
      relationshipIds: [ordersToCustomers.id],
      measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_order_count" }],
      dimensions: [],
      orderBy: [],
      output: "scalar",
      limit: 1,
    });
    const orderRevenue = bindFanoutDraft({
      version: "2",
      primaryEntityId: customerEntityId,
      relationshipIds: [ordersToCustomers.id],
      measures: [{ kind: "aggregate", aggregate: "sum", fieldId: orderTotalId, outputId: "out_order_revenue" }],
      dimensions: [],
      orderBy: [],
      output: "scalar",
      limit: 1,
    });

    expect(orderCount.primaryEntityId).toBe(orderEntityId);
    expect(orderRevenue.primaryEntityId).toBe(customerEntityId);
  });

  test("uses the aggregate field or metric owner when protecting against fan-out", () => {
    for (const aggregate of ["sum", "avg"] as const) {
      expectFanoutRejection({
        version: "2",
        primaryEntityId: orderEntityId,
        relationshipIds: [ordersToCustomers.id],
        measures: [{ kind: "aggregate", aggregate, fieldId: creditLimitId, outputId: `out_customer_${aggregate}` }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      });
    }
    expectFanoutRejection({
      version: "2",
      primaryEntityId: orderEntityId,
      relationshipIds: [ordersToCustomers.id],
      measures: [{ kind: "metric", metricId: customerCountMetric.id, outputId: "out_customer_rows" }],
      dimensions: [],
      orderBy: [],
      output: "scalar",
      limit: 1,
    });
  });

  test("detects fan-out after a safe edge in a selected relationship tree", () => {
    expectFanoutRejection({
      version: "2",
      primaryEntityId: customerEntityId,
      relationshipIds: [ordersToCustomers.id, itemsToOrders.id],
      measures: [{ kind: "aggregate", aggregate: "sum", fieldId: orderTotalId, outputId: "out_order_revenue" }],
      dimensions: [],
      orderBy: [],
      output: "scalar",
      limit: 1,
    });
  });

  test("allows fan-out-stable count distinct and extrema aggregates", () => {
    const stableMeasures = [
      { aggregate: "count_distinct", fieldId: customerId, outputId: "out_customer_distinct" },
      { aggregate: "min", fieldId: creditLimitId, outputId: "out_customer_min" },
      { aggregate: "max", fieldId: creditLimitId, outputId: "out_customer_max" },
    ] as const;

    for (const measure of stableMeasures) {
      const spec = bindFanoutDraft({
        version: "2",
        primaryEntityId: orderEntityId,
        relationshipIds: [ordersToCustomers.id],
        measures: [{ kind: "aggregate", ...measure }],
        dimensions: [],
        orderBy: [],
        output: "scalar",
        limit: 1,
      });
      if (spec.mode !== "aggregate") throw new Error("Expected an aggregate spec.");
      expect(spec.measures[0]?.outputId).toBe(measure.outputId);
    }
  });
});

describe("MongoDB analysis compiler", () => {
  const mongoCatalog = finalizeCatalog({
    connectorId: "mongodb:localhost/analytics",
    dialect: "mongodb",
    databaseName: "analytics",
    scannedAt: "2026-08-20T00:00:00.000Z",
    schemas: [{
      name: "analytics",
      tables: [{
        schema: "analytics",
        name: "orders",
        kind: "collection",
        columns: [
          { name: "_id", dataType: "objectId", nullable: false, ordinal: 1 },
          { name: "createdAt", dataType: "datetime", nullable: false, ordinal: 2 },
          { name: "status", dataType: "string", nullable: false, ordinal: 3 },
          { name: "total", dataType: "decimal", nullable: false, ordinal: 4 },
        ],
        primaryKey: ["_id"],
        foreignKeys: [],
      }],
    }],
  });
  const mongoEntity = entityIdFor(mongoCatalog, "analytics", "orders");
  const mongoCreatedAt = fieldIdFor(mongoCatalog, "analytics", "orders", "createdAt");
  const mongoStatus = fieldIdFor(mongoCatalog, "analytics", "orders", "status");
  const mongoTotal = fieldIdFor(mongoCatalog, "analytics", "orders", "total");

  test("compiles a semantic aggregate to a native read-only pipeline", () => {
    const semanticCatalog = createSemanticCatalog(mongoCatalog);
    const spec = bindAnalysisDraft({
      catalog: mongoCatalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: mongoEntity,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "sum", fieldId: mongoTotal, outputId: "out_revenue" }],
        dimensions: [{ kind: "time", fieldId: mongoCreatedAt, grain: "day", outputId: "out_day" }],
        filter: { kind: "comparison", fieldId: mongoStatus, op: "eq", value: "paid" },
        orderBy: [{ outputId: "out_day", direction: "asc" }],
        output: "series",
        limit: 50,
      },
    });
    const compiled = compileAnalysisSpec({ catalog: mongoCatalog, semanticCatalog, spec });
    if (compiled.kind !== "mongodb") throw new Error("Expected a MongoDB compiled query.");

    expect(compiled.database).toBe("analytics");
    expect(compiled.collection).toBe("orders");
    expect(compiled.pipeline).toEqual([
      { $match: { $expr: { $eq: ["$status", "paid"] } } },
      { $group: {
        _id: { out_day: { $dateTrunc: { date: "$createdAt", unit: "day" } } },
        __measure_0: { $sum: "$total" },
      } },
      { $project: { _id: 0, out_day: "$_id.out_day", out_revenue: "$__measure_0" } },
      { $sort: { out_day: 1 } },
      { $limit: 50 },
    ]);
    expect(compiled.resultColumns.map(({ outputId }) => outputId)).toEqual(["out_day", "out_revenue"]);
  });

  test("compiles typed value-domain probes without SQL", () => {
    const semanticCatalog = createSemanticCatalog(mongoCatalog);
    const spec = bindAnalysisDraft({
      catalog: mongoCatalog,
      semanticCatalog,
      draft: {
        version: "2",
        primaryEntityId: mongoEntity,
        relationshipIds: [],
        measures: [{ kind: "aggregate", aggregate: "count", outputId: "out_count" }],
        dimensions: [{ kind: "field", fieldId: mongoStatus, outputId: "out_status" }],
        filter: { kind: "comparison", fieldId: mongoStatus, op: "eq", value: "paid" },
        orderBy: [{ outputId: "out_count", direction: "desc" }],
        output: "ranking",
        limit: 20,
      },
    });
    const plan = planTypedProbes(spec, semanticCatalog);
    const probe = plan.probes.find((candidate) => candidate.kind === "value-domain");
    if (!probe) throw new Error("Expected a MongoDB value-domain probe.");
    const compiled = compileTypedProbe({ catalog: mongoCatalog, semanticCatalog, spec, probe });
    if (compiled.kind !== "mongodb") throw new Error("Expected a MongoDB compiled query.");
    expect(JSON.stringify(compiled.pipeline)).toContain("$group");
    expect(compiled.sql).toBeUndefined();
  });
});
