import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  actionContractRefSchema,
  actionIdSchema,
  actionInvocationIdSchema,
  actionStatusSchema,
  approvalDecisionSchema,
  approvalRequestedSchema,
  canonicalEncode,
  effectReceiptIdSchema,
  effectReceiptSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  singleUseApprovalTokenSchema,
  stateIdSchema,
  stateRevisionIdSchema,
  surfaceSessionIdSchema,
  type ActionAccepted,
  type ActionId,
  type ActionStatus,
  type ApprovalDecision,
  type ApprovalRequested,
  type JsonValue,
  type ResourceBindingId,
  type ResourceVersionId,
  type RevisionId,
  type Sha256Hash,
  type StateId,
  type StateRevisionId,
  type SurfaceSessionId,
} from "@open-generative/protocol";
import {
  actionContractRefKey,
  verifyActionContract,
  type ActionContract,
} from "@open-generative/catalog";
import { z } from "zod";
import type { CapabilityExecutionRecord, CapabilityStore } from "./store";

export type CapabilityAuthority = Readonly<{
  actorBindingHash: Sha256Hash;
  tenantBindingHash: Sha256Hash;
  authorityPolicyRevision: string;
  surfaceSessionId: SurfaceSessionId;
  revisionId: RevisionId;
  operationScope: string;
}>;

export type CapabilityTrigger = Readonly<{
  requestId: string;
  actionId: ActionId;
  contract: ActionContract["ref"];
  normalizedInput: JsonValue;
  idempotencyKey: string;
  authority: CapabilityAuthority;
  statePreconditions: Readonly<Record<StateId, StateRevisionId>>;
  resourcePreconditions: Readonly<Record<ResourceBindingId, ResourceVersionId>>;
}>;

export type CapabilityPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

export interface CapabilityPolicy {
  authorize(input: Readonly<{
    contract: ActionContract;
    normalizedInput: JsonValue;
    authority: CapabilityAuthority;
  }>): Promise<CapabilityPolicyDecision>;
  checkPreconditions(input: Readonly<{
    authority: CapabilityAuthority;
    state: Readonly<Record<StateId, StateRevisionId>>;
    resources: Readonly<Record<ResourceBindingId, ResourceVersionId>>;
  }>): Promise<boolean>;
}

export type CapabilityHandlerResult = Readonly<{
  result?: JsonValue;
  resultingRevisionId?: RevisionId;
  resultingStateRevisions?: Readonly<Record<StateId, StateRevisionId>>;
  resultingResourceVersions?: Readonly<Record<ResourceBindingId, ResourceVersionId>>;
}>;

export type CapabilityHandlerContext = Readonly<{
  invocationId: string;
  executionIdentityHash: Sha256Hash;
  authority: CapabilityAuthority;
  signal: AbortSignal;
  markEffectCommitted(): void;
}>;

export type CapabilityHandler = (
  input: JsonValue,
  context: CapabilityHandlerContext,
) => Promise<CapabilityHandlerResult>;

export type CapabilityBrokerResult = Readonly<{
  accepted: ActionAccepted;
  status: ActionStatus;
  approval?: ApprovalRequested;
  receipt?: z.infer<typeof effectReceiptSchema>;
  replayed: boolean;
}>;

export type CapabilityBrokerOptions = Readonly<{
  store: CapabilityStore;
  policy: CapabilityPolicy;
  now?: () => Date;
  invocationIdFactory?: () => string;
  receiptIdFactory?: () => string;
  approvalTokenFactory?: () => string;
}>;

type Registration = Readonly<{
  contract: ActionContract;
  handler: CapabilityHandler;
  inputValidator: z.ZodType;
  resultValidator: z.ZodType;
  receiptValidator: z.ZodType;
}>;

type ActiveExecution = {
  controller: AbortController;
  cancelRequested: boolean;
  effectCommitted: boolean;
  cancellableUntil: ActionContract["cancellableUntil"];
};

