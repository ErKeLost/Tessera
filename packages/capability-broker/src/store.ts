import { canonicalize } from "@data-elements/runtime";
import type {
  ActionInvocationStorePort,
  ActionStepReceipt,
  CapabilityGrant,
  CapabilityGrantStorePort,
  CapabilityHandler,
  CapabilityHandlerRegistryPort,
  EffectClaimResult,
  EffectStorePort,
  MessageTemplateGrant,
  StoredActionInvocation,
  StoredEffect,
} from "./types";

export class InMemoryCapabilityGrantStore implements CapabilityGrantStorePort {
  readonly #capabilities = new Map<string, CapabilityGrant>();
  readonly #templates = new Map<string, MessageTemplateGrant>();
  #grantSetVersion: number;

  constructor(input: {
    grantSetVersion?: number;
    capabilities?: readonly CapabilityGrant[];
    templates?: readonly MessageTemplateGrant[];
  } = {}) {
    this.#grantSetVersion = input.grantSetVersion ?? 0;
    for (const grant of input.capabilities ?? []) this.setCapability(grant);
    for (const template of input.templates ?? []) this.setMessageTemplate(template);
  }

  setCapability(grant: CapabilityGrant): void {
    this.#capabilities.set(grant.capabilityId, clone(grant));
    this.#grantSetVersion = Math.max(this.#grantSetVersion, grant.grantSetVersion);
  }

  deleteCapability(capabilityId: string, nextGrantSetVersion = this.#grantSetVersion + 1): void {
    this.#capabilities.delete(capabilityId);
    this.#grantSetVersion = nextGrantSetVersion;
  }

  setMessageTemplate(template: MessageTemplateGrant): void {
    this.#templates.set(template.templateGrantId, clone(template));
    this.#grantSetVersion = Math.max(this.#grantSetVersion, template.grantSetVersion);
  }

  setGrantSetVersion(version: number): void {
    if (!Number.isInteger(version) || version < this.#grantSetVersion) {
      throw new Error("Grant-set versions must advance monotonically.");
    }
    this.#grantSetVersion = version;
  }

