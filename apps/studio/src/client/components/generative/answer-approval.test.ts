import { describe, expect, test } from "bun:test";
import type { StudioDatabaseActionEffect } from "../../api/studio-api";
import {
  answerActionDetails,
  answerActionMutationResult,
  describeAnswerActionEffect,
  isAwaitingApproval,
} from "./answer-approval";

function effect(overrides: {
  status: string;
  approval?: Record<string, unknown>;
  reviewAction?: unknown;
  compiled?: Record<string, unknown>;
  receiptDiagnostic?: { code: string; message: string };
}): StudioDatabaseActionEffect {
  return {
    summary: {
      requestId: "req-1",
      invocationId: "inv-1",
      stepId: "step-1",
      actionId: "act-1",
      capabilityId: "cap-1",
      status: overrides.status,
      cancellable: true,
    },
    ...(overrides.approval === undefined ? {} : { approval: overrides.approval }),
    ...(overrides.receiptDiagnostic === undefined
      ? {}
      : { receipt: { receiptId: "r", requestId: "req-1", status: "failed", publication: "none", diagnostic: overrides.receiptDiagnostic } }),
    ...(overrides.reviewAction === undefined && overrides.compiled === undefined
      ? {}
      : {
          review: {
            action: overrides.reviewAction,
            purpose: "p",
            ...(overrides.compiled === undefined ? {} : { compiled: overrides.compiled }),
          },
        }),
    replayed: false,
  } as unknown as StudioDatabaseActionEffect;
}

const DELETE_REVIEW = {
  kind: "data.delete",
  relation: { schema: "public", table: "orders" },
};

describe("answerActionDetails", () => {
  test("labels a delete on its exact relation", () => {
    expect(answerActionDetails(DELETE_REVIEW)).toEqual({
      operation: "Delete",
      target: "public.orders",
    });
  });

  test("falls back safely without a relation", () => {
    expect(answerActionDetails(undefined)).toEqual({
      operation: "Database change",
      target: "Unknown target",
    });
  });
});

describe("describeAnswerActionEffect", () => {
  test("surfaces a pending approval checkpoint with the compiled statement", () => {
    const status = describeAnswerActionEffect(effect({
      status: "awaiting-approval",
      reviewAction: DELETE_REVIEW,
      compiled: { sql: "DELETE FROM orders WHERE status = $1", parameters: ["test"] },
      approval: {
        checkpointId: "cp-1",
        effectRequestId: "req-1",
        status: "pending",
        capabilityId: "cap-1",
        risk: "destructive",
        title: "Delete rows",
        summary: "This removes 2 rows.",
        expiresAt: "2026-01-01T00:00:00.000Z",
      },
    }));

    expect(status.status).toBe("awaiting_approval");
    if (status.status !== "awaiting_approval") throw new Error("unreachable");
    expect(status.requestId).toBe("req-1");
    expect(status.checkpointId).toBe("cp-1");
    expect(status.operation).toBe("Delete");
    expect(status.target).toBe("public.orders");
    expect(status.risk).toBe("destructive");
    expect(status.compiledSql).toContain("DELETE FROM orders");
    expect(status.parameters).toEqual(["test"]);
  });

  test("reports completion and rejection", () => {
    expect(describeAnswerActionEffect(effect({
      status: "succeeded",
      reviewAction: DELETE_REVIEW,
    })).status).toBe("completed");

    expect(describeAnswerActionEffect(effect({
      status: "cancelled",
      reviewAction: DELETE_REVIEW,
    })).status).toBe("rejected");
  });

  test("reports a failure with its safe diagnostic", () => {
    const status = describeAnswerActionEffect(effect({
      status: "failed",
      reviewAction: DELETE_REVIEW,
      receiptDiagnostic: { code: "row_limit_exceeded", message: "Too many rows matched." },
    }));

    expect(status.status).toBe("failed");
    if (status.status !== "failed") throw new Error("unreachable");
    expect(status.message).toBe("Too many rows matched.");
  });

  test("isAwaitingApproval is false once a decision is recorded", () => {
    expect(isAwaitingApproval(effect({
      status: "awaiting-approval",
      approval: { checkpointId: "cp-1", status: "approved" },
    }))).toBe(false);
  });
});

describe("answerActionMutationResult", () => {
  test("maps each outcome to the value the program reads", () => {
    expect(answerActionMutationResult({
      status: "awaiting_approval",
      requestId: "req-1",
      checkpointId: "cp-1",
      operation: "Delete",
      target: "public.orders",
    })).toEqual({
      status: "pending_approval",
      requestId: "req-1",
      operation: "Delete",
      target: "public.orders",
    });

    expect(answerActionMutationResult({
      status: "failed",
      requestId: "req-1",
      operation: "Delete",
      target: "public.orders",
      message: "Denied by policy.",
    }).status).toBe("failed");
  });
});
