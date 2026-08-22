import {
  actionTriggerRequestSchema,
  approvalDecisionSchema,
  canonicalStringify,
  causationIdSchema,
  createDiagnostic,
  hostCommandEnvelopeSchema,
  resourceResolutionIdentitySchema,
  resourceWindowRequestSchema,
  stateWriteRequestSchema,
  verifyHostCommandEnvelope,
  type ActionContractRef,
  type ActionInvocationId,
  type ActionTriggerRequest,
  type ContractRef,
  type DiagnosticPhase,
  type HostCommandEnvelope,
  type JsonValue,
  type ResourceBindingId,
  type ResourceResolutionIdentity,
  type ResourceResolutionResult,
  type ResourceVersionId,
  type StateId,
  type StateRevisionId,
  type SurfaceEventEnvelope,
  type SurfaceSessionId,
  type ValueExpr,
} from "@open-generative/protocol";
import {
  actionContractRefKey,
  contractRefKey,
  verifyComponentContract,
  type ComponentContract,
} from "@open-generative/catalog";
import { materializeValueMap } from "@open-generative/runtime";
import {
  CapabilityBroker,
  CapabilityDeniedError,
  type CapabilityAuthority,
} from "@open-generative/capabilities";
import type { ResourceGateway, ResourceGatewayError } from "@open-generative/resources";
import { z } from "zod";
import {
  createAuthorityContext,
  hashAudienceBinding,
  type AuthorityContext,
} from "./authority";
import type { DocumentStateWriter } from "./document-state";
import type {
  SurfaceEventDraft,
  SurfaceSessionJournal,
} from "./surface-journal";
import type {
  SurfaceSessionRecord,
  VersionedSurfaceSession,
} from "./surface-store";

export type HostAuthorityDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; code: string; message: string }>;

export interface HostAuthorityPolicy {
  authorize(input: Readonly<{
    session: SurfaceSessionRecord;
    authority: AuthorityContext;
    operation: string;
  }>): Promise<HostAuthorityDecision>;
}

export interface HostComponentContractRegistry {
  resolve(ref: ContractRef): Promise<ComponentContract | undefined>;
}

export type HostCommandContext = Readonly<{
  operationScope: string;
  locale: string;
  timezone: string;
}>;

export type HostCommandResult =
  | Readonly<{
    status: "events";
    events: readonly SurfaceEventEnvelope[];
    replayed: boolean;
  }>
  | Readonly<{
    status: "snapshot-required";
    reason: "invalid-cursor" | "expired" | "scope-mismatch" | "epoch-changed" | "retention-gap";
  }>
  | Readonly<{
    status: "acknowledged";
    acknowledgedThrough: number;
    replayed: boolean;
  }>;

export class HostServer {
  readonly #journal: SurfaceSessionJournal;
  readonly #resources: ResourceGateway;
  readonly #capabilities: CapabilityBroker;
  readonly #documentState: DocumentStateWriter;
  readonly #components: HostComponentContractRegistry;
  readonly #authorityPolicy: HostAuthorityPolicy;
  readonly #now: () => Date;

  constructor(input: Readonly<{
    journal: SurfaceSessionJournal;
    resources: ResourceGateway;
    capabilities: CapabilityBroker;
    documentState: DocumentStateWriter;
    components: HostComponentContractRegistry;
    authorityPolicy: HostAuthorityPolicy;
    now?: () => Date;
  }>) {
    this.#journal = input.journal;
    this.#resources = input.resources;
    this.#capabilities = input.capabilities;
    this.#documentState = input.documentState;
    this.#components = input.components;
    this.#authorityPolicy = input.authorityPolicy;
    this.#now = input.now ?? (() => new Date());
  }