export class CapabilityBroker {
  readonly #store: CapabilityStore;
  readonly #policy: CapabilityPolicy;
  readonly #registrations = new Map<string, Registration>();
  readonly #now: () => Date;
  readonly #invocationIdFactory: () => string;
  readonly #receiptIdFactory: () => string;
  readonly #approvalTokenFactory: () => string;
  readonly #activeExecutions = new Map<string, ActiveExecution>();

  constructor(options: CapabilityBrokerOptions) {
    this.#store = options.store;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
    this.#invocationIdFactory = options.invocationIdFactory ?? (() => `invocation:${randomUUID()}`);
    this.#receiptIdFactory = options.receiptIdFactory ?? (() => `receipt:${randomUUID()}`);
    this.#approvalTokenFactory = options.approvalTokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async register(contractInput: unknown, handler: CapabilityHandler): Promise<void> {
    const contract = await verifyActionContract(contractInput);
    const key = actionContractRefKey(contract.ref);
    if (this.#registrations.has(key)) throw new Error(`Capability handler already registered for ${key}.`);
    this.#registrations.set(key, Object.freeze({
      contract,
      handler,
      inputValidator: schemaValidator(contract.normalizedInputSchema),
      resultValidator: schemaValidator(contract.resultSchema),
      receiptValidator: schemaValidator(contract.receiptSchema),
    }));
  }

  async trigger(input: CapabilityTrigger): Promise<CapabilityBrokerResult> {
    const trigger = parseTrigger(input);
    const registration = this.#registration(trigger.contract);
    const normalizedInput = registration.inputValidator.parse(trigger.normalizedInput) as JsonValue;
    const policy = await this.#policy.authorize({
      contract: registration.contract,
      normalizedInput,
      authority: trigger.authority,
    });
    if (!policy.allowed) throw new CapabilityDeniedError(policy.code, policy.message);

    const normalizedInputHash = serverHash("open-generative.capability-input\0", normalizedInput);
    const effectSummaryHash = serverHash("open-generative.capability-effect-summary\0", {
      contract: registration.contract.ref,
      effectClass: registration.contract.effectClass,
      reads: registration.contract.reads,
      writes: registration.contract.writes,
      normalizedInputHash,
    });
    const identityHash = capabilityIdentityHash(registration.contract, trigger, normalizedInputHash);
    const now = this.#now().toISOString();
    const accepted: ActionAccepted = {
      requestId: requestIdSchema.parse(trigger.requestId),
      invocationId: actionInvocationIdSchema.parse(this.#invocationIdFactory()),
      actionId: trigger.actionId,
      actionContract: registration.contract.ref,
      normalizedInputHash,
      acceptedAt: now,
    };
    const record: CapabilityExecutionRecord = {
      identityHash,
      accepted,
      status: actionStatusSchema.parse({ invocationId: accepted.invocationId, status: "accepted", updatedAt: now }),
      normalizedInput,
      authorityBindingHash: trigger.authority.actorBindingHash,
      tenantBindingHash: trigger.authority.tenantBindingHash,
      surfaceSessionId: trigger.authority.surfaceSessionId,
      revisionId: trigger.authority.revisionId,
      approvalConsumed: false,
    };
    const claimed = await this.#store.claim(record);
    if (claimed.status === "existing") return resultFromRecord(claimed.record, true);

    if (registration.contract.approvalPolicyRef) {
      const approval = this.#createApproval(registration.contract, trigger, normalizedInputHash, effectSummaryHash);
      record.approval = approval;
      record.status = actionStatusSchema.parse({
        invocationId: accepted.invocationId,
        status: "awaiting-approval",
        updatedAt: this.#now().toISOString(),
      });
      await this.#store.update(record);
      return resultFromRecord(record, false);
    }
    return this.#execute(registration, record, trigger.authority, trigger.statePreconditions, trigger.resourcePreconditions, effectSummaryHash);
  }

  async decide(
    decisionInput: ApprovalDecision,
    authority: CapabilityAuthority,
  ): Promise<CapabilityBrokerResult> {
    const decision = approvalDecisionSchema.parse(decisionInput);
    const record = await this.#store.getByApprovalToken(decision.approvalToken);
    if (!record?.approval) throw new CapabilityDeniedError("approval.not-found", "Approval token is invalid or no longer available.");
    if (record.status.status !== "awaiting-approval") {
      throw new CapabilityDeniedError("approval.not-pending", "The action is no longer awaiting approval.");
    }
    if (record.approvalConsumed) throw new CapabilityDeniedError("approval.consumed", "Approval token has already been consumed.");
    assertApprovalAuthority(record.approval, authority);
    if (Date.parse(record.approval.expiresAt) <= this.#now().getTime()) {
      throw new CapabilityDeniedError("approval.expired", "Approval token has expired.");
    }

    const consumed = await this.#store.consumeApproval(decision.approvalToken);
    if (consumed.status !== "consumed") {
      throw new CapabilityDeniedError("approval.consumed", "Approval token has already been consumed.");
    }
    const consumedRecord = consumed.record;
    if (decision.decision === "reject") {
      consumedRecord.status = actionStatusSchema.parse({
        invocationId: consumedRecord.accepted.invocationId,
        status: "cancelled",
        updatedAt: this.#now().toISOString(),
        code: "approval.rejected",
      });
      await this.#store.update(consumedRecord);
      return resultFromRecord(consumedRecord, false);
    }

    const registration = this.#registration(consumedRecord.accepted.actionContract);
    const policy = await this.#policy.authorize({
      contract: registration.contract,
      normalizedInput: consumedRecord.normalizedInput,
      authority,
    });
    if (!policy.allowed) {
      await this.#failConsumedApproval(consumedRecord, policy.code);
      throw new CapabilityDeniedError(policy.code, policy.message);
    }
    const preconditions = await this.#policy.checkPreconditions({
      authority,
      state: record.approval.statePreconditions,
      resources: record.approval.resourcePreconditions,
    });
    if (!preconditions) {
      await this.#failConsumedApproval(consumedRecord, "approval.precondition-conflict");
      throw new CapabilityDeniedError("approval.precondition-conflict", "Action preconditions changed after approval was requested.");
    }
    await this.#store.update(consumedRecord);
    return this.#execute(
      registration,
      consumedRecord,
      authority,
      record.approval.statePreconditions,
      record.approval.resourcePreconditions,
      record.approval.effectSummaryHash,
    );
  }

  async cancel(invocationIdInput: string, authority: CapabilityAuthority): Promise<CapabilityBrokerResult> {
    const invocationId = actionInvocationIdSchema.parse(invocationIdInput);
    const record = await this.#store.getByInvocationId(invocationId);
    if (!record) throw new CapabilityDeniedError("cancellation.not-found", "Action invocation does not exist.");
    assertRecordAuthority(record, authority);
    if (record.receipt || ["succeeded", "failed", "cancelled"].includes(record.status.status)) {
      return resultFromRecord(record, true);
    }

    const registration = this.#registration(record.accepted.actionContract);
    if (registration.contract.cancellableUntil === "never") {
      return cancellationDenied(record, "cancellation.not-supported", this.#now());
    }
    if (record.status.status === "awaiting-approval") {
      if (record.approval) await this.#store.consumeApproval(record.approval.approvalToken);
      record.approvalConsumed = true;
      record.status = actionStatusSchema.parse({
        invocationId,
        status: "cancelled",
        updatedAt: this.#now().toISOString(),
        code: "cancellation.before-approval",
      });
      await this.#store.update(record);
      return resultFromRecord(record, false);
    }

    const active = this.#activeExecutions.get(invocationId);
    if (!active) return cancellationDenied(record, "cancellation.boundary-passed", this.#now());
    if (
      active.cancellableUntil === "before-dispatch"
      || (active.cancellableUntil === "before-effect" && active.effectCommitted)
    ) return cancellationDenied(record, "cancellation.boundary-passed", this.#now());

    active.cancelRequested = true;
    active.controller.abort(new CapabilityCancelledError("cancellation.requested", "Action cancellation was requested."));
    record.status = actionStatusSchema.parse({
      invocationId,
      status: "cancelled",
      updatedAt: this.#now().toISOString(),
      code: "cancellation.requested",
    });
    await this.#store.update(record);
    return resultFromRecord(record, false);
  }

  async #failConsumedApproval(record: CapabilityExecutionRecord, code: string): Promise<void> {
    record.status = actionStatusSchema.parse({
      invocationId: record.accepted.invocationId,
      status: "failed",
      updatedAt: this.#now().toISOString(),
      code,
      retryable: false,
    });
    await this.#store.update(record);
  }

  #registration(ref: ActionContract["ref"]): Registration {
    const parsed = actionContractRefSchema.parse(ref);
    const registration = this.#registrations.get(actionContractRefKey(parsed));
    if (!registration) throw new CapabilityDeniedError("capability.handler-missing", "No trusted handler is registered for the exact Action Contract.");
    return registration;
  }

  #createApproval(
    contract: ActionContract,
    trigger: ReturnType<typeof parseTrigger>,
    normalizedInputHash: Sha256Hash,
    effectSummaryHash: Sha256Hash,
  ): ApprovalRequested {
    return approvalRequestedSchema.parse({
      approvalToken: singleUseApprovalTokenSchema.parse(this.#approvalTokenFactory()),
      expiresAt: new Date(this.#now().getTime() + contract.timeoutPolicy.timeoutMs).toISOString(),
      actorBindingHash: trigger.authority.actorBindingHash,
      tenantBindingHash: trigger.authority.tenantBindingHash,
      surfaceSessionId: trigger.authority.surfaceSessionId,
      actionContract: contract.ref,
      revisionId: trigger.authority.revisionId,
      normalizedInputHash,
      effectSummaryHash,
      statePreconditions: trigger.statePreconditions,
      resourcePreconditions: trigger.resourcePreconditions,
    });
  }

  async #execute(
    registration: Registration,
    record: CapabilityExecutionRecord,
    authority: CapabilityAuthority,
    statePreconditions: Readonly<Record<StateId, StateRevisionId>>,
    resourcePreconditions: Readonly<Record<ResourceBindingId, ResourceVersionId>>,
    effectSummaryHash: Sha256Hash,
  ): Promise<CapabilityBrokerResult> {
    const preconditions = await this.#policy.checkPreconditions({ authority, state: statePreconditions, resources: resourcePreconditions });
    if (!preconditions) {
      record.status = actionStatusSchema.parse({
        invocationId: record.accepted.invocationId,
        status: "failed",
        updatedAt: this.#now().toISOString(),
        code: "capability.precondition-conflict",
        retryable: false,
      });
      await this.#store.update(record);
      throw new CapabilityDeniedError("capability.precondition-conflict", "Action preconditions no longer match current state.");
    }

    record.status = actionStatusSchema.parse({
      invocationId: record.accepted.invocationId,
      status: "running",
      updatedAt: this.#now().toISOString(),
    });
    await this.#store.update(record);
    const startedAt = this.#now().toISOString();
    const active: ActiveExecution = {
      controller: new AbortController(),
      cancelRequested: false,
      effectCommitted: false,
      cancellableUntil: registration.contract.cancellableUntil,
    };
    this.#activeExecutions.set(record.accepted.invocationId, active);
    let handlerResult: CapabilityHandlerResult | undefined;
    let failure: unknown;
    for (let attempt = 1; attempt <= registration.contract.retryPolicy.maxAttempts; attempt += 1) {
      if (active.cancelRequested) {
        failure = new CapabilityCancelledError("cancellation.requested", "Action cancellation was requested.");
        break;
      }
      if (active.controller.signal.aborted) active.controller = new AbortController();
      try {
        handlerResult = await runWithTimeout(
          registration.handler,
          record.normalizedInput,
          {
            invocationId: record.accepted.invocationId,
            executionIdentityHash: record.identityHash,
            authority,
            signal: active.controller.signal,
            markEffectCommitted: () => {
              active.effectCommitted = true;
            },
          },
          active.controller,
          registration.contract.timeoutPolicy.timeoutMs,
          registration.contract.effectClass === "none" || registration.contract.effectClass === "read",
        );
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (!(error instanceof CapabilityExecutionError) || !error.retryable || attempt >= registration.contract.retryPolicy.maxAttempts) break;
        await retryDelay(registration.contract.retryPolicy, attempt);
      }
    }

    this.#activeExecutions.delete(record.accepted.invocationId);

    const completedAt = this.#now().toISOString();
    const baseReceipt = {
      receiptId: effectReceiptIdSchema.parse(this.#receiptIdFactory()),
      invocationId: record.accepted.invocationId,
      actionContract: registration.contract.ref,
      idempotencyKeyHash: record.identityHash,
      normalizedInputHash: record.accepted.normalizedInputHash,
      effectSummaryHash,
      resultingRevisionId: handlerResult?.resultingRevisionId,
      resultingStateRevisions: handlerResult?.resultingStateRevisions ?? {},
      resultingResourceVersions: handlerResult?.resultingResourceVersions ?? {},
      startedAt,
      completedAt,
    };
    const receipt = failure instanceof CapabilityCancelledError
      ? effectReceiptSchema.parse({
        ...baseReceipt,
        outcome: { status: "cancelled" },
      })
      : failure === undefined && handlerResult
      ? effectReceiptSchema.parse({
        ...baseReceipt,
        outcome: {
          status: "succeeded",
          ...(handlerResult.result === undefined ? {} : {
            result: registration.resultValidator.parse(handlerResult.result),
            resultHash: serverHash("open-generative.capability-result\0", handlerResult.result),
          }),
        },
      })
      : effectReceiptSchema.parse({
        ...baseReceipt,
        outcome: {
          status: "failed",
          errorCode: failure instanceof CapabilityExecutionError ? failure.code : "capability.execution-failed",
          retryable: failure instanceof CapabilityExecutionError && failure.retryable,
        },
      });
    registration.receiptValidator.parse(receipt);
    record.receipt = receipt;
    record.status = actionStatusSchema.parse({
      invocationId: record.accepted.invocationId,
      status: receipt.outcome.status === "succeeded"
        ? "succeeded"
        : receipt.outcome.status === "cancelled"
          ? "cancelled"
          : "failed",
      updatedAt: completedAt,
      ...(receipt.outcome.status === "failed" ? { code: receipt.outcome.errorCode, retryable: receipt.outcome.retryable } : {}),
    });
    await this.#store.update(record);
    return resultFromRecord(record, false);
  }
}

export class CapabilityDeniedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CapabilityDeniedError";
  }
}

