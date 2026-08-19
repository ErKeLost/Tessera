import { describe, expect, test } from "bun:test";
import { canonicalHash, type JsonValue } from "@data-elements/runtime";
import {
  CapabilityBroker,
  DefaultCapabilityOutputPolicy,
  DefaultPolicyEvaluator,
  InMemoryCapabilityAuthority,
  InMemoryCapabilityGrantStore,
  InMemoryCapabilityHandlerRegistry,
  InMemoryCapabilityOutputCommitter,
  InMemoryEffectStore,
  JsonOutputCodec,
  SchemaContractError,
  parseJsonWithSchema,
  prepareJsonSchema,
  type ActorContext,
  type CapabilityGrant,
  type CapabilityHandler,
  type EffectSubmission,
  type SchemaProfileBinding,
} from "./index";

const PROFILE: SchemaProfileBinding = {
  profileId: "data-elements.schema-core",
  profileVersion: 1,
  profileHash: "schema-profile-v1",
};
const NOW = "2026-08-15T00:00:00.000Z";
const ACTOR: ActorContext = {
  tenantRef: "tenant-1",
  actorRef: "actor-1",
  actorContextRef: "actor-context-1",
  resourceScopeRefs: ["scope-1"],
  allowedSensitivity: ["public", "private"],
};