  async handleCommand(
    commandInput: unknown,
    authorityInput: AuthorityContext,
    context: HostCommandContext,
  ): Promise<HostCommandResult> {
    const command = hostCommandEnvelopeSchema.parse(commandInput);
    if (!await verifyHostCommandEnvelope(command)) {
      throw new HostServerError("transport.command-payload-tampered", "Host command payload hash is invalid.");
    }
    const authority = createAuthorityContext(authorityInput);
    const session = await this.#authorize(command, authority);
    const existingReceipt = session.value.commandReceipts[command.commandId];
    if (existingReceipt) {
      if (existingReceipt.payloadHash !== command.payloadHash) {
        throw new HostServerError("transport.command-id-reused", "Command ID was reused with another payload.");
      }
      if (command.payload.type === "ack") {
        return {
          status: "acknowledged",
          acknowledgedThrough: session.value.acknowledgedThrough,
          replayed: true,
        };
      }
      const replay = await this.#journal.eventsForCommand(command);
      return replay === undefined
        ? { status: "snapshot-required", reason: "retention-gap" }
        : { status: "events", events: replay, replayed: true };
    }

    if (command.payload.type === "resume-request") {
      return this.#resume(command, session);
    }
    if (command.payload.type === "ack") {
      const result = await this.#journal.acknowledge(command);
      if (result.status === "invalid") {
        throw new HostServerError("transport.ack-invalid", "Ack does not identify a retained event exactly.");
      }
      if (result.status === "missing") {
        throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      }
      if (result.status === "conflict") {
        throw new HostServerError("transport.ack-conflict", "Ack changed concurrently too many times.");
      }
      if (result.status !== "acknowledged" && result.status !== "replayed") {
        throw new HostServerError("transport.ack-invalid", "Ack did not produce an acknowledged session.");
      }
      return {
        status: "acknowledged",
        acknowledgedThrough: result.session.value.acknowledgedThrough,
        replayed: result.status === "replayed",
      };
    }

    try {
      return await this.#commitCommand(command, authority, context);
    } catch (error) {
      const rejection = rejectionFrom(error);
      return this.#publishRejection(command, rejection);
    }
  }

