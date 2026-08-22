import { describe, expect, test } from "bun:test";
import { createMongoDbConnector, validateMongoReadPipeline } from "./index";

describe("MongoDbConnector", () => {
  test("rejects a non-MongoDB URL before opening a connection", () => {
    expect(() => createMongoDbConnector({ connectionString: "postgresql://localhost/app" }))
      .toThrow("mongodb://");
  });

  test("requires a database in the connection URL", () => {
    expect(() => createMongoDbConnector({ connectionString: "mongodb://localhost" }))
      .toThrow("database name");
  });

  test("uses conservative query defaults", async () => {
    const connector = createMongoDbConnector({ connectionString: "mongodb://localhost/warehouse" });
    expect(connector.id).toBe("mongodb:localhost/warehouse");
    expect(connector.dialect).toBe("mongodb");
    expect(typeof connector.inspectExtensions).toBe("function");
    await connector.close();
  });
});

describe("validateMongoReadPipeline", () => {
  test("accepts compiler-style read stages", () => {
    expect(validateMongoReadPipeline([
      { $match: { $expr: { $eq: ["$status", "paid"] } } },
      { $group: { _id: "$region", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ])).toHaveLength(4);
  });

  test("rejects writes and server-side JavaScript", () => {
    expect(() => validateMongoReadPipeline([{ $out: "copy" }])).toThrow("not allowed");
    expect(() => validateMongoReadPipeline([{ $project: { value: { $function: { body: "return 1", args: [], lang: "js" } } } }]))
      .toThrow("unsafe operator");
  });

  test("constrains lookup collections", () => {
    expect(() => validateMongoReadPipeline([{
      $lookup: { from: "private", let: {}, pipeline: [{ $match: {} }], as: "joined" },
    }], new Set(["orders"]))).toThrow("outside the readable catalog");
  });
});
