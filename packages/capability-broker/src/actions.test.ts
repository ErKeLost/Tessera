import { describe, expect, test } from "bun:test";
import { canonicalHash } from "@data-elements/runtime";
import {
  createStoredActionInvocation,
  InMemoryActionInvocationStore,
  recoverActionStep,
  reduceActionInvocation,
  verifyActionRecoveryRecord,
  type ActionTriggerRecord,
} from "./index";

describe("action recovery", () => {
  test("recovers the first step without a terminal receipt and replays trigger identity", async () => {
    const payload = { selected: "row-1" };
    const contextSnapshot = { locale: "en-US", timezone: "UTC" };
    const trigger: ActionTriggerRecord = {
      triggerRecordId: "trigger-record-1",
      requestId: "trigger-request-1",
      documentId: "document-1",
      branchId: "main",
      revisionId: "revision-1",
      nodeId: "node-1",
      eventPort: "select",
      eventSchemaHash: "event-schema",
      validatedPayload: payload,
      payloadHash: await canonicalHash(payload),
      actorContextRef: "actor-context-1",
      contextSnapshot,
      contextSnapshotHash: await canonicalHash(contextSnapshot),
      recordedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const plan = {
      contractId: "contract-1",
      contractVersion: 1,
      steps: [
        { stepId: "focus", type: "node.focus" as const, nodeId: "node-1" },
        { stepId: "reset", type: "state.reset" as const, stateIds: ["filter"] },
      ],
      onError: "halt" as const,
    };
    const record = await createStoredActionInvocation({
      invocationId: "invocation-1",
      trigger,
      actionId: "action-1",
      plan,
      expectedHeadToken: "head-1",
      statePreconditions: { filter: "state-1" },
      grantSetVersion: 1,
    });
    await verifyActionRecoveryRecord(record);
    expect(recoverActionStep(plan, [])).toMatchObject({ type: "execute", stepIndex: 0 });
    const running = reduceActionInvocation(record.invocation, { type: "start" });
    expect(running.status).toBe("running");

    const store = new InMemoryActionInvocationStore();
    expect((await store.create(record)).status).toBe("created");
    expect((await store.create(record)).status).toBe("replayed");
  });
});