  async #authorize(
    command: HostCommandEnvelope,
    authority: AuthorityContext,
  ): Promise<VersionedSurfaceSession> {
    const session = await this.#journal.get(command.surfaceSessionId);
    if (!session) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
    if (
      command.streamId !== session.value.streamId
      || command.epoch !== session.value.epoch
    ) throw new HostServerError("transport.stream-mismatch", "Host command stream or epoch does not match the Surface session.");
    if (Date.parse(session.value.expiresAt) <= this.#now().getTime()) {
      throw new HostServerError("policy.surface-expired", "Surface session has expired.");
    }
    if (
      authority.actorBindingHash !== session.value.authority.actorBindingHash
      || authority.tenantBindingHash !== session.value.authority.tenantBindingHash
      || hashAudienceBinding(authority) !== session.value.audienceBindingHash
    ) throw new HostServerError("policy.audience-mismatch", "Authority is not bound to this Surface audience.");
    const decision = await this.#authorityPolicy.authorize({
      session: session.value,
      authority,
      operation: command.payload.type,
    });
    if (!decision.allowed) throw new HostServerError(decision.code, decision.message);
    return session;
  }

  async #resume(
    command: HostCommandEnvelope,
    session: VersionedSurfaceSession,
  ): Promise<HostCommandResult> {
    if (command.payload.type !== "resume-request") throw new TypeError("Expected resume request.");
    const resumed = await this.#journal.resume({
      cursor: command.payload.request.cursor,
      surfaceSessionId: command.surfaceSessionId,
      audienceBindingHash: session.value.audienceBindingHash,
      now: this.#now(),
    });
    if (resumed.status === "events") {
      return { status: "events", events: resumed.events, replayed: false };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(command.surfaceSessionId);
      if (!current) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      const next = structuredClone(current.value);
      if (current.value.streamId !== command.streamId || current.value.epoch !== command.epoch) {
        throw new HostServerError("transport.stream-mismatch", "Surface lineage changed while the resume request was being handled.");
      }
      next.epoch = current.value.epoch + 1;
      next.acknowledgedThrough = 0;
      delete next.activeTransaction;
      delete next.activePreview;
      delete next.pendingRevisionPublication;
      const events: SurfaceEventDraft[] = [{
        correlationId: command.correlationId,
        causationId: causationIdSchema.parse(command.commandId),
        payload: snapshotPayload(next),
      }];
      const result = await this.#journal.commit({
        surfaceSessionId: command.surfaceSessionId,
        expectedVersion: current.version,
        next,
        command,
        events,
      });
      if (result.status === "conflict") continue;
      if (result.status === "missing") throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      return { status: "events", events: result.events, replayed: false };
    }
    throw new HostServerError("transport.resume-conflict", "Snapshot publication changed concurrently too many times.");
  }

  async #commitCommand(
    command: HostCommandEnvelope,
    authority: AuthorityContext,
    context: HostCommandContext,
  ): Promise<HostCommandResult> {
    if (command.payload.type === "resource-window-request") {
      return this.#resolveResourceCommand(command, authority);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(command.surfaceSessionId);
      if (!current) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      const prior = current.value.commandReceipts[command.commandId];
      if (prior) {
        if (prior.payloadHash !== command.payloadHash) {
          throw new HostServerError("transport.command-id-reused", "Command ID was reused with another payload.");
        }
        const replay = await this.#journal.eventsForCommand(command);
        return replay === undefined
          ? { status: "snapshot-required", reason: "retention-gap" }
          : { status: "events", events: replay, replayed: true };
      }
      const dispatched = await this.#dispatch(command, current.value, authority, context);
      const result = await this.#journal.commit({
        surfaceSessionId: command.surfaceSessionId,
        expectedVersion: current.version,
        next: dispatched.next,
        events: dispatched.events,
        command,
      });
      if (result.status === "conflict") continue;
      if (result.status === "missing") throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      return { status: "events", events: result.events, replayed: false };
    }
    throw new HostCommandRejected("transport.command-conflict", "transport", "Host command changed concurrently too many times.");
  }

  async #resolveResourceCommand(
    command: HostCommandEnvelope,
    authority: AuthorityContext,
  ): Promise<HostCommandResult> {
    if (command.payload.type !== "resource-window-request") {
      throw new TypeError("Expected resource window request.");
    }
    const request = resourceWindowRequestSchema.parse(command.payload.request);
    assertRequestSurface(request.surfaceSessionId, command.surfaceSessionId);
    if (request.requestId !== command.commandId) {
      throw rejected(
        "resource.request-identity-mismatch",
        "resource",
        "Resource request identity must match its Host command identity.",
      );
    }

    const reserved = await this.#reserveResourceResolution(command, request);
    let result: ResourceResolutionResult;
    try {
      result = await this.#resources.resolve({
        request,
        declaration: reserved.declaration,
        authority,
        activeRevisionId: reserved.identity.expectedRevisionId,
        stateValues: reserved.stateValues,
      });
    } catch (error) {
      await this.#releaseResourceResolution(command.surfaceSessionId, reserved.identity);
      throw error;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(command.surfaceSessionId);
      if (!current) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      const prior = current.value.commandReceipts[command.commandId];
      if (prior) {
        if (prior.payloadHash !== command.payloadHash) {
          throw new HostServerError("transport.command-id-reused", "Command ID was reused with another payload.");
        }
        const replay = await this.#journal.eventsForCommand(command);
        return replay === undefined
          ? { status: "snapshot-required", reason: "retention-gap" }
          : { status: "events", events: replay, replayed: true };
      }
      const activeIdentity = current.value.resourceResolutionIdentities[request.bindingId];
      if (
        !activeIdentity
        || canonicalStringify(activeIdentity) !== canonicalStringify(reserved.identity)
        || current.value.committedRevision.envelope.revisionId !== reserved.identity.expectedRevisionId
      ) {
        return this.#publishRejection(command, rejected(
          "resource.resolution-stale",
          "resource",
          "Resource resolution completed after its request identity was superseded.",
        ));
      }
      const resultBindingId = result.status === "resolved"
        ? result.snapshot.bindingId
        : result.unavailable.bindingId;
      if (resultBindingId !== reserved.identity.bindingId) {
        throw rejected(
          "resource.resolution-identity-mismatch",
          "resource",
          "Resource resolver returned a result for another binding.",
        );
      }
      const next = structuredClone(current.value);
      next.resources[request.bindingId] = result;
      const committed = await this.#journal.commit({
        surfaceSessionId: command.surfaceSessionId,
        expectedVersion: current.version,
        next,
        command,
        events: [{
          correlationId: command.correlationId,
          causationId: causationIdSchema.parse(command.commandId),
          payload: {
            type: "resource-resolved",
            identity: reserved.identity,
            result,
          },
        }],
      });
      if (committed.status === "conflict") continue;
      if (committed.status === "missing") {
        throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      }
      return { status: "events", events: committed.events, replayed: false };
    }
    throw rejected(
      "resource.resolution-conflict",
      "resource",
      "Resource resolution changed concurrently too many times.",
    );
  }

  async #reserveResourceResolution(
    command: HostCommandEnvelope,
    request: ReturnType<typeof resourceWindowRequestSchema.parse>,
  ): Promise<Readonly<{
    identity: ResourceResolutionIdentity;
    declaration: NonNullable<SurfaceSessionRecord["committedRevision"]["content"]["resourceBindings"][ResourceBindingId]>;
    stateValues: Record<StateId, JsonValue>;
  }>> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(command.surfaceSessionId);
      if (!current) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      const prior = current.value.commandReceipts[command.commandId];
      if (prior) {
        throw rejected(
          "resource.request-already-completed",
          "resource",
          "Resource request was already completed before reservation.",
        );
      }
      if (current.value.streamId !== command.streamId || current.value.epoch !== command.epoch) {
        throw rejected("transport.stream-mismatch", "transport", "Resource request stream identity is stale.");
      }
      if (request.expectedRevisionId !== current.value.committedRevision.envelope.revisionId) {
        throw rejected(
          "resource.revision-precondition-conflict",
          "resource",
          "Resource request revision precondition does not match the committed Surface.",
        );
      }
      const declaration = current.value.committedRevision.content.resourceBindings[request.bindingId];
      if (!declaration) {
        throw rejected("resource.binding-missing", "resource", "Resource binding is not committed on this Surface.");
      }
      const activeIdentity = current.value.resourceResolutionIdentities[request.bindingId];
      const activeResult = current.value.resources[request.bindingId];
      const activeVersion = activeResult?.status === "resolved"
        ? activeResult.snapshot.resourceVersionId
        : activeResult === undefined ? activeIdentity?.expectedResourceVersionId : undefined;
      if (request.expectedResourceVersionId !== activeVersion) {
        throw rejected(
          "resource.version-precondition-conflict",
          "resource",
          "Resource version precondition does not match the current resolution lineage.",
        );
      }

      let identity: ResourceResolutionIdentity;
      if (activeIdentity?.requestId === request.requestId) {
        const sameRequest = resourceIdentityFrom(request, activeIdentity.generation);
        if (canonicalStringify(sameRequest) !== canonicalStringify(activeIdentity)) {
          throw rejected(
            "resource.request-id-reused",
            "resource",
            "Resource request ID was reused with different preconditions.",
          );
        }
        identity = activeIdentity;
      } else {
        const generation = (activeIdentity?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) {
          throw rejected(
            "resource.generation-exhausted",
            "resource",
            "Resource resolution generation cannot advance safely.",
          );
        }
        identity = resourceIdentityFrom(request, generation);
      }

      const next = structuredClone(current.value);
      next.resourceResolutionIdentities[request.bindingId] = identity;
      delete next.resources[request.bindingId];
      const reserved = await this.#journal.commit({
        surfaceSessionId: command.surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [],
      });
      if (reserved.status === "conflict") continue;
      if (reserved.status === "missing") {
        throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      }
      return {
        identity,
        declaration,
        stateValues: stateValues(current.value),
      };
    }
    throw rejected(
      "resource.reservation-conflict",
      "resource",
      "Resource request changed concurrently too many times before resolution.",
    );
  }

  async #releaseResourceResolution(
    surfaceSessionId: SurfaceSessionId,
    identity: ResourceResolutionIdentity,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(surfaceSessionId);
      if (!current) return;
      const active = current.value.resourceResolutionIdentities[identity.bindingId];
      if (!active || canonicalStringify(active) !== canonicalStringify(identity)) return;
      const next = structuredClone(current.value);
      delete next.resourceResolutionIdentities[identity.bindingId];
      delete next.resources[identity.bindingId];
      const released = await this.#journal.commit({
        surfaceSessionId,
        expectedVersion: current.version,
        next,
        events: [],
      });
      if (released.status !== "conflict") return;
    }
  }

  async #dispatch(
    command: HostCommandEnvelope,
    session: SurfaceSessionRecord,
    authority: AuthorityContext,
    context: HostCommandContext,
  ): Promise<{ next: SurfaceSessionRecord; events: SurfaceEventDraft[] }> {
    const next = structuredClone(session);
    const causationId = causationIdSchema.parse(command.commandId);
    const draft = (payload: SurfaceEventDraft["payload"]): SurfaceEventDraft => ({
      correlationId: command.correlationId,
      causationId,
      payload,
    });
    switch (command.payload.type) {
      case "state-write-request": {
        const request = stateWriteRequestSchema.parse(command.payload.request);
        assertRequestSurface(request.surfaceSessionId, command.surfaceSessionId);
        if (
          request.documentId !== session.committedRevision.envelope.documentId
          || request.expectedRevisionId !== session.committedRevision.envelope.revisionId
        ) throw rejected("state.revision-conflict", "validate", "State write revision precondition does not match the committed Surface.");
        const definition = session.committedRevision.content.stateDefinitions[request.stateId];
        const currentState = session.state[request.stateId];
        if (!definition || !currentState) throw rejected("state.definition-missing", "validate", "Document state is not defined on this Surface.");
        if (definition.scope !== "document") throw rejected("state.scope-forbidden", "policy", "Surface-local state must be reduced in the browser Runtime.");
        const result = await this.#documentState.write({ request, definition, current: currentState, authority });
        if ("code" in result) {
          throw rejected(result.code, result.status === "conflict" ? "validate" : "policy", result.message);
        }
        next.state[request.stateId] = result.state;
        return { next, events: [draft({ type: "state-changed", state: result.state, receipt: result.receipt })] };
      }
      case "resource-window-request": {
        throw new TypeError("Resource resolution is reserved before asynchronous dispatch.");
      }
      case "action-trigger-request": {
        const request = actionTriggerRequestSchema.parse(command.payload.request);
        assertRequestSurface(request.surfaceSessionId, command.surfaceSessionId);
        return this.#triggerAction(request, next, authority, context, draft);
      }
      case "approval-decision": {
        const decision = approvalDecisionSchema.parse(command.payload.decision);
        const result = await this.#capabilities.decide(decision, capabilityAuthority(next, authority, context));
        const wasKnown = next.actions[result.accepted.invocationId] !== undefined;
        updateCapabilityState(next, result.status, result.approval);
        next.approvals = next.approvals.filter((approval) => approval.approvalToken !== decision.approvalToken);
        return {
          next,
          events: capabilityEvents(result, draft, wasKnown),
        };
      }
      case "cancel-request": {
        const request = command.payload.request;
        assertRequestSurface(request.surfaceSessionId, command.surfaceSessionId);
        if (request.target.kind === "transaction") {
          throw rejected("transaction.cancel-via-runtime", "commit", "Transaction cancellation must use the compiler/runtime commit bridge.");
        }
        const result = await this.#capabilities.cancel(
          request.target.invocationId,
          capabilityAuthority(next, authority, context),
        );
        updateCapabilityState(next, result.status, result.approval);
        return { next, events: capabilityEvents(result, draft, true, false) };
      }
      case "resume-request":
      case "ack":
        throw new TypeError("Resume and ack are handled before dispatch.");
    }
  }

  async #triggerAction(
    request: ActionTriggerRequest,
    next: SurfaceSessionRecord,
    authority: AuthorityContext,
    context: HostCommandContext,
    draft: (payload: SurfaceEventDraft["payload"]) => SurfaceEventDraft,
  ): Promise<{ next: SurfaceSessionRecord; events: SurfaceEventDraft[] }> {
    if (request.revisionId !== next.committedRevision.envelope.revisionId) {
      throw rejected("action.revision-conflict", "validate", "Action revision precondition does not match last-good.");
    }
    const node = next.committedRevision.content.nodes[request.nodeId];
    if (!node) throw rejected("action.node-missing", "validate", "Action node is not committed.");
    const componentInput = await this.#components.resolve(node.contract);
    if (!componentInput) throw rejected("action.component-contract-missing", "validate", "Exact Component Contract is unavailable.");
    const component = await verifyComponentContract(componentInput);
    if (contractRefKey(component.ref) !== contractRefKey(node.contract)) {
      throw rejected("action.component-contract-mismatch", "validate", "Resolved Component Contract identity does not match the node.");
    }
    const eventContract = component.events[request.eventPort];
    if (!eventContract) throw rejected("action.event-port-missing", "validate", "Event port is not declared by the Component Contract.");
    const eventPayload = z.fromJSONSchema(eventContract.payloadSchema).safeParse(request.eventPayload);
    if (!eventPayload.success) throw rejected("action.event-payload-invalid", "validate", "Event payload failed its exact Contract schema.");
    const actionId = node.events[request.eventPort];
    const action = actionId ? next.committedRevision.content.actions[actionId] : undefined;
    if (!actionId || !action) throw rejected("action.binding-missing", "validate", "Committed node event has no Action binding.");
    if (action.kind === "local-transition") {
      throw rejected("action.local-transition-client-only", "policy", "Local transitions execute only in SurfaceController.");
    }
    if (!eventContract.actionContracts.some((contract) => actionContractRefKey(contract) === actionContractRefKey(action.contract))) {
      throw rejected("action.contract-not-allowed", "policy", "Event port does not permit this Action Contract.");
    }
    assertActionPreconditions(action.input, request, next);
    const normalizedInput = materializeValueMap(action.input, {
      state: stateValues(next),
      resources: resourceValues(next.resources),
      event: { port: request.eventPort, payload: eventPayload.data as JsonValue },
      context: { locale: context.locale, timezone: context.timezone },
    });
    if (!normalizedInput.ok) {
      throw rejected(normalizedInput.diagnostic.code, "validate", normalizedInput.diagnostic.message);
    }
    const result = await this.#capabilities.trigger({
      requestId: request.requestId,
      actionId,
      contract: action.contract,
      normalizedInput: normalizedInput.value,
      idempotencyKey: request.idempotencyKey,
      authority: capabilityAuthority(next, authority, context),
      statePreconditions: request.statePreconditions,
      resourcePreconditions: request.resourcePreconditions,
    });
    const wasKnown = next.actions[result.accepted.invocationId] !== undefined;
    updateCapabilityState(next, result.status, result.approval);
    return { next, events: capabilityEvents(result, draft, wasKnown) };
  }

  async #publishRejection(
    command: HostCommandEnvelope,
    rejection: HostCommandRejected,
  ): Promise<HostCommandResult> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#journal.get(command.surfaceSessionId);
      if (!current) throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      const prior = current.value.commandReceipts[command.commandId];
      if (prior) {
        const replay = await this.#journal.eventsForCommand(command);
        return replay === undefined
          ? { status: "snapshot-required", reason: "retention-gap" }
          : { status: "events", events: replay, replayed: true };
      }
      const result = await this.#journal.commit({
        surfaceSessionId: command.surfaceSessionId,
        expectedVersion: current.version,
        next: current.value,
        command,
        events: [{
          correlationId: command.correlationId,
          causationId: causationIdSchema.parse(command.commandId),
          payload: {
            type: "rejected",
            requestId: requestIdFrom(command),
            diagnostics: [createDiagnostic({
              phase: rejection.phase,
              code: rejection.code,
              severity: "error",
              recoverable: true,
              modelCorrectable: false,
              message: rejection.message,
            })],
          },
        }],
      });
      if (result.status === "conflict") continue;
      if (result.status === "missing") throw new HostServerError("transport.surface-missing", "Surface session does not exist.");
      return { status: "events", events: result.events, replayed: false };
    }
    throw new HostServerError("transport.rejection-conflict", "Rejected command changed concurrently too many times.");
  }
}