export class CapabilityExecutionError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) {
    super(message);
    this.name = "CapabilityExecutionError";
  }
}

export class CapabilityCancelledError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CapabilityCancelledError";
  }
}

function parseTrigger(input: CapabilityTrigger) {
  if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 512) throw new TypeError("Invalid idempotency key length.");
  return {
    ...input,
    requestId: requestIdSchema.parse(input.requestId),
    actionId: actionIdSchema.parse(input.actionId),
    contract: actionContractRefSchema.parse(input.contract),
    authority: {
      ...input.authority,
      actorBindingHash: sha256HashSchema.parse(input.authority.actorBindingHash),
      tenantBindingHash: sha256HashSchema.parse(input.authority.tenantBindingHash),
      surfaceSessionId: surfaceSessionIdSchema.parse(input.authority.surfaceSessionId),
      revisionId: revisionIdSchema.parse(input.authority.revisionId),
    },
    statePreconditions: z.record(stateIdSchema, stateRevisionIdSchema).parse(input.statePreconditions),
    resourcePreconditions: z.record(resourceBindingIdSchema, resourceVersionIdSchema).parse(input.resourcePreconditions),
  };
}

function capabilityIdentityHash(contract: ActionContract, trigger: ReturnType<typeof parseTrigger>, normalizedInputHash: Sha256Hash) {
  const scope = contract.idempotencyScope === "actor"
    ? trigger.authority.actorBindingHash
    : contract.idempotencyScope === "surface"
      ? trigger.authority.surfaceSessionId
      : contract.idempotencyScope === "document"
        ? trigger.authority.revisionId
        : trigger.authority.tenantBindingHash;
  return serverHash("open-generative.capability-idempotency\0", {
    tenant: trigger.authority.tenantBindingHash,
    actor: trigger.authority.actorBindingHash,
    contract: contract.ref,
    normalizedInputHash,
    operationScope: trigger.authority.operationScope,
    declaredScope: contract.idempotencyScope,
    scope,
    idempotencyKey: trigger.idempotencyKey,
  });
}

