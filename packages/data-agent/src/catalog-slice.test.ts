import { describe, expect, test } from "bun:test";
import { finalizeCatalog } from "@data-elements/database";
import { describeSemanticCatalog, sliceSemanticCatalog } from "./catalog-slice";
import { createSemanticCatalog } from "./compiler";

const catalog = finalizeCatalog({
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
          { name: "created_at", dataType: "timestamp", nullable: false, ordinal: 3 },
          { name: "total", dataType: "numeric", nullable: false, ordinal: 4 },
          { name: "internal_note", dataType: "text", nullable: true, ordinal: 5 },
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
        name: "customers",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "name", dataType: "text", nullable: false, ordinal: 2 },
          { name: "region", dataType: "text", nullable: false, ordinal: 3 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      },
      {
        schema: "analytics",
        name: "products",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "sku", dataType: "text", nullable: false, ordinal: 2 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      },
    ],
  }],
});

const semanticCatalog = createSemanticCatalog(catalog, {
  entities: [
    {
      relation: { schema: "analytics", table: "orders" },
      label: "订单",
      aliases: ["销售订单"],
      defaultTimeColumn: "created_at",
      fields: [
        { column: "customer_id", label: "客户标识", aliases: ["客户"] },
        { column: "total", label: "收入", aliases: ["销售额"] },
      ],
      metrics: [{ key: "revenue", label: "收入", aggregate: "sum", column: "total" }],
    },
    {
      relation: { schema: "analytics", table: "customers" },
      label: "客户",
      aliases: ["客户维度"],
      fields: [{ column: "name", label: "客户名称" }],
    },
    {
      relation: { schema: "analytics", table: "products" },
      label: "商品",
      fields: [{ column: "sku", label: "商品编号" }],
    },
  ],
});