export class HostServerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostServerError";
  }
}

class HostCommandRejected extends Error {
  constructor(
    readonly code: string,
    readonly phase: DiagnosticPhase,
    message: string,
  ) {
    super(message);
    this.name = "HostCommandRejected";
  }
}

function rejected(code: string, phase: DiagnosticPhase, message: string): HostCommandRejected {
  return new HostCommandRejected(code, phase, message);
}

function rejectionFrom(error: unknown): HostCommandRejected {
  if (error instanceof HostCommandRejected) return error;
  if (error instanceof CapabilityDeniedError) return rejected(error.code, "action", error.message);
  if (isResourceGatewayError(error)) return rejected(error.code, "resource", error.message);
  if (error instanceof z.ZodError) return rejected("validate.command-invalid", "validate", "Host command failed exact schema validation.");
  return rejected("transport.command-failed", "transport", "Host command failed before it could be committed.");
}

function isResourceGatewayError(error: unknown): error is ResourceGatewayError {
  return error instanceof Error
    && error.name === "ResourceGatewayError"
    && "code" in error
    && typeof error.code === "string";
}

function snapshotPayload(session: SurfaceSessionRecord): Extract<SurfaceEventDraft["payload"], { type: "snapshot-published" }> {
  return {
    type: "snapshot-published",
    snapshot: {
      revision: session.committedRevision,
      state: session.state,
      resources: session.resources,
      resourceResolutionIdentities: session.resourceResolutionIdentities,
      actions: session.actions,
      approvals: session.approvals,
    },
    streamPolicy: session.streamPolicy,
  };
}

