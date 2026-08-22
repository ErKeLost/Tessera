import { actionPlanSchema, canonicalHash, canonicalize, type ActionPlan, type ActionStep } from "@open-tessera/runtime";
import type {
  ActionInvocation,
  ActionReducerEvent,
  ActionStepReceipt,
  ActionTriggerRecord,
  StoredActionInvocation,
} from "./types";

const TERMINAL_STEP_STATUSES = new Set<ActionStepReceipt["status"]>(["succeeded", "failed", "skipped", "cancelled"]);

export function reduceActionInvocation(invocation: ActionInvocation, event: ActionReducerEvent, now = new Date().toISOString()): ActionInvocation {
  const next = { ...invocation, updatedAt: now };
  switch (event.type) {
    case "start":
      if (invocation.status !== "pending") return invocation;
      return { ...next, status: "running" };
    case "step-running":
      if (invocation.status === "cancel-requested" || isActionTerminal(invocation.status)) return invocation;
      return { ...next, status: "running", nextStepId: event.step.stepId };
    case "approval-required":
      if (isActionTerminal(invocation.status)) return invocation;
      return { ...next, status: "awaiting-approval", nextStepId: event.step.stepId };
    case "step-succeeded":
      if (isActionTerminal(invocation.status)) return invocation;
      return event.nextStepId
        ? { ...next, status: "running", nextStepId: event.nextStepId }
        : { ...withoutNext(next), status: "succeeded" };
    case "step-failed":
      if (isActionTerminal(invocation.status)) return invocation;
      return event.continueWithStepId
        ? { ...next, status: "running", nextStepId: event.continueWithStepId }
        : { ...withoutNext(next), status: "failed" };
    case "cancel-requested":
      if (isActionTerminal(invocation.status)) return invocation;
      return { ...next, status: "cancel-requested" };
    case "cancelled":
      if (isActionTerminal(invocation.status)) return invocation;
      return { ...withoutNext(next), status: "cancelled" };
  }
}

export type ActionRecoveryDecision =
  | { type: "complete"; status: "succeeded" | "failed" | "cancelled" }
  | { type: "reconcile"; step: ActionStep; receipt: ActionStepReceipt }
  | { type: "execute"; step: ActionStep; stepIndex: number };

export function recoverActionStep(plan: ActionPlan, receipts: readonly ActionStepReceipt[]): ActionRecoveryDecision {
  const parsed = actionPlanSchema.parse(plan);
  const byStep = new Map<string, ActionStepReceipt>();
  for (const receipt of receipts) {
    const prior = byStep.get(receipt.stepId);
    if (prior && canonicalize(prior) !== canonicalize(receipt)) throw new Error(`Conflicting receipts for step ${receipt.stepId}.`);
    byStep.set(receipt.stepId, receipt);
  }
  for (let index = 0; index < parsed.steps.length; index += 1) {
    const step = parsed.steps[index]!;
    const receipt = byStep.get(step.stepId);
    if (!receipt) return { type: "execute", step, stepIndex: index };
    if (receipt.status === "running") return { type: "reconcile", step, receipt };
    if (receipt.status === "cancelled") return { type: "complete", status: "cancelled" };
    if (receipt.status === "failed" && parsed.onError === "halt") return { type: "complete", status: "failed" };
    if (!TERMINAL_STEP_STATUSES.has(receipt.status)) return { type: "reconcile", step, receipt };
  }
  return { type: "complete", status: "succeeded" };
}

export async function createStoredActionInvocation(input: {
  invocationId: string;
  trigger: ActionTriggerRecord;
  actionId: string;
  plan: ActionPlan;
  expectedHeadToken: string;
  statePreconditions: Record<string, string>;
  grantSetVersion: number;
  now?: string;
}): Promise<StoredActionInvocation> {
  const plan = actionPlanSchema.parse(input.plan);
  const now = input.now ?? new Date().toISOString();
  const invocation: ActionInvocation = {
    invocationId: input.invocationId,
    triggerRequestId: input.trigger.requestId,
    triggerRecordId: input.trigger.triggerRecordId,
    actorContextRef: input.trigger.actorContextRef,
    documentId: input.trigger.documentId,
    branchId: input.trigger.branchId,
    revisionId: input.trigger.revisionId,
    expectedHeadToken: input.expectedHeadToken,
    nodeId: input.trigger.nodeId,
    eventPort: input.trigger.eventPort,
    actionId: input.actionId,
    planHash: await canonicalHash(plan),
    eventPayloadHash: input.trigger.payloadHash,
    contextSnapshotHash: input.trigger.contextSnapshotHash,
    statePreconditions: structuredClone(input.statePreconditions),
    grantSetVersion: input.grantSetVersion,
    status: "pending",
    nextStepId: plan.steps[0]?.stepId,
    startedAt: now,
    updatedAt: now,
  };
  return { version: 0, plan, trigger: structuredClone(input.trigger), invocation, receipts: [] };
}

export async function verifyActionRecoveryRecord(record: StoredActionInvocation): Promise<void> {
  if (await canonicalHash(record.plan) !== record.invocation.planHash) throw new Error("Action plan hash mismatch.");
  if (await canonicalHash(record.trigger.validatedPayload) !== record.trigger.payloadHash) throw new Error("Trigger payload hash mismatch.");
  if (await canonicalHash(record.trigger.contextSnapshot) !== record.trigger.contextSnapshotHash) throw new Error("Trigger context hash mismatch.");
  if (record.trigger.actorContextRef !== record.invocation.actorContextRef) throw new Error("Action actor binding mismatch.");
  if (Date.parse(record.trigger.expiresAt) <= Date.now()) throw new Error("Action trigger record expired.");
  await verifyActionStepReceipts(record);
}

export async function verifyActionStepReceipts(record: StoredActionInvocation): Promise<void> {
  const steps = new Map(record.plan.steps.map((step, index) => [step.stepId, { step, index }]));
  const seen = new Set<string>();
  for (const receipt of record.receipts) {
    const expected = steps.get(receipt.stepId);
    if (!expected || receipt.invocationId !== record.invocation.invocationId || receipt.stepIndex !== expected.index) {
      throw new Error(`Action step receipt identity mismatch for ${receipt.stepId}.`);
    }
    if (seen.has(receipt.stepId)) throw new Error(`Duplicate action step receipt for ${receipt.stepId}.`);
    if (await canonicalHash(expected.step) !== receipt.stepHash) throw new Error(`Action step hash mismatch for ${receipt.stepId}.`);
    seen.add(receipt.stepId);
  }
}

export function actionOperationKey(invocationId: string, stepId: string): string {
  return `${invocationId}:${stepId}`;
}

function withoutNext(invocation: ActionInvocation): Omit<ActionInvocation, "nextStepId"> {
  const { nextStepId: _nextStepId, ...next } = invocation;
  return next;
}

function isActionTerminal(status: ActionInvocation["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