describe("semantic catalog planning slice", () => {
  test("retrieves Chinese business labels and preserves every selected join pair", () => {
    const slice = sliceSemanticCatalog(semanticCatalog, {
      query: "按客户查看收入",
      maxEntities: 2,
      maxFieldsPerEntity: 3,
      maxMetricsPerEntity: 2,
      maxRelationships: 4,
    });

    expect(slice.truncated).toBe(true);
    expect(slice.catalog.entities).toHaveLength(2);
    expect(slice.catalog.entities.map((entity) => entity.label)).toEqual(expect.arrayContaining(["订单", "客户"]));
    expect(slice.catalog.entities.flatMap((entity) => entity.fields.map((field) => field.label))).toContain("收入");
    expect(slice.catalog.relationships).toHaveLength(1);

    for (const relationship of slice.catalog.relationships) {
      const from = slice.catalog.entities.find((entity) => entity.id === relationship.fromEntityId);
      const to = slice.catalog.entities.find((entity) => entity.id === relationship.toEntityId);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      for (const pair of relationship.pairs) {
        expect(from?.fields.some((field) => field.id === pair.fromFieldId)).toBe(true);
        expect(to?.fields.some((field) => field.id === pair.toFieldId)).toBe(true);
      }
    }
  });

  test("keeps the time and measure dependencies that make a retained metric usable", () => {
    const slice = sliceSemanticCatalog(semanticCatalog, {
      query: "收入趋势",
      maxEntities: 2,
      maxFieldsPerEntity: 3,
      maxMetricsPerEntity: 2,
    });
    const orders = slice.catalog.entities.find((entity) => entity.label === "订单");
    const revenue = orders?.metrics.find((metric) => metric.label === "收入");

    expect(orders?.defaultTimeFieldId).toBeDefined();
    expect(orders?.fields.some((field) => field.id === orders.defaultTimeFieldId)).toBe(true);
    expect(revenue?.fieldId).toBeDefined();
    expect(orders?.fields.some((field) => field.id === revenue?.fieldId)).toBe(true);
  });

  test("does not pad a concrete query with a merely related table", () => {
    const slice = sliceSemanticCatalog(semanticCatalog, {
      query: "收入趋势",
      maxEntities: 2,
      maxFieldsPerEntity: 3,
      maxMetricsPerEntity: 2,
    });

    expect(slice.catalog.entities.map((entity) => entity.label)).toEqual(["订单"]);
    expect(slice.catalog.relationships).toEqual([]);
  });

  test("keeps the compact browsing fallback for an empty query", () => {
    const slice = sliceSemanticCatalog(semanticCatalog, {
      maxEntities: 2,
      maxFieldsPerEntity: 3,
      maxMetricsPerEntity: 2,
    });

    expect(slice.catalog.entities.map((entity) => entity.label)).toEqual(["订单", "客户"]);
    expect(slice.catalog.relationships).toHaveLength(1);
  });

  test("is deterministic for the same catalog and question", () => {
    const options = { query: "按客户查看收入", maxEntities: 2, maxFieldsPerEntity: 3, maxMetricsPerEntity: 2 };
    expect(sliceSemanticCatalog(semanticCatalog, options)).toEqual(sliceSemanticCatalog(semanticCatalog, options));
  });

  test("keeps explicitly requested credential-named fields in a wide planning slice", () => {
    const wideCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "accounts",
          kind: "table",
          columns: [
            { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
            ...Array.from({ length: 70 }, (_, index) => ({
              name: `attribute_${index + 1}`,
              dataType: "text",
              nullable: true,
              ordinal: index + 2,
            })),
            { name: "api_token", dataType: "text", nullable: true, ordinal: 72 },
          ],
          primaryKey: ["id"],
          foreignKeys: [],
        }],
      }],
    });
    const wideSemanticCatalog = createSemanticCatalog(wideCatalog);
    const slice = sliceSemanticCatalog(wideSemanticCatalog, {
      query: "api token",
      maxFieldsPerEntity: 64,
    });
    const accounts = slice.catalog.entities.find((entity) => entity.label === "Accounts");

    expect(slice.truncated).toBe(true);
    expect(accounts?.fields).toHaveLength(64);
    expect(accounts?.fields.find((field) => field.label === "Api Token")?.exposure).toBe("bounded-values");
  });

  test("retrieves a canonical Chinese user entity beyond the positional catalog cutoff", () => {
    const noiseTables = Array.from({ length: 40 }, (_, index) => ({
      schema: "analytics",
      name: `noise_${index + 1}`,
      kind: "table" as const,
      columns: [
        { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
        { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2 },
      ],
      primaryKey: ["id"],
      foreignKeys: [],
    }));
    const liveStyleCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [
          ...noiseTables,
          {
            schema: "analytics",
            name: "user_details",
            kind: "view",
            columns: [
              { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
              { name: "name", dataType: "text", nullable: true, ordinal: 2 },
              { name: "email", dataType: "text", nullable: true, ordinal: 3 },
              { name: "email_verified", dataType: "timestamp with time zone", nullable: true, ordinal: 4 },
              { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 5 },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
          },
        ],
      }],
    });
    const semantic = createSemanticCatalog(liveStyleCatalog, {
      entities: [{
        relation: { schema: "analytics", table: "user_details" },
        label: "用户",
        aliases: ["用户账户", "user", "users"],
        defaultTimeColumn: "created_at",
        fields: [
          { column: "name", label: "姓名" },
          { column: "email", label: "邮箱" },
          { column: "created_at", label: "创建时间", aliases: ["注册时间"] },
        ],
      }],
    });

    const slice = sliceSemanticCatalog(semantic, {
      query: "你查一下我 最新创建的用户是谁",
      maxEntities: 4,
    });
    const users = slice.catalog.entities.find((entity) => entity.label === "用户");
    const createdAt = users?.fields.find((field) => field.label === "创建时间");

    expect(users).toBeDefined();
    expect(createdAt).toBeDefined();
    expect(users?.defaultTimeFieldId).toBe(createdAt?.id);
    expect(users?.fields.map((field) => field.label)).toEqual(expect.arrayContaining(["Id", "姓名", "邮箱", "创建时间"]));
  });

  test("retrieves dynamically discovered identifiers without a business vocabulary", () => {
    const englishCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-16T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [
          ...Array.from({ length: 40 }, (_, index) => ({
            schema: "analytics",
            name: `noise_${index + 1}`,
            kind: "table" as const,
            columns: [{ name: "id", dataType: "uuid", nullable: false, ordinal: 1 }],
            primaryKey: ["id"],
            foreignKeys: [],
          })),
          {
            schema: "analytics",
            name: "users",
            kind: "table",
            columns: [
              { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
              { name: "name", dataType: "text", nullable: true, ordinal: 2 },
              { name: "created_at", dataType: "timestamp with time zone", nullable: false, ordinal: 3 },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
          },
        ],
      }],
    });

    const slice = sliceSemanticCatalog(createSemanticCatalog(englishCatalog), {
      query: "latest created user",
      maxEntities: 4,
    });

    expect(slice.catalog.entities.map((entity) => entity.label)).toContain("Users");
  });

  test("does not translate an unconfigured business term into an English entity", () => {
    const slice = sliceSemanticCatalog(createSemanticCatalog(catalog), {
      query: "最新创建的用户",
      maxEntities: 4,
    });

    expect(slice.catalog.entities).toEqual([]);
    expect(slice.truncated).toBe(true);
  });

  test("retrieves an entity and field from operator-authored business descriptions", () => {
    const describedCatalog = createSemanticCatalog(catalog, {
      entities: [
        {
          relation: { schema: "analytics", table: "orders" },
          label: "业务记录",
          description: "已完成的客户订购和履约记录。",
          fields: [{
            column: "total",
            label: "金额",
            description: "客户支付的订单收入，不包含退款。",
          }],
        },
        {
          relation: { schema: "analytics", table: "products" },
          label: "商品目录",
          description: "可售商品的库存和标识信息。",
        },
      ],
    });

    const slice = sliceSemanticCatalog(describedCatalog, { query: "客户履约收入", maxEntities: 1 });

    expect(slice.catalog.entities).toHaveLength(1);
    expect(slice.catalog.entities[0]?.label).toBe("业务记录");
    expect(slice.catalog.entities[0]?.fields.some((field) => field.label === "金额")).toBe(true);
  });

  test("describes only requested candidates and preserves their usable semantic dependencies", () => {
    const orders = semanticCatalog.entities.find((entity) => entity.label === "订单");
    const customers = semanticCatalog.entities.find((entity) => entity.label === "客户");
    expect(orders).toBeDefined();
    expect(customers).toBeDefined();
    if (!orders || !customers) throw new Error("Expected semantic fixture entities.");

    const described = describeSemanticCatalog(semanticCatalog, [orders.id, customers.id]);

    expect(described.catalog.entities.map((entity) => entity.id)).toEqual([orders.id, customers.id]);
    expect(described.catalog.relationships).toHaveLength(1);
    const relationship = described.catalog.relationships[0];
    expect(relationship?.pairs.every((pair) => (
      described.catalog.entities.find((entity) => entity.id === relationship.fromEntityId)?.fields.some((field) => field.id === pair.fromFieldId)
      && described.catalog.entities.find((entity) => entity.id === relationship.toEntityId)?.fields.some((field) => field.id === pair.toFieldId)
    ))).toBe(true);
  });

  test("does not substitute positional tables when a non-empty query has no semantic match", () => {
    const slice = sliceSemanticCatalog(semanticCatalog, {
      query: "火星业务实体",
      maxEntities: 2,
    });

    expect(slice.catalog.entities).toEqual([]);
    expect(slice.truncated).toBe(true);
  });
});