function stateValues(session: SurfaceSessionRecord): Record<StateId, JsonValue> {
  return Object.fromEntries(Object.entries(session.state).map(([stateId, state]) => [stateId, state.value])) as Record<StateId, JsonValue>;
}

function resourceValues(
  resources: Readonly<Record<ResourceBindingId, ResourceResolutionResult>>,
): Record<ResourceBindingId, JsonValue> {
  const values = {} as Record<ResourceBindingId, JsonValue>;
  for (const [bindingIdText, result] of Object.entries(resources)) {
    const bindingId = bindingIdText as ResourceBindingId;
    if (result.status !== "resolved") continue;
    values[bindingId] = result.snapshot.payload.kind === "json"
      ? result.snapshot.payload.value
      : result.snapshot.payload.asset as unknown as JsonValue;
  }
  return values;
}

function assertRequestSurface(actual: SurfaceSessionId, expected: SurfaceSessionId): void {
  if (actual !== expected) throw rejected("transport.surface-mismatch", "transport", "Nested request Surface identity does not match its envelope.");
}

function resourceIdentityFrom(
  request: ReturnType<typeof resourceWindowRequestSchema.parse>,
  generation: number,
): ResourceResolutionIdentity {
  return resourceResolutionIdentitySchema.parse({
    requestId: request.requestId,
    generation,
    bindingId: request.bindingId,
    expectedRevisionId: request.expectedRevisionId,
    ...(request.expectedResourceVersionId === undefined
      ? {}
      : { expectedResourceVersionId: request.expectedResourceVersionId }),
    ...(request.serverCursor === undefined ? {} : { serverCursor: request.serverCursor }),
  });
}

