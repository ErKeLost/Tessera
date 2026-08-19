import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore, canonicalHash, durableStateKey } from "@data-elements/runtime";
import {
  DurableActionInvocationStore,
  DurableEffectStore,
  createStoredActionInvocation,
  type ActionTriggerRecord,
  type StoredEffect,
} from "./index";

const NOW = "2026-08-15T00:00:00.000Z";

describe("durable capability stores", () => {
  test("keeps effect idempotency and CAS receipts after a process restart", async () => {
    const state = new InMemoryDurableStateStore();
    const storageKey = durableStateKey("capability-effects", "tenant-a");
    const first = new DurableEffectStore({ state, storageKey });
    const effect = makeEffect();
    expect((await first.claim(effect)).status).toBe("claimed");

    const restarted = new DurableEffectStore({ state, storageKey });
    expect((await restarted.claim(effect)).status).toBe("pending");
    const current = await restarted.get(effect.request.requestId);
    if (!current) throw new Error("effect disappeared");
    expect(await restarted.compareAndSwap(current.request.requestId, current.version, {
      ...current,
      status: "approved",
    })).toBe(true);
    const later = new DurableEffectStore({ state, storageKey });
    expect((await later.get(effect.request.requestId))?.status).toBe("approved");
    expect(await later.countCalls("actor-context-1", "capability-1", "2026-08-14T00:00:00.000Z")).toBe(1);
  });

  test("keeps action trigger replay identity after a process restart", async () => {
    const state = new InMemoryDurableStateStore();
    const storageKey = durableStateKey("capability-actions", "tenant-a");
    const trigger: ActionTriggerRecord = {
      triggerRecordId: "trigger-1",
      requestId: "request-1",
      documentId: "document-1",
      branchId: "main",
      revisionId: "revision-1",
      nodeId: "node-1",
      eventPort: "select",
      eventSchemaHash: "event-schema",
      validatedPayload: { selected: "row-1" },
      payloadHash: await canonicalHash({ selected: "row-1" }),
      actorContextRef: "actor-context-1",
      contextSnapshot: { locale: "en-US", timezone: "UTC" },
      contextSnapshotHash: await canonicalHash({ locale: "en-US", timezone: "UTC" }),
      recordedAt: NOW,
      expiresAt: "2026-08-16T00:00:00.000Z",
    };
    const record = await createStoredActionInvocation({
      invocationId: "invocation-1",
      trigger,
      actionId: "action-1",
      plan: {
        contractId: "contract-1",
        contractVersion: 1,
        steps: [{ stepId: "focus", type: "node.focus", nodeId: "node-1" }],
        onError: "halt",
      },
      expectedHeadToken: "head-1",
      statePreconditions: {},
      grantSetVersion: 1,
    });
    const first = new DurableActionInvocationStore({ state, storageKey });
    expect((await first.create(record)).status).toBe("created");
    const restarted = new DurableActionInvocationStore({ state, storageKey });
    expect((await restarted.create(record)).status).toBe("replayed");
    expect((await restarted.getByTriggerRequest("actor-context-1", "request-1"))?.invocation.invocationId).toBe("invocation-1");
  });
});

function makeEffect(): StoredEffect {
  return {
    version: 0,
    payloadHash: "payload-hash",
    idempotencyKey: "operation-1",
    request: {
      requestId: "effect-request-1",
      invocationId: "invocation-1",
      stepId: "step-1",
      documentId: "document-1",
      branchId: "main",
      revisionId: "revision-1",
      expectedHeadToken: "head-1",
      nodeId: "node-1",
      eventPort: "submit",
      actionId: "action-1",
      capabilityId: "capability-1",
      grantVersion: 1,
      grantSetVersion: 1,
      statePreconditions: {},
      idempotencyKey: "operation-1",
      resolvedInput: { query: "status" },
      inputSchemaHash: "input-schema",
      inputHash: "input-hash",
      outputSchemaHash: "output-schema",
      actorContextRef: "actor-context-1",
    },
    actor: {
      tenantRef: "tenant-a",
      actorRef: "actor-1",
      actorContextRef: "actor-context-1",
      resourceScopeRefs: [],
      allowedSensitivity: ["public"],
    },
    status: "pending",
    decisions: [],
    cancellations: [],
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-08-16T00:00:00.000Z",
  };
}