function schemaValidator(schema: ActionContract["normalizedInputSchema"]): z.ZodType {
  return z.fromJSONSchema(schema);
}

function serverHash(domain: string, value: unknown): Sha256Hash {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(canonicalEncode(value));
  return sha256HashSchema.parse(`sha256:${hash.digest("hex")}`);
}

function assertApprovalAuthority(approval: ApprovalRequested, authority: CapabilityAuthority): void {
  if (
    approval.actorBindingHash !== authority.actorBindingHash
    || approval.tenantBindingHash !== authority.tenantBindingHash
    || approval.surfaceSessionId !== authority.surfaceSessionId
    || approval.revisionId !== authority.revisionId
  ) throw new CapabilityDeniedError("approval.authority-mismatch", "Approval token is not bound to this authority context.");
}

async function runWithTimeout(
  handler: CapabilityHandler,
  input: JsonValue,
  context: CapabilityHandlerContext,
  controller: AbortController,
  timeoutMs: number,
  timeoutRetryable: boolean,
): Promise<CapabilityHandlerResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new CapabilityExecutionError("capability.timeout", timeoutRetryable, "Capability execution timed out.");
        if (!controller.signal.aborted) controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(
        context.signal.reason instanceof CapabilityCancelledError
          ? context.signal.reason
          : context.signal.reason instanceof CapabilityExecutionError
            ? context.signal.reason
          : new CapabilityCancelledError("cancellation.requested", "Action execution was cancelled."),
      );
      if (context.signal.aborted) onAbort();
      else {
        context.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => context.signal.removeEventListener("abort", onAbort);
      }
    });
    return await Promise.race([handler(input, context), timedOut, cancelled]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

async function retryDelay(policy: ActionContract["retryPolicy"], attempt: number): Promise<void> {
  if (policy.backoff === "none" || policy.initialDelayMs === 0) return;
  const delay = policy.backoff === "fixed"
    ? policy.initialDelayMs
    : policy.initialDelayMs * (2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function resultFromRecord(record: CapabilityExecutionRecord, replayed: boolean): CapabilityBrokerResult {
  return Object.freeze({
    accepted: record.accepted,
    status: record.status,
    ...(record.approval ? { approval: record.approval } : {}),
    ...(record.receipt ? { receipt: record.receipt } : {}),
    replayed,
  });
}

function assertRecordAuthority(record: CapabilityExecutionRecord, authority: CapabilityAuthority): void {
  if (
    record.authorityBindingHash !== authority.actorBindingHash
    || record.tenantBindingHash !== authority.tenantBindingHash
    || record.surfaceSessionId !== authority.surfaceSessionId
    || record.revisionId !== authority.revisionId
  ) throw new CapabilityDeniedError("cancellation.authority-mismatch", "Action invocation is not bound to this authority context.");
}

function cancellationDenied(
  record: CapabilityExecutionRecord,
  code: string,
  now: Date,
): CapabilityBrokerResult {
  return Object.freeze({
    ...resultFromRecord(record, false),
    status: actionStatusSchema.parse({
      invocationId: record.accepted.invocationId,
      status: "cancellation-denied",
      updatedAt: now.toISOString(),
      code,
    }),
  });
}
