import type { StudioDatabaseActionEffect } from "../../api/studio-api";

/**
 * The permission-driven outcome of one answer database action, reduced to what
 * the answer surface needs. It is a pure function of the server effect, so the
 * permission rules live on the server and this module only presents them.
 */
export type AnswerActionOutcome =
  | {
      status: "completed";
      requestId: string;
      operation: string;
      target: string;
      message?: string;
    }
  | {
      status: "awaiting_approval";
      requestId: string;
      checkpointId: string;
      operation: string;
      target: string;
      risk?: string;
      title?: string;
      summary?: string;
      expiresAt?: string;
      compiledSql?: string;
      parameters?: readonly unknown[];
    }
  | {
      status: "rejected";
      requestId: string;
      operation: string;
      target: string;
    }
  | {
      status: "failed";
      requestId?: string;
      operation: string;
      target: string;
      message?: string;
    };

export type AnswerApprovalPrompt = Extract<AnswerActionOutcome, { status: "awaiting_approval" }>;

/** Operation and target labels for the approval surface, from browser-safe metadata only. */
export function answerActionDetails(action: unknown): { operation: string; target: string } {
  if (!action || typeof action !== "object") {
    return { operation: "Database change", target: "Unknown target" };
  }
  const value = action as Record<string, unknown>;
  const relation = value.relation && typeof value.relation === "object"
    ? value.relation as Record<string, unknown>
    : undefined;
  const table = typeof relation?.table === "string" ? relation.table : undefined;
  const schema = typeof relation?.schema === "string" ? relation.schema : undefined;
  const kind = typeof value.kind === "string" ? value.kind.replace(/^data\./u, "") : "change";
  return {
    operation: kind.charAt(0).toUpperCase() + kind.slice(1),
    target: table ? (schema ? `${schema}.${table}` : table) : "Unknown target",
  };
}

/** True while the server is waiting for a human decision before executing. */
export function isAwaitingApproval(effect: StudioDatabaseActionEffect): boolean {
  return effect.summary.status === "awaiting-approval" && effect.approval?.status === "pending";
}

export function describeAnswerActionEffect(effect: StudioDatabaseActionEffect): AnswerActionOutcome {
  const { operation, target } = answerActionDetails(effect.review?.action);
  const requestId = effect.summary.requestId;

  if (isAwaitingApproval(effect)) {
    const approval = effect.approval;
    const compiled = effect.review?.compiled;
    return {
      status: "awaiting_approval",
      requestId,
      checkpointId: approval?.checkpointId ?? "",
      operation,
      target,
      ...(approval?.risk === undefined ? {} : { risk: approval.risk }),
      ...(approval?.title === undefined ? {} : { title: approval.title }),
      ...(approval?.summary === undefined ? {} : { summary: approval.summary }),
      ...(approval?.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
      ...(compiled?.sql === undefined ? {} : { compiledSql: compiled.sql }),
      ...(compiled?.parameters === undefined ? {} : { parameters: compiled.parameters }),
    };
  }

  if (effect.summary.status === "succeeded") {
    return { status: "completed", requestId, operation, target };
  }

  if (effect.summary.status === "cancelled" || effect.approval?.status === "rejected") {
    return { status: "rejected", requestId, operation, target };
  }

  return {
    status: "failed",
    requestId,
    operation,
    target,
    ...(effect.receipt?.diagnostic?.message === undefined
      ? {}
      : { message: effect.receipt.diagnostic.message }),
  };
}

/** The value OpenUI stores as the `Mutation()` result and the program can read. */
export function answerActionMutationResult(outcome: AnswerActionOutcome): Record<string, unknown> {
  return {
    status: outcome.status === "awaiting_approval" ? "pending_approval" : outcome.status,
    requestId: "requestId" in outcome ? outcome.requestId : undefined,
    operation: outcome.operation,
    target: outcome.target,
    ...("message" in outcome && outcome.message !== undefined ? { message: outcome.message } : {}),
  };
}