function collectRefs(expressions: Readonly<Record<string, ValueExpr>>): {
  state: Set<StateId>;
  resources: Set<ResourceBindingId>;
} {
  const state = new Set<StateId>();
  const resources = new Set<ResourceBindingId>();
  const visit = (expression: ValueExpr): void => {
    if (expression.kind === "state-ref" || expression.kind === "state-id-ref") state.add(expression.stateId);
    else if (expression.kind === "resource-ref" || expression.kind === "resource-id-ref") resources.add(expression.bindingId);
    else if (expression.kind === "array") expression.items.forEach(visit);
    else if (expression.kind === "object") Object.values(expression.entries).forEach(visit);
    else if (expression.kind === "condition") expression.args.forEach(visit);
  };
  Object.values(expressions).forEach(visit);
  return { state, resources };
}

function assertActionPreconditions(
  expressions: Readonly<Record<string, ValueExpr>>,
  request: ActionTriggerRequest,
  session: SurfaceSessionRecord,
): void {
  const required = collectRefs(expressions);
  for (const stateId of required.state) {
    if (!request.statePreconditions[stateId]) throw rejected("action.state-precondition-missing", "validate", `Action state precondition is missing for ${stateId}.`);
  }
  for (const bindingId of required.resources) {
    if (!request.resourcePreconditions[bindingId]) throw rejected("action.resource-precondition-missing", "validate", `Action resource precondition is missing for ${bindingId}.`);
  }
  for (const [stateIdText, expected] of Object.entries(request.statePreconditions)) {
    const stateId = stateIdText as StateId;
    if (session.state[stateId]?.stateRevisionId !== expected) {
      throw rejected("action.state-precondition-conflict", "validate", `Action state precondition changed for ${stateId}.`);
    }
  }
  for (const [bindingIdText, expected] of Object.entries(request.resourcePreconditions)) {
    const bindingId = bindingIdText as ResourceBindingId;
    const resource = session.resources[bindingId];
    if (resource?.status !== "resolved" || resource.snapshot.resourceVersionId !== expected) {
      throw rejected("action.resource-precondition-conflict", "validate", `Action resource precondition changed for ${bindingId}.`);
    }
  }
}

