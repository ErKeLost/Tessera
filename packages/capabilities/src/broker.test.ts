import { describe, expect, test } from "bun:test";
import { createActionContract } from "@open-generative/catalog";
import {
  actionIdSchema,
  actionTypeSchema,
  catalogIdSchema,
  publisherIdSchema,
  requestIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  surfaceSessionIdSchema,
} from "@open-generative/protocol";
import {
  CapabilityBroker,
  CapabilityDeniedError,
  InMemoryCapabilityStore,
  type CapabilityAuthority,
} from "./index";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
const authority: CapabilityAuthority = {
  actorBindingHash: hash("a"),
  tenantBindingHash: hash("b"),
  authorityPolicyRevision: "policy:1",
  surfaceSessionId: surfaceSessionIdSchema.parse("surface:1"),
  revisionId: revisionIdSchema.parse("revision:1"),
  operationScope: "export:query-1",
};

async function contract(approval = false) {
  return createActionContract({
    ref: {
      publisher: publisherIdSchema.parse("open-generative"),
      catalogId: catalogIdSchema.parse("official"),
      actionType: actionTypeSchema.parse("data.export"),
      revision: 1,
    },
    normalizedInputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["csv"] } },
      required: ["format"],
      additionalProperties: false,
    },
    resultSchema: { type: "object", additionalProperties: true },
    receiptSchema: {
      type: "object",
      properties: { proof: { type: "string" } },
      required: ["proof"],
      additionalProperties: false,
    },
    reads: [],
    writes: [],
    effectClass: "read",
    risk: "medium",
    ...(approval ? { approvalPolicyRef: "approval.export" } : {}),
    idempotencyScope: "actor",
    cancellableUntil: "before-effect",
    timeoutPolicy: { timeoutMs: 1_000 },
    retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
  });
}

function broker() {
  let invocation = 0;
  let receipt = 0;
  return new CapabilityBroker({
    store: new InMemoryCapabilityStore(),
    policy: {
      authorize: async () => ({ allowed: true }),
      checkPreconditions: async () => true,
    },
    now: () => new Date("2026-08-22T00:00:00.000Z"),
    invocationIdFactory: () => `invocation:${++invocation}`,
    receiptIdFactory: () => `receipt:${++receipt}`,
    approvalTokenFactory: () => "a".repeat(43),
  });
}

describe("CapabilityBroker", () => {
  test("validates exact contracts and replays an idempotent effect receipt", async () => {
    const instance = broker();
    const actionContract = await contract();
    let executions = 0;
    await instance.register(actionContract, async () => {
      executions += 1;
      return { result: { downloadId: "download:1" }, receipt: { proof: "receipt:1" } };
    });
    const trigger = {
      requestId: "request:1",
      actionId: actionIdSchema.parse("action:1"),
      contract: actionContract.ref,
      normalizedInput: { format: "csv" } as const,
      idempotencyKey: "idempotency:key:1",
      authority,
      statePreconditions: {},
      resourcePreconditions: {},
    };
    const first = await instance.trigger(trigger);
    const replay = await instance.trigger(trigger);
    expect(first.status.status).toBe("succeeded");
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(executions).toBe(1);
  });

  test("requires a bound, single-use approval before execution", async () => {
    const instance = broker();
    const actionContract = await contract(true);
    let executions = 0;
    await instance.register(actionContract, async () => {
      executions += 1;
      return { result: {}, receipt: { proof: "receipt:approval" } };
    });
    const pending = await instance.trigger({
      requestId: "request:2",
      actionId: actionIdSchema.parse("action:2"),
      contract: actionContract.ref,
      normalizedInput: { format: "csv" },
      idempotencyKey: "idempotency:key:2",
      authority,
      statePreconditions: {},
      resourcePreconditions: {},
    });
    expect(pending.status.status).toBe("awaiting-approval");
    expect(executions).toBe(0);
    const approved = await instance.decide({
      requestId: requestIdSchema.parse("request:approval"),
      approvalToken: pending.approval!.approvalToken,
      decision: "approve",
    }, authority);
    expect(approved.status.status).toBe("succeeded");
    expect(executions).toBe(1);
    await expect(instance.decide({
      requestId: requestIdSchema.parse("request:approval:again"),
      approvalToken: pending.approval!.approvalToken,
      decision: "approve",
    }, authority)).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  test("rejects invalid normalized input before handler execution", async () => {
    const instance = broker();
    const actionContract = await contract();
    await instance.register(actionContract, async () => ({ result: {}, receipt: { proof: "receipt:invalid" } }));
    await expect(instance.trigger({
      requestId: "request:3",
      actionId: actionIdSchema.parse("action:3"),
      contract: actionContract.ref,
      normalizedInput: { format: "json" },
      idempotencyKey: "idempotency:key:3",
      authority,
      statePreconditions: {},
      resourcePreconditions: {},
    })).rejects.toBeDefined();
  });

  test("persists failure after an approval is consumed and reauthorization fails", async () => {
    const store = new InMemoryCapabilityStore();
    let allowed = true;
    const instance = new CapabilityBroker({
      store,
      policy: {
        authorize: async () => allowed
          ? ({ allowed: true })
          : ({ allowed: false, code: "policy.changed", message: "Policy changed." }),
        checkPreconditions: async () => true,
      },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      invocationIdFactory: () => "invocation:reauthorize",
      receiptIdFactory: () => "receipt:reauthorize",
      approvalTokenFactory: () => "b".repeat(43),
    });
    const actionContract = await contract(true);
    await instance.register(actionContract, async () => ({ result: {}, receipt: { proof: "receipt:reauthorize" } }));
    const pending = await instance.trigger({
      requestId: "request:reauthorize",
      actionId: actionIdSchema.parse("action:reauthorize"),
      contract: actionContract.ref,
      normalizedInput: { format: "csv" },
      idempotencyKey: "idempotency:reauthorize",
      authority,
      statePreconditions: {},
      resourcePreconditions: {},
    });
    allowed = false;

    await expect(instance.decide({
      requestId: requestIdSchema.parse("request:decision"),
      approvalToken: pending.approval!.approvalToken,
      decision: "approve",
    }, authority)).rejects.toMatchObject({ code: "policy.changed" });
    expect(await store.getByApprovalToken(pending.approval!.approvalToken)).toMatchObject({
      approvalConsumed: true,
      status: { status: "failed", code: "policy.changed" },
    });
  });

  test("cancels an active action before its effect boundary and records a cancelled receipt", async () => {
    const store = new InMemoryCapabilityStore();
    const instance = new CapabilityBroker({
      store,
      policy: { authorize: async () => ({ allowed: true }), checkPreconditions: async () => true },
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      invocationIdFactory: () => "invocation:cancel",
      receiptIdFactory: () => "receipt:cancel",
    });
    const actionContract = await contract();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    await instance.register(actionContract, async (_input, context) => {
      started();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { result: {}, receipt: { proof: "receipt:cancel" } };
    });
    const execution = instance.trigger({
      requestId: "request:cancel",
      actionId: actionIdSchema.parse("action:cancel"),
      contract: actionContract.ref,
      normalizedInput: { format: "csv" },
      idempotencyKey: "idempotency:cancel",
      authority,
      statePreconditions: {},
      resourcePreconditions: {},
    });
    await didStart;
    const cancelled = await instance.cancel("invocation:cancel", authority);
    const completed = await execution;

    expect(cancelled.status.status).toBe("cancelled");
    expect(completed.status.status).toBe("cancelled");
    expect(completed.receipt?.outcome).toEqual({ status: "cancelled" });
  });

});
