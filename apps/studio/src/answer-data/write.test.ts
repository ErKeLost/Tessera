import { describe, expect, test } from "bun:test";
import type { TesseraDatabaseActionService } from "../database-actions";
import { answerActionRequestSchema } from "./contracts";
import { composeAnswerDatabaseAction, submitAnswerDatabaseAction } from "./write";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

const deleteMutation = {
  kind: "data.delete",
  relation: { schema: "public", table: "orders" },
  where: { kind: "comparison", column: "status", op: "eq", value: "test" },
  maxAffectedRows: 100,
} as const;

describe("answer action request", () => {
  test("accepts the model-facing mutation with a purpose and rejects raw SQL fields", () => {
    expect(answerActionRequestSchema.safeParse({
      mutation: deleteMutation,
      purpose: "Delete the test orders the reader confirmed",
    }).success).toBe(true);

    expect(answerActionRequestSchema.safeParse({
      mutation: deleteMutation,
      purpose: "Delete rows",
      sql: "DELETE FROM orders",
    }).success).toBe(false);
  });
});

describe("composeAnswerDatabaseAction", () => {
  test("injects the catalog envelope the browser is not allowed to supply", () => {
    const action = composeAnswerDatabaseAction(deleteMutation, {
      databaseName: "app",
      fingerprint: FINGERPRINT,
    });

    expect(action.kind).toBe("data.delete");
    if (action.kind !== "data.delete") throw new Error("unreachable");
    expect(action.version).toBe(1);
    expect(action.connectionRef).toBe("tessera");
    expect(action.databaseRef).toBe("app");
    expect(action.catalogFingerprint).toBe(FINGERPRINT);
    expect(action.relation).toEqual({ schema: "public", table: "orders" });
  });

  test("omits the database ref when the catalog has no database name", () => {
    const action = composeAnswerDatabaseAction(deleteMutation, { fingerprint: FINGERPRINT });
    expect("databaseRef" in action).toBe(false);
  });
});

describe("submitAnswerDatabaseAction", () => {
  test("submits one catalog-bound action through the governed service", async () => {
    const submitted: unknown[] = [];
    const service = {
      submit: async (input: unknown) => {
        submitted.push(input);
        return { summary: { status: "awaiting-approval" }, replayed: false } as never;
      },
    } as unknown as TesseraDatabaseActionService;

    await submitAnswerDatabaseAction({
      actor: { tenantRef: "t", actorRef: "a" },
      service,
      catalog: { databaseName: "app", fingerprint: FINGERPRINT },
      request: { mutation: deleteMutation, purpose: "Delete the test orders" },
    });

    expect(submitted).toHaveLength(1);
    const input = submitted[0] as { action: { catalogFingerprint: string }; purpose: string };
    expect(input.action.catalogFingerprint).toBe(FINGERPRINT);
    expect(input.purpose).toBe("Delete the test orders");
  });
});