describe("capability broker", () => {
  test("runs initial and pre-execution authorization, publishes validated output, and replays idempotently", async () => {
    let calls = 0;
    const handler: CapabilityHandler = {
      async execute() {
        calls += 1;
        return {
          bytes: new TextEncoder().encode(JSON.stringify({ result: "ok" })),
          mediaType: "application/json",
          scopeRef: "scope-1",
          sensitivity: "private",
          validationIds: ["handler.validated"],
          resource: { resourceId: "resource-output" },
          evidence: [{ evidenceId: "evidence-output", activityRefs: ["activity-1"] }],
          publication: { revisionId: "revision-2", value: { published: true } },
        };
      },
    };
    const harness = await createHarness(handler, "never", "low");
    const first = await harness.broker.submit(harness.submission, ACTOR);
    expect(first.summary.status).toBe("succeeded");
    expect(first.receipt?.output?.outputResourceId).toBe("resource-output");
    expect(first.receipt?.output?.evidenceIds).toEqual(["evidence-output"]);
    expect(first.receipt?.publication?.status).toBe("committed");
    expect(first.replayed).toBe(false);
    expect((await harness.effects.get("request-1"))?.decisions.map((item) => item.phase)).toEqual(["initial", "pre-execution"]);

    const replay = await harness.broker.submit(harness.submission, ACTOR);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt?.receiptId).toBe(first.receipt?.receiptId);
    expect(calls).toBe(1);

    const visible = await harness.broker.modelVisibleCapability("capability-1");
    expect(JSON.stringify(visible)).not.toContain("handler-1");
    expect(JSON.stringify(visible)).not.toContain("tenant-1");
    expect(visible.inputSchemaHash).toBe(harness.grant.inputSchemaHash);
    const visibleSet = await harness.broker.modelVisibleGrantSet();
    expect(visibleSet.grantSetVersion).toBe(1);
    expect(visibleSet.capabilities.map((item) => item.capabilityId)).toEqual(["capability-1"]);
  });

  test("requires risk approval and fails closed when the branch head changes before execution", async () => {
    let calls = 0;
    const harness = await createHarness({
      async execute() {
        calls += 1;
        return basicOutput({ result: "ok" });
      },
    }, "risk-based", "high");
    const pending = await harness.broker.submit(harness.submission, ACTOR);
    expect(pending.summary.status).toBe("awaiting-approval");
    expect(pending.approval?.risk).toBe("high");

    harness.authority.set({
      documentId: "document-1",
      branchId: "main",
      revisionId: "revision-2",
      headToken: "head-2",
      tenantRef: "tenant-1",
      actorRefs: ["actor-1"],
      stateRevisions: {},
    });
    const denied = await harness.broker.respondToApproval({
      requestId: "request-1",
      checkpointId: pending.approval!.checkpointId,
      decision: "approve",
      approver: ACTOR,
    });
    expect(denied.summary.status).toBe("denied");
    expect(denied.receipt?.diagnostic?.code).toBe("policy.denied");
    expect(calls).toBe(0);
  });

  test("claims a pending approval once when concurrent approvers submit the same decision", async () => {
    let calls = 0;
    const harness = await createHarness({
      async execute() {
        calls += 1;
        return basicOutput({ result: "ok" });
      },
    }, "risk-based", "high");
    const pending = await harness.broker.submit(harness.submission, ACTOR);

    const results = await Promise.all([
      harness.broker.respondToApproval({
        requestId: pending.summary.requestId,
        checkpointId: pending.approval!.checkpointId,
        decision: "approve",
        approver: ACTOR,
      }),
      harness.broker.respondToApproval({
        requestId: pending.summary.requestId,
        checkpointId: pending.approval!.checkpointId,
        decision: "approve",
        approver: ACTOR,
      }),
    ]);

    expect(calls).toBe(1);
    expect(results.some((result) => result.summary.status === "succeeded")).toBe(true);
  });

  test("persists cancellation and reports too-late after a terminal effect", async () => {
    let release!: (value: ReturnType<typeof basicOutput>) => void;
    const handler: CapabilityHandler = {
      execute: () => new Promise((resolve) => { release = resolve; }),
      async cancel() { return true; },
    };
    const harness = await createHarness(handler, "never", "low");
    const running = harness.broker.submit(harness.submission, ACTOR);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await harness.effects.get("request-1"))?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const cancelled = await harness.broker.cancel({ cancelRequestId: "cancel-1", effectRequestId: "request-1" });
    expect(cancelled.outcome).toBe("cancelled");
    release(basicOutput({ result: "late" }));
    expect((await running).summary.status).toBe("cancelled");
    const replay = await harness.broker.cancel({ cancelRequestId: "cancel-1", effectRequestId: "request-1" });
    expect(replay.cancellationId).toBe(cancelled.cancellationId);
    const tooLate = await harness.broker.cancel({ cancelRequestId: "cancel-2", effectRequestId: "request-1" });
    expect(tooLate.outcome).toBe("too-late");
  });

  test("binds host message templates exactly and invalidates pending approval after revocation", async () => {
    let calls = 0;
    const harness = await createHarness({
      async execute() {
        calls += 1;
        return basicOutput({ result: "sent" });
      },
    }, "always", "high");
    harness.grants.setCapability({ ...harness.grant, kind: "agent-message" });
    const template = "Review {{query}}";
    harness.grants.setMessageTemplate({
      templateGrantId: "template-grant-1",
      templateGrantVersion: 1,
      grantSetVersion: 1,
      schemaProfile: PROFILE,
      capabilityId: harness.grant.capabilityId,
      capabilityGrantVersion: 1,
      templateId: "review-message",
      templateVersion: 1,
      template,
      templateHash: await canonicalHash(template),
      summary: "Ask the agent to review a governed query",
      variableSchema: harness.grant.inputSchema,
      variableSchemaHash: harness.grant.inputSchemaHash,
      disclosure: harness.grant.disclosure,
      status: "active",
    });
    const submission = {
      ...harness.submission,
      messageTemplate: { templateGrantId: "template-grant-1", templateGrantVersion: 1, values: { query: "revenue" } },
    };
    const pending = await harness.broker.submit(submission, ACTOR);
    expect(pending.summary.status).toBe("awaiting-approval");
    const stored = await harness.effects.get("request-1");
    expect(stored?.request.renderedMessage).toBe("Review revenue");
    expect(stored?.request.messageTemplate?.templateHash).toBe(await canonicalHash(template));
    const visible = await harness.broker.modelVisibleMessageTemplate("template-grant-1");
    expect(JSON.stringify(visible)).not.toContain(template);

    const active = await harness.grants.getMessageTemplate("template-grant-1");
    harness.grants.setMessageTemplate({ ...active!, status: "revoked" });
    const denied = await harness.broker.respondToApproval({
      requestId: "request-1",
      checkpointId: pending.approval!.checkpointId,
      decision: "approve",
      approver: ACTOR,
    });
    expect(denied.summary.status).toBe("denied");
    expect(calls).toBe(0);
  });

  test("rejects invalid handler output before creating resources or evidence", async () => {
    const harness = await createHarness({
      async execute() {
        return {
          ...basicOutput({ unexpected: true }),
          resource: { resourceId: "must-not-exist" },
          evidence: [{ evidenceId: "must-not-exist", activityRefs: [] }],
        };
      },
    }, "never", "low");
    const result = await harness.broker.submit(harness.submission, ACTOR);
    expect(result.summary.status).toBe("failed");
    expect(harness.outputCommit.resources.size).toBe(0);
    expect(harness.outputCommit.evidence.size).toBe(0);
  });

  test("keeps validated external output auditable when publication loses branch-head CAS", async () => {
    const harness = await createHarness({
      async execute() {
        return {
          ...basicOutput({ result: "ok" }),
          resource: { resourceId: "conflict-resource" },
          evidence: [{ evidenceId: "conflict-evidence", activityRefs: ["activity-1"] }],
          publication: { revisionId: "revision-2", value: { published: true } },
        };
      },
    }, "never", "low");
    harness.outputCommit.setHead("document-1", "main", "different-head", "revision-other");
    const result = await harness.broker.submit(harness.submission, ACTOR);
    expect(result.summary.status).toBe("succeeded");
    expect(result.receipt?.publication?.status).toBe("conflict");
    expect(result.receipt?.output?.outputResourceId).toBe("conflict-resource");
    expect(harness.outputCommit.publications.size).toBe(0);
  });

  test("rejects unbounded, remote-ref, and hash-mismatched JSON Schemas", async () => {
    const trueHash = await canonicalHash(true);
    await expect(prepareJsonSchema(true, trueHash)).rejects.toBeInstanceOf(SchemaContractError);
    const remote = { $ref: "https://example.com/schema.json" } as const;
    await expect(prepareJsonSchema(remote, await canonicalHash(remote))).rejects.toBeInstanceOf(SchemaContractError);
    const bounded = { type: "string", maxLength: 10 } as const;
    await expect(prepareJsonSchema(bounded, "wrong")).rejects.toBeInstanceOf(SchemaContractError);
    const boundedMap = {
      type: "object",
      maxProperties: 1,
      additionalProperties: { type: "string", maxLength: 10 },
    } as const;
    const prepared = await prepareJsonSchema(boundedMap, await canonicalHash(boundedMap));
    expect(() => parseJsonWithSchema(prepared.validator, { a: "one", b: "two" })).toThrow(SchemaContractError);
  });
});