function capabilityAuthority(
  session: SurfaceSessionRecord,
  authority: AuthorityContext,
  context: HostCommandContext,
): CapabilityAuthority {
  return {
    actorBindingHash: authority.actorBindingHash,
    tenantBindingHash: authority.tenantBindingHash,
    authorityPolicyRevision: authority.authorityPolicyRevision,
    surfaceSessionId: session.surfaceSessionId,
    revisionId: session.committedRevision.envelope.revisionId,
    operationScope: context.operationScope,
  };
}

function updateCapabilityState(
  session: SurfaceSessionRecord,
  status: Parameters<typeof updateActionStatus>[1],
  approval?: SurfaceSessionRecord["approvals"][number],
): void {
  updateActionStatus(session, status);
  if (approval && !session.approvals.some((candidate) => candidate.approvalToken === approval.approvalToken)) {
    session.approvals.push(approval);
  }
}

function updateActionStatus(
  session: SurfaceSessionRecord,
  status: SurfaceSessionRecord["actions"][ActionInvocationId],
): void {
  session.actions[status.invocationId] = status;
}

function capabilityEvents(
  result: Awaited<ReturnType<CapabilityBroker["trigger"]>>,
  draft: (payload: SurfaceEventDraft["payload"]) => SurfaceEventDraft,
  wasKnown: boolean,
  includeAccepted = true,
): SurfaceEventDraft[] {
  const events: SurfaceEventDraft[] = [];
  if (includeAccepted && !wasKnown) events.push(draft({ type: "action-accepted", action: result.accepted }));
  events.push(draft({ type: "action-status", action: result.status }));
  if (result.approval) events.push(draft({ type: "approval-requested", approval: result.approval }));
  if (result.receipt) events.push(draft({ type: "effect-receipt", receipt: result.receipt }));
  return events;
}

function requestIdFrom(command: HostCommandEnvelope) {
  const payload = command.payload;
  if (payload.type === "approval-decision") return payload.decision.requestId;
  if (payload.type === "ack") return command.commandId;
  return payload.request.requestId;
}
