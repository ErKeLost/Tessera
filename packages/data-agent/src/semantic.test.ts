import { describe, expect, test } from "bun:test";
import { finalizeCatalog } from "@open-tessera/database";
import { semanticCatalogDefinitionSchema } from "./contracts";
import { buildSemanticCatalog } from "./semantic";

const catalog = finalizeCatalog({
  connectorId: "warehouse",
  dialect: "postgres",
  databaseName: "analytics",
  scannedAt: "2026-08-17T00:00:00.000Z",
  schemas: [{
    name: "analytics",
    tables: [
      {
        schema: "analytics",
        name: "accounts",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "registered_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2 },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      },
      {
        schema: "analytics",
        name: "activity_events",
        kind: "table",
        columns: [
          { name: "id", dataType: "uuid", nullable: false, ordinal: 1 },
          { name: "actor_account_id", dataType: "uuid", nullable: false, ordinal: 2 },
          { name: "occurred_at", dataType: "timestamp with time zone", nullable: false, ordinal: 3 },
        ],
        primaryKey: ["id"],
        // The relationship below intentionally has no database FK.
        foreignKeys: [],
      },
    ],
  }],
});

const businessManifest = {
  manifestId: "business",
  revision: "1",
  entities: [
    {
      relation: { schema: "analytics", table: "accounts" },
      label: "用户",
      aliases: ["账户", "会员"],
      description: "一个可登录的客户账户；注册时间是账户创建的业务时间。",
      fields: [
        { column: "id", label: "用户 ID", aliases: ["账户 ID"], description: "用户账户的稳定标识。" },
        { column: "registered_at", label: "注册时间", aliases: ["创建时间"], description: "账户首次注册完成的时间。" },
      ],
      metrics: [{
        key: "registered_users",
        label: "注册用户数",
        description: "在所选时间范围内完成注册的去重用户数。",
        aggregate: "count_distinct" as const,
        column: "id",
      }],
    },
    {
      relation: { schema: "analytics", table: "activity_events" },
      label: "用户操作",
      aliases: ["操作日志", "行为事件"],
      description: "用户在产品中产生的可审计操作事件。",
      fields: [{
        column: "actor_account_id",
        label: "操作用户 ID",
        aliases: ["用户 ID"],
        description: "执行本次操作的用户账户标识。",
      }],
    },
  ],
  relationships: [{
    from: { schema: "analytics", table: "activity_events" },
    to: { schema: "analytics", table: "accounts" },
    label: "操作发起用户",
    description: "每条操作日志由一个用户账户发起；该关系由业务系统保证，数据库未声明外键。",
    pairs: [{ fromColumn: "actor_account_id", toColumn: "id" }],
    cardinality: "many-to-one" as const,
  }],
};

const commentedCatalog = finalizeCatalog({
  connectorId: "warehouse",
  dialect: "postgres",
  databaseName: "analytics",
  scannedAt: "2026-08-17T00:00:00.000Z",
  schemas: [{
    name: "analytics",
    tables: [{
      schema: "analytics",
      name: "accounts",
      kind: "table",
      comment: "Accounts available to the application.",
      columns: [
        { name: "id", dataType: "uuid", nullable: false, ordinal: 1, comment: "Stable account identifier." },
        { name: "registered_at", dataType: "timestamp with time zone", nullable: false, ordinal: 2, comment: "When the account registration completed." },
      ],
      primaryKey: ["id"],
      foreignKeys: [],
    }],
  }],
});

describe("semantic catalog business metadata", () => {
  test("propagates operator-authored aliases and descriptions into the model-safe catalog", () => {
    const { catalog: semantic } = buildSemanticCatalog(catalog, businessManifest);
    const users = semantic.entities.find((entity) => entity.label === "用户");
    const events = semantic.entities.find((entity) => entity.label === "用户操作");
    const registeredUsers = users?.metrics.find((metric) => metric.label === "注册用户数");
    const registeredAt = users?.fields.find((field) => field.label === "注册时间");

    expect(users).toMatchObject({
      aliases: ["账户", "会员"],
      description: "一个可登录的客户账户；注册时间是账户创建的业务时间。",
    });
    expect(registeredAt).toMatchObject({
      aliases: ["创建时间"],
      description: "账户首次注册完成的时间。",
    });
    expect(registeredUsers).toMatchObject({
      description: "在所选时间范围内完成注册的去重用户数。",
      aggregate: "count_distinct",
    });
    expect(events?.description).toBe("用户在产品中产生的可审计操作事件。");
  });

  test("uses connector-provided table and column comments without field-specific mappings", () => {
    const { catalog: semantic } = buildSemanticCatalog(commentedCatalog, undefined);
    const accounts = semantic.entities.find((entity) => entity.label === "Accounts");
    const identifier = accounts?.fields.find((field) => field.label === "Id");
    const registeredAt = accounts?.fields.find((field) => field.label === "Registered At");

    expect(accounts?.description).toBe("Accounts available to the application.");
    expect(identifier?.description).toBe("Stable account identifier.");
    expect(registeredAt?.description).toBe("When the account registration completed.");
  });

  test("does not apply name-based policy to arbitrary email, token, or id columns", () => {
    const arbitraryCatalog = finalizeCatalog({
      connectorId: "warehouse",
      dialect: "postgres",
      databaseName: "analytics",
      scannedAt: "2026-08-17T00:00:00.000Z",
      schemas: [{
        name: "analytics",
        tables: [{
          schema: "analytics",
          name: "arbitrary_relation",
          kind: "table",
          columns: [
            { name: "id", dataType: "text", nullable: true, ordinal: 1 },
            { name: "email", dataType: "text", nullable: true, ordinal: 2 },
            { name: "api_token", dataType: "text", nullable: true, ordinal: 3 },
          ],
          primaryKey: [],
          foreignKeys: [],
        }],
      }],
    });
    const entity = buildSemanticCatalog(arbitraryCatalog, undefined).catalog.entities[0];

    expect(entity?.fields).toHaveLength(3);
    expect(entity?.fields.every((field) => field.exposure === "bounded-values")).toBe(true);
    expect(entity?.fields.every((field) => field.role === "dimension")).toBe(true);
  });

  test("gives explicit semantic descriptions precedence over connector comments", () => {
    const { catalog: semantic } = buildSemanticCatalog(commentedCatalog, {
      entities: [{
        relation: { schema: "analytics", table: "accounts" },
        description: "Manifest-owned account meaning.",
        fields: [{ column: "id", description: "Manifest-owned identifier meaning." }],
      }],
    });
    const accounts = semantic.entities.find((entity) => entity.label === "Accounts");
    const identifier = accounts?.fields.find((field) => field.label === "Id");
    const registeredAt = accounts?.fields.find((field) => field.label === "Registered At");

    expect(accounts?.description).toBe("Manifest-owned account meaning.");
    expect(identifier?.description).toBe("Manifest-owned identifier meaning.");
    expect(registeredAt?.description).toBe("When the account registration completed.");
  });

  test("retains an explicitly declared, labelled relationship without a physical foreign key", () => {
    const { catalog: semantic, bindings } = buildSemanticCatalog(catalog, businessManifest);
    const relationship = semantic.relationships.find((item) => item.label === "操作发起用户");

    expect(relationship).toMatchObject({
      description: "每条操作日志由一个用户账户发起；该关系由业务系统保证，数据库未声明外键。",
      cardinality: "many-to-one",
      origin: "trusted-manifest",
    });
    expect(relationship?.pairs).toHaveLength(1);
    expect(relationship && bindings.relationships.get(relationship.id)).toMatchObject({
      label: "操作发起用户",
      description: "每条操作日志由一个用户账户发起；该关系由业务系统保证，数据库未声明外键。",
      origin: "trusted-manifest",
    });
  });

  test("preserves old manifests and fingerprints semantic business metadata", () => {
    const legacy = buildSemanticCatalog(catalog, {
      entities: [{ relation: { schema: "analytics", table: "accounts" } }],
    }).catalog;
    const described = buildSemanticCatalog(catalog, {
      entities: [{
        relation: { schema: "analytics", table: "accounts" },
        description: "A customer account.",
      }],
    }).catalog;

    expect(legacy.entities[0]?.description).toBeUndefined();
    expect(legacy.entities[0]?.fields.every((field) => field.description === undefined)).toBe(true);
    expect(described.ref.fingerprint).not.toBe(legacy.ref.fingerprint);
  });

  test("validates bounded, non-empty operator descriptions", () => {
    expect(semanticCatalogDefinitionSchema.safeParse({
      entities: [{
        relation: { schema: "analytics", table: "accounts" },
        description: "",
      }],
    }).success).toBe(false);
    expect(semanticCatalogDefinitionSchema.safeParse({
      relationships: [{
        from: { schema: "analytics", table: "activity_events" },
        to: { schema: "analytics", table: "accounts" },
        label: "",
        pairs: [{ fromColumn: "actor_account_id", toColumn: "id" }],
        cardinality: "many-to-one",
      }],
    }).success).toBe(false);
  });
});