async function createHarness(handler: CapabilityHandler, approval: CapabilityGrant["approval"], risk: CapabilityGrant["risk"]) {
  const inputSchema: CapabilityGrant["inputSchema"] = {
    type: "object",
    properties: { query: { type: "string", maxLength: 100 } },
    required: ["query"],
    additionalProperties: false,
  };
  const outputSchema: CapabilityGrant["outputSchema"] = {
    type: "object",
    properties: { result: { type: "string", maxLength: 100 } },
    required: ["result"],
    additionalProperties: false,
  };
  const grant: CapabilityGrant = {
    capabilityId: "capability-1",
    grantVersion: 1,
    grantSetVersion: 1,
    schemaProfile: PROFILE,
    kind: "read",
    summary: "Read a governed result",
    inputSchemaId: "input-schema",
    inputSchemaVersion: 1,
    inputSchema,
    inputSchemaHash: await canonicalHash(inputSchema),
    outputSchemaId: "output-schema",
    outputSchemaVersion: 1,
    outputSchema,
    outputSchemaHash: await canonicalHash(outputSchema),
    outputCodec: { id: "json", version: "1" },
    outputMediaType: "application/json",
    scope: { tenantRef: "tenant-1", actorRef: "actor-1", resourceScopeRefs: ["scope-1"] },
    risk,
    approval,
    idempotency: { required: true, retentionMs: 60_000 },
    budgets: { timeoutMs: 10_000, maxCalls: 10, maxInputBytes: 1_024, maxOutputBytes: 1_024 },
    disclosure: { allowedSensitivity: ["private"], requireModelReadableState: false, allowedResourceScopeRefs: ["scope-1"] },
    policyProfileHash: "policy-1",
    handlerRef: "handler-1",
  };
  const grants = new InMemoryCapabilityGrantStore({ grantSetVersion: 1, capabilities: [grant] });
  const handlers = new InMemoryCapabilityHandlerRegistry({ "handler-1": handler });
  const authority = new InMemoryCapabilityAuthority([{
    documentId: "document-1",
    branchId: "main",
    revisionId: "revision-1",
    headToken: "head-1",
    tenantRef: "tenant-1",
    actorRefs: ["actor-1"],
    stateRevisions: {},
  }], ["actor-1"]);
  const effects = new InMemoryEffectStore();
  const outputCommit = new InMemoryCapabilityOutputCommitter({ now: () => NOW });
  outputCommit.setHead("document-1", "main", "head-1", "revision-1");
  const broker = new CapabilityBroker({
    schemaProfile: PROFILE,
    now: () => NOW,
    ports: {
      grants,
      handlers,
      authority,
      policy: new DefaultPolicyEvaluator(),
      codecs: new JsonOutputCodec(),
      outputPolicy: new DefaultCapabilityOutputPolicy(),
      outputCommit,
      effects,
    },
  });
  const submission: EffectSubmission = {
    requestId: "request-1",
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
    input: { query: "status" },
    statePreconditions: {},
    idempotencyKey: "operation-1",
  };
  return { broker, grant, grants, authority, effects, outputCommit, submission };
}

function basicOutput(value: JsonValue) {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    mediaType: "application/json",
    scopeRef: "scope-1",
    sensitivity: "private" as const,
    validationIds: ["handler.validated"],
  };
}