  async getCapability(capabilityId: string): Promise<CapabilityGrant | undefined> {
    return cloneOptional(this.#capabilities.get(capabilityId));
  }

  async getMessageTemplate(templateGrantId: string): Promise<MessageTemplateGrant | undefined> {
    return cloneOptional(this.#templates.get(templateGrantId));
  }

  async listCapabilities(): Promise<CapabilityGrant[]> {
    return [...this.#capabilities.values()]
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
      .map(clone);
  }

  async listMessageTemplates(): Promise<MessageTemplateGrant[]> {
    return [...this.#templates.values()]
      .sort((left, right) => left.templateGrantId.localeCompare(right.templateGrantId))
      .map(clone);
  }

  async getGrantSetVersion(): Promise<number> {
    return this.#grantSetVersion;
  }

  exportState(): { grantSetVersion: number; capabilities: CapabilityGrant[]; templates: MessageTemplateGrant[] } {
    return {
      grantSetVersion: this.#grantSetVersion,
      capabilities: [...this.#capabilities.values()].map(clone),
      templates: [...this.#templates.values()].map(clone),
    };
  }
}

export class InMemoryCapabilityHandlerRegistry implements CapabilityHandlerRegistryPort {
  readonly #handlers = new Map<string, CapabilityHandler>();

  constructor(handlers: Readonly<Record<string, CapabilityHandler>> = {}) {
    for (const [ref, handler] of Object.entries(handlers)) this.set(ref, handler);
  }

  set(handlerRef: string, handler: CapabilityHandler): void {
    if (!handlerRef) throw new Error("handlerRef is required.");
    this.#handlers.set(handlerRef, handler);
  }

  delete(handlerRef: string): void {
    this.#handlers.delete(handlerRef);
  }

  async get(handlerRef: string): Promise<CapabilityHandler | undefined> {
    return this.#handlers.get(handlerRef);
  }
}

export class InMemoryEffectStore implements EffectStorePort {
  readonly #byRequest = new Map<string, StoredEffect>();
  readonly #byIdempotency = new Map<string, string>();

  constructor(input: { effects?: readonly StoredEffect[] } = {}) {
    for (const effect of input.effects ?? []) {
      if (this.#byRequest.has(effect.request.requestId)) throw new Error("Effect request identities must be unique.");
      const scope = idempotencyScope(effect);
      if (this.#byIdempotency.has(scope)) throw new Error("Effect idempotency scopes must be unique.");
      this.#byRequest.set(effect.request.requestId, clone(effect));
      this.#byIdempotency.set(scope, effect.request.requestId);
    }
  }

  async claim(effect: StoredEffect): Promise<EffectClaimResult> {
    let requestExisting = this.#byRequest.get(effect.request.requestId);
    if (requestExisting && Date.parse(requestExisting.expiresAt) <= Date.parse(effect.createdAt)) {
      this.#byRequest.delete(requestExisting.request.requestId);
      this.#byIdempotency.delete(idempotencyScope(requestExisting));
      requestExisting = undefined;
    }
    if (requestExisting) return compareClaim(requestExisting, effect);

    const operationRequestId = this.#byIdempotency.get(idempotencyScope(effect));
    if (operationRequestId) {
      const operationExisting = this.#byRequest.get(operationRequestId);
      if (operationExisting && Date.parse(operationExisting.expiresAt) > Date.parse(effect.createdAt)) {
        return compareClaim(operationExisting, effect);
      }
      if (operationExisting) this.#byRequest.delete(operationExisting.request.requestId);
      this.#byIdempotency.delete(idempotencyScope(effect));
    }

    this.#byRequest.set(effect.request.requestId, clone(effect));
    this.#byIdempotency.set(idempotencyScope(effect), effect.request.requestId);
    return { status: "claimed", effect: clone(effect) };
  }

  async get(requestId: string): Promise<StoredEffect | undefined> {
    return cloneOptional(this.#byRequest.get(requestId));
  }

  async compareAndSwap(requestId: string, expectedVersion: number, next: StoredEffect): Promise<boolean> {
    const current = this.#byRequest.get(requestId);
    if (!current || current.version !== expectedVersion) return false;
    if (next.request.requestId !== requestId || next.idempotencyKey !== current.idempotencyKey) {
      throw new Error("Effect identity is immutable.");
    }
    const stored = clone({ ...next, version: expectedVersion + 1 });
    this.#byRequest.set(requestId, stored);
    return true;
  }

  async countCalls(actorContextRef: string, capabilityId: string, since: string): Promise<number> {
    const threshold = Date.parse(since);
    return [...this.#byRequest.values()].filter((effect) => (
      effect.actor.actorContextRef === actorContextRef
      && effect.request.capabilityId === capabilityId
      && Date.parse(effect.createdAt) >= threshold
    )).length;
  }

  async list(): Promise<StoredEffect[]> {
    return [...this.#byRequest.values()].map(clone);
  }

  exportState(): { effects: StoredEffect[] } {
    return { effects: [...this.#byRequest.values()].map(clone) };
  }
}

export class InMemoryActionInvocationStore implements ActionInvocationStorePort {
  readonly #records = new Map<string, StoredActionInvocation>();
  readonly #triggerRequests = new Map<string, string>();

  constructor(input: { records?: readonly StoredActionInvocation[] } = {}) {
    for (const record of input.records ?? []) {
      if (this.#records.has(record.invocation.invocationId)) throw new Error("Action invocation identities must be unique.");
      const triggerKey = `${record.trigger.actorContextRef}\u0000${record.trigger.requestId}`;
      if (this.#triggerRequests.has(triggerKey)) throw new Error("Action trigger request identities must be unique.");
      this.#records.set(record.invocation.invocationId, clone(record));
      this.#triggerRequests.set(triggerKey, record.invocation.invocationId);
    }
  }

  async create(record: StoredActionInvocation): Promise<{ status: "created" | "replayed" | "conflict"; record: StoredActionInvocation }> {
    const triggerKey = `${record.trigger.actorContextRef}\u0000${record.trigger.requestId}`;
    const existingId = this.#triggerRequests.get(triggerKey);
    const existing = existingId ? this.#records.get(existingId) : this.#records.get(record.invocation.invocationId);
    if (existing) {
      const same = canonicalize(identityForAction(existing)) === canonicalize(identityForAction(record));
      return { status: same ? "replayed" : "conflict", record: clone(existing) };
    }
    this.#records.set(record.invocation.invocationId, clone(record));
    this.#triggerRequests.set(triggerKey, record.invocation.invocationId);
    return { status: "created", record: clone(record) };
  }

  async get(invocationId: string): Promise<StoredActionInvocation | undefined> {
    return cloneOptional(this.#records.get(invocationId));
  }

  async getByTriggerRequest(actorContextRef: string, requestId: string): Promise<StoredActionInvocation | undefined> {
    const invocationId = this.#triggerRequests.get(`${actorContextRef}\u0000${requestId}`);
    return invocationId ? cloneOptional(this.#records.get(invocationId)) : undefined;
  }

  async compareAndSwap(invocationId: string, expectedVersion: number, next: StoredActionInvocation): Promise<boolean> {
    const current = this.#records.get(invocationId);
    if (!current || current.version !== expectedVersion) return false;
    if (next.invocation.invocationId !== invocationId || next.trigger.triggerRecordId !== current.trigger.triggerRecordId) {
      throw new Error("Action invocation identity is immutable.");
    }
    this.#records.set(invocationId, clone({ ...next, version: expectedVersion + 1 }));
    return true;
  }

  async commitLocalStep(input: {
    invocationId: string;
    expectedVersion: number;
    receipt: ActionStepReceipt;
    nextInvocation: StoredActionInvocation["invocation"];
  }): Promise<{ status: "committed" | "replayed" | "conflict"; record: StoredActionInvocation }> {
    const current = this.#records.get(input.invocationId);
    if (!current) throw new Error("Action invocation does not exist.");
    const prior = current.receipts.find((receipt) => receipt.stepId === input.receipt.stepId);
    if (prior) {
      return {
        status: canonicalize(prior) === canonicalize(input.receipt) ? "replayed" : "conflict",
        record: clone(current),
      };
    }
    if (current.version !== input.expectedVersion) return { status: "conflict", record: clone(current) };
    const next: StoredActionInvocation = {
      ...current,
      version: current.version + 1,
      invocation: clone(input.nextInvocation),
      receipts: [...current.receipts, clone(input.receipt)],
    };
    this.#records.set(input.invocationId, next);
    return { status: "committed", record: clone(next) };
  }

  exportState(): { records: StoredActionInvocation[] } {
    return { records: [...this.#records.values()].map(clone) };
  }
}

function compareClaim(existing: StoredEffect, candidate: StoredEffect): EffectClaimResult {
  if (existing.payloadHash !== candidate.payloadHash || canonicalize(existing.request) !== canonicalize(candidate.request)) {
    return { status: "conflict", effect: clone(existing) };
  }
  return { status: existing.receipt ? "replayed" : "pending", effect: clone(existing) };
}

function idempotencyScope(effect: StoredEffect): string {
  return `${effect.actor.tenantRef}\u0000${effect.actor.actorRef}\u0000${effect.request.capabilityId}\u0000${effect.idempotencyKey}`;
}

function identityForAction(record: StoredActionInvocation): unknown {
  return {
    plan: record.plan,
    trigger: {
      requestId: record.trigger.requestId,
      documentId: record.trigger.documentId,
      branchId: record.trigger.branchId,
      revisionId: record.trigger.revisionId,
      nodeId: record.trigger.nodeId,
      eventPort: record.trigger.eventPort,
      eventSchemaHash: record.trigger.eventSchemaHash,
      validatedPayload: record.trigger.validatedPayload,
      payloadHash: record.trigger.payloadHash,
      actorContextRef: record.trigger.actorContextRef,
      contextSnapshot: record.trigger.contextSnapshot,
      contextSnapshotHash: record.trigger.contextSnapshotHash,
    },
    invocation: {
      actorContextRef: record.invocation.actorContextRef,
      documentId: record.invocation.documentId,
      branchId: record.invocation.branchId,
      revisionId: record.invocation.revisionId,
      expectedHeadToken: record.invocation.expectedHeadToken,
      nodeId: record.invocation.nodeId,
      eventPort: record.invocation.eventPort,
      actionId: record.invocation.actionId,
      planHash: record.invocation.planHash,
      eventPayloadHash: record.invocation.eventPayloadHash,
      contextSnapshotHash: record.invocation.contextSnapshotHash,
      statePreconditions: record.invocation.statePreconditions,
      grantSetVersion: record.invocation.grantSetVersion,
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
