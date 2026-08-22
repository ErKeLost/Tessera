import {
  actionInvocationIdSchema,
  canonicalStringify,
  correlationIdSchema,
  createDiagnostic,
  eventPortSchema,
  idempotencyKeySchema,
  jsonValueSchema,
  nodeIdSchema,
  opaqueServerCursorSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  singleUseApprovalTokenSchema,
  stateIdSchema,
  surfaceEventEnvelopeSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  type ActionInvocationId,
  type ApprovalDecision,
  type CanonicalNode,
  type Diagnostic,
  type DocumentId,
  type EffectReceipt,
  type EventId,
  type EventPort,
  type HashProvider,
  type HostCommandEnvelope,
  type HostCommandPayload,
  type JsonObject,
  type JsonValue,
  type NodeId,
  type RequestId,
  type ResumeCursor,
  type RevisionId,
  type ResourceBindingId,
  type ResourceResolutionIdentity,
  type ResourceResolutionResult,
  type Sha256Hash,
  type SingleUseApprovalToken,
  type StateId,
  type StateValueSnapshot,
  type StreamId,
  type SurfaceEventEnvelope,
  type SurfaceSessionId,
  type SurfaceSnapshot,
  type TransactionId,
} from "@open-generative/protocol";
import {
  sameActionContractRef,
  type ComponentContract,
} from "@open-generative/catalog";
import {
  collectValueExprDependencies,
  createSurfaceReplayState,
  immutableClone,
  latestRenderableOverlay,
  materializeNodeProps,
  renderableRootNodeId,
  reduceSurfaceLocalAction,
  reduceTrustedSurfaceEvent,
  resolveRenderableNode,
  type SurfaceReplayState,
  type SurfaceStateChange,
  type SurfaceStateMap,
  type SurfaceStateValidationPort,
} from "@open-generative/runtime";
import { z } from "zod";
import { BrowserContractRegistry, type ClientValidationIssue } from "./browser-contracts";
import {
  createBrowserCommandIdentityFactory,
  createHostCommandEnvelope,
  type ActionCommandDispatchOptions,
  type HostCommandDispatchOptions,
  type HostCommandIdentityFactory,
  type HostCommandTransport,
} from "./commands";

export type SurfaceControllerStatus = "awaiting-snapshot" | "ready" | "resync-required";

export type SurfaceControllerReplayOptions = Readonly<{
  maxDiagnostics?: number;
  maxRememberedEvents?: number;
}>;

export type SurfaceControllerPreview = Readonly<{
  transactionId: TransactionId;
  baseRevisionId: RevisionId;
  overlaySequence: number;
  overlayHash: Sha256Hash;
  renderableNodeIds: readonly NodeId[];
}>;

export type SurfaceControllerSnapshot = Readonly<{
  version: number;
  status: SurfaceControllerStatus;
  surfaceSessionId: SurfaceSessionId;
  streamId?: StreamId;
  epoch?: number;
  acceptedThroughSequence: number;
  acknowledgedThroughSequence: number;
  cursor?: ResumeCursor;
  documentId?: DocumentId;
  committedRevisionId?: RevisionId;
  contractSetHash?: Sha256Hash;
  rootNodeId?: NodeId;
  preview?: SurfaceControllerPreview;
  actions: SurfaceSnapshot["actions"];
  approvals: SurfaceSnapshot["approvals"];
  effectReceipts: Readonly<Record<string, EffectReceipt>>;
  diagnostics: readonly Diagnostic[];
}>;

export type NodeScopedStateBinding = Readonly<{
  stateId: StateId;
  value: JsonValue;
  stateRevisionId?: StateValueSnapshot["stateRevisionId"];
  schemaHash: Sha256Hash;
  scope: StateValueSnapshot["scope"];
}>;

export type NodeScopedResourceBinding = Readonly<{
  bindingId: ResourceBindingId;
  identity?: ResourceResolutionIdentity;
  result?: ResourceResolutionResult;
}>;

export type NodeProjectionMode = "committed" | "read-only-preview";
export type NodeProjectionStatus = "ready" | "unresolved" | "invalid" | "unsupported-contract";

export type ResourceWindowCommandOptions = HostCommandDispatchOptions & Readonly<{
  next?: boolean;
}>;

export type LocalTransitionDispatchResult = Readonly<{
  kind: "local-transition";
  requestId: RequestId;
  changes: readonly SurfaceStateChange[];
  focusNodeIds: readonly NodeId[];
}>;

export type HostIntentDispatchResult = Readonly<{
  kind: "host-command";
  command: HostCommandEnvelope;
}>;

export type NodeEventDispatchResult = LocalTransitionDispatchResult | HostIntentDispatchResult;

export interface NodeCommandBridge {
  writeState?: (
    stateId: StateId,
    value: JsonValue,
    options?: HostCommandDispatchOptions,
  ) => Promise<HostCommandEnvelope>;
  requestResource(
    bindingId: ResourceBindingId,
    options?: ResourceWindowCommandOptions,
  ): Promise<HostCommandEnvelope>;
  emit?: (
    port: EventPort,
    payload: JsonValue,
    options?: ActionCommandDispatchOptions,
  ) => Promise<NodeEventDispatchResult>;
}

export type NodeProjection = Readonly<{
  nodeId: NodeId;
  revisionId: RevisionId;
  projectionMode: NodeProjectionMode;
  status: NodeProjectionStatus;
  node: CanonicalNode;
  contract?: ComponentContract;
  resolvedProps?: JsonObject;
  stateBindings: Readonly<Record<StateId, NodeScopedStateBinding>>;
  resourceBindings: Readonly<Record<ResourceBindingId, NodeScopedResourceBinding>>;
  diagnostics: readonly Diagnostic[];
  commands?: NodeCommandBridge;
}>;

export type SurfaceConsumeStatus = "applied" | "buffered" | "replayed" | "rejected" | "resync-required";

export type SurfaceConsumeResult = Readonly<{
  status: SurfaceConsumeStatus;
  snapshot: SurfaceControllerSnapshot;
  issues: readonly Diagnostic[];
  acknowledgement?: HostCommandEnvelope;
}>;

export type SurfaceControllerOptions = Readonly<{
  surfaceSessionId: SurfaceSessionId;
  audienceBindingHash: Sha256Hash;
  contracts: BrowserContractRegistry;
  transport: HostCommandTransport;
  identities?: HostCommandIdentityFactory;
  hashProvider?: HashProvider;
  replay?: SurfaceControllerReplayOptions;
  context?: Readonly<{ locale: string; timezone: string }>;
  stateValidation?: SurfaceStateValidationPort;
  autoAcknowledge?: boolean;
  clock?: () => Date;
}>;

export class SurfaceControllerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SurfaceControllerError";
    this.code = code;
  }
}

export class SurfaceController {
  readonly surfaceSessionId: SurfaceSessionId;
  readonly #audienceBindingHash: Sha256Hash;
  readonly #contracts: BrowserContractRegistry;
  readonly #transport: HostCommandTransport;
  readonly #identities: HostCommandIdentityFactory;
  readonly #hashProvider: HashProvider | undefined;
  readonly #replayOptions: SurfaceControllerReplayOptions;
  readonly #context: Readonly<{ locale: string; timezone: string }> | undefined;
  readonly #stateValidation: SurfaceStateValidationPort;
  readonly #autoAcknowledge: boolean;
  readonly #clock: () => Date;
  readonly #listeners = new Set<(snapshot: SurfaceControllerSnapshot) => void>();
  #replay: Readonly<SurfaceReplayState>;
  #localState: Readonly<SurfaceStateMap> = Object.freeze({}) as Readonly<SurfaceStateMap>;
  #acknowledgedThrough = 0;
  #version = 0;
  #snapshot: SurfaceControllerSnapshot;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: SurfaceControllerOptions) {
    this.surfaceSessionId = surfaceSessionIdSchema.parse(options.surfaceSessionId);
    this.#audienceBindingHash = sha256HashSchema.parse(options.audienceBindingHash);
    this.#contracts = options.contracts;
    this.#transport = options.transport;
    this.#identities = options.identities ?? createBrowserCommandIdentityFactory();
    this.#hashProvider = options.hashProvider;
    this.#replayOptions = options.replay ?? {};
    this.#context = options.context === undefined
      ? undefined
      : Object.freeze({ locale: options.context.locale, timezone: options.context.timezone });
    this.#stateValidation = options.stateValidation ?? createExactStateValidationPort();
    this.#autoAcknowledge = options.autoAcknowledge ?? true;
    this.#clock = options.clock ?? (() => new Date());
    this.#replay = immutableClone({
      ...createSurfaceReplayState(),
      surfaceSessionId: this.surfaceSessionId,
    });
    this.#snapshot = this.#deriveSnapshot();
  }

  getSnapshot(): SurfaceControllerSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: SurfaceControllerSnapshot) => void): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  consume(input: unknown): Promise<SurfaceConsumeResult> {
    return this.#enqueue(() => this.#consumeNow(input));
  }

  bindNode(nodeIdInput: NodeId): NodeProjection | undefined {
    this.#assertActive();
    const nodeId = nodeIdSchema.parse(nodeIdInput);
    const lastGood = this.#replay.lastGood;
    if (!lastGood || this.#replay.requiresSnapshot) return undefined;
    const overlay = latestRenderableOverlay(this.#replay);
    const renderable = resolveRenderableNode(this.#replay, nodeId);
    if (!renderable) return undefined;
    const fromPreview = renderable.projectionMode === "read-only-preview";
    const document = fromPreview ? overlay!.document : lastGood.revision.content;
    const node = renderable.node;
    const revisionId = lastGood.revision.envelope.revisionId;
    const registration = this.#contracts.get(node.contract);
    const dependencies = collectValueExprDependencies(node.props);
    const stateBindings = this.#nodeStateBindings(document, dependencies.stateIds);
    const resourceBindings = this.#nodeResourceBindings(dependencies.resourceBindingIds);
    const projectionMode: NodeProjectionMode = fromPreview ? "read-only-preview" : "committed";

    if (!registration) {
      return immutableClone({
        nodeId,
        revisionId,
        projectionMode,
        status: "unsupported-contract",
        node,
        stateBindings,
        resourceBindings,
        diagnostics: [renderDiagnostic(
          "client.contract-unsupported",
          "The node Contract is not present in the verified browser registry.",
          nodeId,
          revisionId,
        )],
      });
    }

    const structure = this.#contracts.validateNodeStructure(nodeId, node, document);
    if (!structure.ok) {
      return freezeProjection({
        nodeId,
        revisionId,
        projectionMode,
        status: "invalid",
        node,
        contract: registration.contract,
        stateBindings,
        resourceBindings,
        diagnostics: structure.issues.map((issue) => validationDiagnostic(issue, nodeId, revisionId)),
        ...(fromPreview ? {} : {
          commands: this.#createNodeBridge(nodeId, revisionId, node.contract, false),
        }),
      });
    }

    const stateValues = {} as Record<StateId, JsonValue>;
    for (const [stateIdText, binding] of Object.entries(stateBindings)) {
      stateValues[stateIdText as StateId] = binding.value;
    }
    const resourceValues = {} as Record<ResourceBindingId, JsonValue>;
    for (const [bindingIdText, binding] of Object.entries(resourceBindings)) {
      const value = resourceResultValue(binding.result);
      if (value !== undefined) resourceValues[bindingIdText as ResourceBindingId] = value;
    }
    const materialized = materializeNodeProps(node, {
      state: stateValues,
      resources: resourceValues,
      context: this.#context,
    });
    if (!materialized.ok) {
      return freezeProjection({
        nodeId,
        revisionId,
        projectionMode,
        status: "unresolved",
        node,
        contract: registration.contract,
        stateBindings,
        resourceBindings,
        diagnostics: [{
          ...materialized.diagnostic,
          location: { revisionId, entity: { kind: "node", id: nodeId } },
        }],
        ...(fromPreview ? {} : {
          commands: this.#createNodeBridge(nodeId, revisionId, node.contract, false),
        }),
      });
    }
    const validated = this.#contracts.validateResolvedProps(node.contract, materialized.value);
    if (!validated.ok) {
      return freezeProjection({
        nodeId,
        revisionId,
        projectionMode,
        status: "invalid",
        node,
        contract: registration.contract,
        stateBindings,
        resourceBindings,
        diagnostics: validated.issues.map((issue) => validationDiagnostic(issue, nodeId, revisionId)),
        ...(fromPreview ? {} : {
          commands: this.#createNodeBridge(nodeId, revisionId, node.contract, false),
        }),
      });
    }
    const projection: NodeProjection = {
      nodeId,
      revisionId,
      projectionMode,
      status: "ready",
      node,
      contract: registration.contract,
      resolvedProps: validated.value,
      stateBindings,
      resourceBindings,
      diagnostics: [],
      ...(fromPreview ? {} : {
        commands: this.#createNodeBridge(nodeId, revisionId, node.contract, true),
      }),
    };
    return freezeProjection(projection);
  }

  acknowledge(options: HostCommandDispatchOptions = {}): Promise<HostCommandEnvelope | undefined> {
    return this.#enqueue(() => this.#acknowledgeNow(options));
  }

  resume(options: HostCommandDispatchOptions = {}): Promise<HostCommandEnvelope> {
    return this.#enqueue(() => this.#resumeNow(options));
  }

  decideApproval(
    approvalTokenInput: SingleUseApprovalToken,
    decisionInput: ApprovalDecision["decision"],
    options: HostCommandDispatchOptions = {},
  ): Promise<HostCommandEnvelope> {
    return this.#enqueue(async () => {
      const lastGood = this.#requireLastGood();
      const approvalToken = singleUseApprovalTokenSchema.parse(approvalTokenInput);
      const approval = lastGood.approvals.find((candidate) => candidate.approvalToken === approvalToken);
      if (!approval || approval.surfaceSessionId !== this.surfaceSessionId) {
        throw controllerError("client.approval-out-of-scope", "Approval token is not pending on this Surface.");
      }
      if (approval.revisionId !== lastGood.revision.envelope.revisionId) {
        throw controllerError("client.approval-stale", "Approval token belongs to an older committed revision.");
      }
      const requestId = this.#requestId(options.requestId);
      return this.#send({
        type: "approval-decision",
        decision: { requestId, approvalToken, decision: decisionInput },
      }, requestId, options);
    });
  }

  cancelAction(
    invocationIdInput: ActionInvocationId,
    options: HostCommandDispatchOptions = {},
  ): Promise<HostCommandEnvelope> {
    return this.#enqueue(async () => {
      const lastGood = this.#requireLastGood();
      const invocationId = actionInvocationIdSchema.parse(invocationIdInput);
      if (!lastGood.actions[invocationId]) {
        throw controllerError("client.action-out-of-scope", "Action invocation is not active on this Surface.");
      }
      const requestId = this.#requestId(options.requestId);
      return this.#send({
        type: "cancel-request",
        request: {
          requestId,
          surfaceSessionId: this.surfaceSessionId,
          target: { kind: "action", invocationId },
        },
      }, requestId, options);
    });
  }

  cancelPreview(
    transactionIdInput: TransactionId,
    options: HostCommandDispatchOptions = {},
  ): Promise<HostCommandEnvelope> {
    return this.#enqueue(async () => {
      this.#requireLastGood();
      const transactionId = transactionIdSchema.parse(transactionIdInput);
      const overlay = latestRenderableOverlay(this.#replay);
      if (!overlay || overlay.transactionId !== transactionId) {
        throw controllerError("client.preview-out-of-scope", "Transaction is not the active Surface preview.");
      }
      const requestId = this.#requestId(options.requestId);
      return this.#send({
        type: "cancel-request",
        request: {
          requestId,
          surfaceSessionId: this.surfaceSessionId,
          target: { kind: "transaction", transactionId },
        },
      }, requestId, options);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  async #consumeNow(input: unknown): Promise<SurfaceConsumeResult> {
    const parsed = surfaceEventEnvelopeSchema.safeParse(input);
    if (parsed.success) {
      const bindingIssue = this.#bindingIssue(parsed.data);
      if (bindingIssue) {
        this.#forceSnapshot(bindingIssue);
        this.#publish();
        return {
          status: "resync-required",
          snapshot: this.#snapshot,
          issues: Object.freeze([bindingIssue]),
        };
      }
    }

    const before = this.#replay;
    const previousStreamId = before.streamId;
    const previousEpoch = before.epoch;
    const result = await reduceTrustedSurfaceEvent(before, input, {
      ...this.#replayOptions,
      hashProvider: this.#hashProvider,
      stateValidation: this.#stateValidation,
    });
    this.#replay = result.state;
    if (result.status === "resync-required") {
      this.#localState = Object.freeze({}) as Readonly<SurfaceStateMap>;
    } else if (result.status === "applied" && parsed.success) {
      this.#synchronizeLocalState(before);
      if (
        previousStreamId !== undefined
        && (previousStreamId !== this.#replay.streamId || previousEpoch !== this.#replay.epoch)
      ) this.#acknowledgedThrough = 0;
    }
    if (result.status !== "replayed" && this.#replay !== before) this.#publish();

    let acknowledgement: HostCommandEnvelope | undefined;
    if (
      this.#autoAcknowledge
      && result.status === "applied"
      && !this.#replay.requiresSnapshot
      && this.#shouldAcknowledge()
    ) acknowledgement = await this.#acknowledgeNow();
    return {
      status: result.status,
      snapshot: this.#snapshot,
      issues: result.issues,
      ...(acknowledgement === undefined ? {} : { acknowledgement }),
    };
  }

  #bindingIssue(event: SurfaceEventEnvelope): Diagnostic | undefined {
    if (event.audienceBindingHash !== this.#audienceBindingHash) {
      return transportDiagnostic(
        "client.audience-binding-mismatch",
        "Surface event audience binding does not match this controller.",
        event,
      );
    }
    if (event.contractSetHash !== this.#contracts.contractSetHash) {
      return transportDiagnostic(
        "client.contract-set-mismatch",
        "Surface event Contract set does not match the verified browser registry.",
        event,
      );
    }
    return undefined;
  }

  #forceSnapshot(diagnostic: Diagnostic): void {
    this.#replay = immutableClone({
      ...this.#replay,
      overlays: {},
      overlayOrder: [],
      buffered: {},
      bufferedBytes: 0,
      diagnostics: [...this.#replay.diagnostics, diagnostic],
      requiresSnapshot: true,
    });
    this.#localState = Object.freeze({}) as Readonly<SurfaceStateMap>;
  }

  #synchronizeLocalState(before: Readonly<SurfaceReplayState>): void {
    if (!this.#replay.lastGood) {
      this.#localState = Object.freeze({}) as Readonly<SurfaceStateMap>;
      return;
    }
    if (
      !before.lastGood
      || before.streamId !== this.#replay.streamId
      || before.epoch !== this.#replay.epoch
    ) {
      this.#localState = immutableClone(this.#replay.lastGood.state);
      return;
    }
    const next = { ...this.#localState } as SurfaceStateMap;
    for (const [stateIdText, snapshot] of Object.entries(this.#replay.lastGood.state)) {
      const stateId = stateIdText as StateId;
      if (before.lastGood.state[stateId]?.stateRevisionId !== snapshot.stateRevisionId) {
        next[stateId] = snapshot;
      }
    }
    const definitions = this.#replay.lastGood.revision.content.stateDefinitions;
    for (const [stateIdText, snapshot] of Object.entries(next)) {
      const stateId = stateIdText as StateId;
      const definition = definitions[stateId];
      if (
        !definition
        || definition.schemaHash !== snapshot.schemaHash
        || definition.scope !== snapshot.scope
      ) delete next[stateId];
    }
    this.#localState = immutableClone(next);
  }

  #nodeStateBindings(
    document: NonNullable<SurfaceReplayState["lastGood"]>["revision"]["content"],
    stateIds: readonly StateId[],
  ): Readonly<Record<StateId, NodeScopedStateBinding>> {
    const bindings = {} as Record<StateId, NodeScopedStateBinding>;
    for (const stateId of stateIds) {
      const definition = document.stateDefinitions[stateId];
      if (!definition) continue;
      const local = this.#localState[stateId];
      const trusted = this.#replay.lastGood?.state[stateId];
      const snapshot = [local, trusted].find((candidate) => (
        candidate?.schemaHash === definition.schemaHash && candidate.scope === definition.scope
      ));
      bindings[stateId] = {
        stateId,
        value: snapshot?.value ?? definition.initial,
        ...(snapshot === undefined ? {} : { stateRevisionId: snapshot.stateRevisionId }),
        schemaHash: definition.schemaHash,
        scope: definition.scope,
      };
    }
    return immutableClone(bindings);
  }

  #nodeResourceBindings(
    bindingIds: readonly ResourceBindingId[],
  ): Readonly<Record<ResourceBindingId, NodeScopedResourceBinding>> {
    const bindings = {} as Record<ResourceBindingId, NodeScopedResourceBinding>;
    for (const bindingId of bindingIds) {
      const result = this.#replay.lastGood?.resources[bindingId];
      const identity = this.#replay.lastGood?.resourceResolutionIdentities[bindingId];
      bindings[bindingId] = {
        bindingId,
        ...(identity === undefined ? {} : { identity }),
        ...(result === undefined ? {} : { result }),
      };
    }
    return immutableClone(bindings);
  }

  #createNodeBridge(
    nodeId: NodeId,
    revisionId: NodeProjection["revisionId"],
    contract: NodeProjection["node"]["contract"],
    allowInteraction: boolean,
  ): NodeCommandBridge {
    const bridge: NodeCommandBridge = {
      requestResource: (bindingId, options) => this.#enqueue(
        () => this.#requestResourceNow(nodeId, revisionId, contract, bindingId, options),
      ),
      ...(allowInteraction ? {
        writeState: (stateId: StateId, value: JsonValue, options?: HostCommandDispatchOptions) => this.#enqueue(
          () => this.#writeStateNow(nodeId, revisionId, contract, stateId, value, options),
        ),
        emit: (port: EventPort, payload: JsonValue, options?: ActionCommandDispatchOptions) => this.#enqueue(
          () => this.#emitNow(nodeId, revisionId, contract, port, payload, options),
        ),
      } : {}),
    };
    return Object.freeze(bridge);
  }

  async #writeStateNow(
    nodeId: NodeId,
    revisionId: NodeProjection["revisionId"],
    contract: NodeProjection["node"]["contract"],
    stateIdInput: StateId,
    valueInput: JsonValue,
    options: HostCommandDispatchOptions = {},
  ): Promise<HostCommandEnvelope> {
    const { lastGood, node, scope } = this.#assertNodeCommandScope(nodeId, revisionId, contract);
    const stateId = stateIdSchema.parse(stateIdInput);
    if (!scope.stateIds.includes(stateId)) {
      throw controllerError("client.state-out-of-scope", `State ${stateId} is not scoped to node ${nodeId}.`);
    }
    const definition = lastGood.revision.content.stateDefinitions[stateId];
    const snapshot = this.#localState[stateId] ?? lastGood.state[stateId];
    if (!definition || !snapshot) {
      throw controllerError("client.state-uninitialized", `State ${stateId} has no revision precondition.`);
    }
    if (snapshot.schemaHash !== definition.schemaHash || snapshot.scope !== definition.scope) {
      throw controllerError("client.state-stale", `State ${stateId} does not match its committed definition.`);
    }
    const value = jsonValueSchema.parse(valueInput);
    const requestId = this.#requestId(options.requestId);
    return this.#send({
      type: "state-write-request",
      request: {
        requestId,
        surfaceSessionId: this.surfaceSessionId,
        documentId: lastGood.revision.envelope.documentId,
        expectedRevisionId: revisionId,
        stateId,
        expectedStateRevisionId: snapshot.stateRevisionId,
        value,
      },
    }, requestId, options);
  }

  async #requestResourceNow(
    nodeId: NodeId,
    revisionId: NodeProjection["revisionId"],
    contract: NodeProjection["node"]["contract"],
    bindingIdInput: ResourceBindingId,
    options: ResourceWindowCommandOptions = {},
  ): Promise<HostCommandEnvelope> {
    const { lastGood, scope } = this.#assertNodeCommandScope(nodeId, revisionId, contract);
    const bindingId = resourceBindingIdSchema.parse(bindingIdInput);
    if (!scope.resourceBindingIds.includes(bindingId)) {
      throw controllerError(
        "client.resource-out-of-scope",
        `Resource ${bindingId} is not scoped to node ${nodeId}.`,
      );
    }
    if (!lastGood.revision.content.resourceBindings[bindingId]) {
      throw controllerError("client.resource-missing", `Resource ${bindingId} is not committed.`);
    }
    const current = lastGood.resources[bindingId];
    let serverCursor;
    if (options.next) {
      if (current?.status !== "resolved" || current.snapshot.nextCursor === undefined) {
        throw controllerError("client.resource-cursor-missing", `Resource ${bindingId} has no next window.`);
      }
      serverCursor = opaqueServerCursorSchema.parse(current.snapshot.nextCursor);
    }
    const requestId = this.#requestId(options.requestId);
    return this.#send({
      type: "resource-window-request",
      request: {
        requestId,
        bindingId,
        surfaceSessionId: this.surfaceSessionId,
        expectedRevisionId: revisionId,
        ...(current?.status === "resolved"
          ? { expectedResourceVersionId: current.snapshot.resourceVersionId }
          : {}),
        ...(serverCursor === undefined ? {} : { serverCursor }),
      },
    }, requestId, options);
  }

  async #emitNow(
    nodeId: NodeId,
    revisionId: NodeProjection["revisionId"],
    contractRef: NodeProjection["node"]["contract"],
    portInput: EventPort,
    payloadInput: JsonValue,
    options: ActionCommandDispatchOptions = {},
  ): Promise<NodeEventDispatchResult> {
    const { lastGood, node } = this.#assertNodeCommandScope(nodeId, revisionId, contractRef);
    const port = eventPortSchema.parse(portInput);
    const registration = this.#contracts.get(contractRef);
    if (!registration) throw controllerError("client.contract-unsupported", "Node Contract is unavailable.");
    const eventContract = registration.contract.events[port];
    if (!eventContract) {
      throw controllerError("client.event-port-out-of-scope", `Event port ${port} is not declared by the node Contract.`);
    }
    const payload = this.#contracts.validateEventPayload(contractRef, port, payloadInput);
    if (!payload.ok) {
      const message = payload.issues.map((issue) => issue.message).join("; ");
      throw controllerError("client.event-payload-invalid", message);
    }
    const actionId = node.events[port];
    const action = actionId === undefined ? undefined : lastGood.revision.content.actions[actionId];
    if (!actionId || !action) {
      throw controllerError("client.event-unbound", `Event port ${port} has no committed action binding.`);
    }
    const requestId = this.#requestId(options.requestId);
    if (action.kind === "local-transition") {
      const reduced = await reduceSurfaceLocalAction({
        surfaceSessionId: this.surfaceSessionId,
        requestId,
        actionId,
        document: lastGood.revision.content,
        state: this.#effectiveStateMap(lastGood.revision.content),
        resources: this.#resolvedResourceValues(lastGood.resources),
        event: { port, payload: payload.value },
        context: this.#context,
      }, this.#stateValidation, this.#hashProvider);
      if (!reduced.ok) {
        throw controllerError(
          "client.local-transition-rejected",
          reduced.issues.map((issue) => issue.message).join("; "),
        );
      }
      this.#localState = reduced.state;
      this.#publish();
      return Object.freeze({
        kind: "local-transition",
        requestId,
        changes: reduced.changes,
        focusNodeIds: reduced.focusNodeIds,
      });
    }

    if (!eventContract.actionContracts.some((allowed) => sameActionContractRef(allowed, action.contract))) {
      throw controllerError(
        "client.action-contract-out-of-scope",
        "The node action Contract is not permitted by its Component Contract event port.",
      );
    }
    const dependencies = collectValueExprDependencies(action.input);
    const statePreconditions = {} as Record<StateId, StateValueSnapshot["stateRevisionId"]>;
    for (const stateId of dependencies.stateIds) {
      const snapshot = this.#localState[stateId] ?? lastGood.state[stateId];
      if (!snapshot) {
        throw controllerError("client.action-state-unresolved", `Action state ${stateId} has no revision precondition.`);
      }
      statePreconditions[stateId] = snapshot.stateRevisionId;
    }
    const resourcePreconditions = {} as Record<
      ResourceBindingId,
      Extract<ResourceResolutionResult, { status: "resolved" }>["snapshot"]["resourceVersionId"]
    >;
    for (const bindingId of dependencies.resourceBindingIds) {
      const result = lastGood.resources[bindingId];
      if (result?.status !== "resolved") {
        throw controllerError(
          "client.action-resource-unresolved",
          `Action resource ${bindingId} has no version precondition.`,
        );
      }
      resourcePreconditions[bindingId] = result.snapshot.resourceVersionId;
    }
    const idempotencyKey = idempotencyKeySchema.parse(
      options.idempotencyKey ?? this.#identities.idempotencyKey(),
    );
    const command = await this.#send({
      type: "action-trigger-request",
      request: {
        requestId,
        idempotencyKey,
        surfaceSessionId: this.surfaceSessionId,
        revisionId,
        nodeId,
        eventPort: port,
        eventPayload: payload.value,
        statePreconditions,
        resourcePreconditions,
      },
    }, requestId, options);
    return Object.freeze({ kind: "host-command", command });
  }

  #assertNodeCommandScope(
    nodeId: NodeId,
    revisionId: NodeProjection["revisionId"],
    contract: NodeProjection["node"]["contract"],
  ) {
    const lastGood = this.#requireLastGood();
    if (lastGood.revision.envelope.revisionId !== revisionId) {
      throw controllerError("client.node-bridge-stale", "Node command bridge belongs to an older revision.");
    }
    const node = lastGood.revision.content.nodes[nodeId];
    if (!node || canonicalStringify(node.contract) !== canonicalStringify(contract)) {
      throw controllerError("client.node-bridge-stale", "Node identity or Contract changed after binding.");
    }
    const overlay = latestRenderableOverlay(this.#replay);
    if (overlay?.renderableNodeIds.includes(nodeId)) {
      throw controllerError(
        "client.node-preview-read-only",
        "Node is currently projected from a read-only preview; its committed command bridge is disabled.",
      );
    }
    const scope = collectNodeCommandScope(node, lastGood.revision.content);
    return { lastGood, node, scope };
  }

  #effectiveStateMap(
    document: NonNullable<SurfaceReplayState["lastGood"]>["revision"]["content"],
  ): Readonly<SurfaceStateMap> {
    const state = { ...(this.#replay.lastGood?.state ?? {}), ...this.#localState } as SurfaceStateMap;
    for (const [stateIdText, snapshot] of Object.entries(state)) {
      const stateId = stateIdText as StateId;
      const definition = document.stateDefinitions[stateId];
      if (!definition || definition.schemaHash !== snapshot.schemaHash || definition.scope !== snapshot.scope) {
        delete state[stateId];
      }
    }
    return immutableClone(state);
  }

  #resolvedResourceValues(
    resources: NonNullable<SurfaceReplayState["lastGood"]>["resources"],
  ): Readonly<Record<ResourceBindingId, JsonValue>> {
    const values = {} as Record<ResourceBindingId, JsonValue>;
    for (const [bindingIdText, result] of Object.entries(resources)) {
      const value = resourceResultValue(result);
      if (value !== undefined) values[bindingIdText as ResourceBindingId] = value;
    }
    return immutableClone(values);
  }

  async #resumeNow(options: HostCommandDispatchOptions): Promise<HostCommandEnvelope> {
    const { cursor, streamPolicy } = this.#replay;
    if (!cursor || !streamPolicy) {
      throw controllerError("client.resume-unavailable", "A trusted cursor and stream policy are required to resume.");
    }
    if (Date.parse(streamPolicy.cursorExpiresAt) <= this.#clock().getTime()) {
      const diagnostic = createDiagnostic({
        phase: "transport",
        code: "client.resume-cursor-expired",
        severity: "error",
        recoverable: true,
        modelCorrectable: false,
        message: "Surface resume cursor has expired; a trusted full snapshot is required.",
      });
      this.#forceSnapshot(diagnostic);
      this.#publish();
      throw controllerError("client.resume-cursor-expired", diagnostic.message);
    }
    const requestId = this.#requestId(options.requestId);
    return this.#send({
      type: "resume-request",
      request: {
        requestId,
        cursor,
        acknowledgedThrough: this.#acknowledgedThrough,
      },
    }, requestId, options);
  }

  #shouldAcknowledge(): boolean {
    const policy = this.#replay.streamPolicy;
    return policy !== undefined
      && this.#replay.acceptedThroughSequence - this.#acknowledgedThrough >= policy.ackEveryEvents;
  }

  async #acknowledgeNow(
    options: HostCommandDispatchOptions = {},
  ): Promise<HostCommandEnvelope | undefined> {
    const sequence = this.#replay.acceptedThroughSequence;
    if (sequence <= this.#acknowledgedThrough) return undefined;
    const cursor = this.#replay.cursor;
    const eventId = eventIdAtSequence(this.#replay, sequence);
    if (!cursor || !eventId) {
      throw controllerError("client.ack-unavailable", "Accepted Surface event has no trusted cursor or event identity.");
    }
    const commandId = this.#requestId(options.requestId);
    const command = await this.#send({
      type: "ack",
      ack: { acknowledgedThrough: sequence, eventId, cursor },
    }, commandId, options);
    this.#acknowledgedThrough = sequence;
    this.#publish();
    return command;
  }

  async #send(
    payload: HostCommandPayload,
    commandId: RequestId,
    options: HostCommandDispatchOptions,
  ): Promise<HostCommandEnvelope> {
    const streamId = this.#replay.streamId;
    const epoch = this.#replay.epoch;
    if (streamId === undefined || epoch === undefined) {
      throw controllerError("client.stream-unavailable", "A trusted Surface stream is required before sending commands.");
    }
    const command = await createHostCommandEnvelope({
      surfaceSessionId: this.surfaceSessionId,
      streamId,
      epoch,
      commandId,
      correlationId: correlationIdSchema.parse(options.correlationId ?? this.#identities.correlationId()),
      ...(options.causationId === undefined ? {} : { causationId: options.causationId }),
      payload,
      hashProvider: this.#hashProvider,
    });
    await this.#transport.send(command);
    return command;
  }

  #requestId(input?: RequestId): RequestId {
    return requestIdSchema.parse(input ?? this.#identities.requestId());
  }

  #requireLastGood(): NonNullable<SurfaceReplayState["lastGood"]> {
    if (!this.#replay.lastGood || this.#replay.requiresSnapshot) {
      throw controllerError("client.snapshot-required", "A trusted full snapshot is required before interaction.");
    }
    return this.#replay.lastGood;
  }

  #deriveSnapshot(): SurfaceControllerSnapshot {
    const lastGood = this.#replay.lastGood;
    const overlay = this.#replay.requiresSnapshot ? undefined : latestRenderableOverlay(this.#replay);
    const rootNodeId = renderableRootNodeId(this.#replay);
    const status: SurfaceControllerStatus = this.#replay.requiresSnapshot
      ? "resync-required"
      : lastGood === undefined ? "awaiting-snapshot" : "ready";
    return immutableClone({
      version: this.#version,
      status,
      surfaceSessionId: this.surfaceSessionId,
      ...(this.#replay.streamId === undefined ? {} : { streamId: this.#replay.streamId }),
      ...(this.#replay.epoch === undefined ? {} : { epoch: this.#replay.epoch }),
      acceptedThroughSequence: this.#replay.acceptedThroughSequence,
      acknowledgedThroughSequence: this.#acknowledgedThrough,
      ...(this.#replay.cursor === undefined ? {} : { cursor: this.#replay.cursor }),
      ...(lastGood === undefined ? {} : {
        documentId: lastGood.revision.envelope.documentId,
        committedRevisionId: lastGood.revision.envelope.revisionId,
        contractSetHash: this.#replay.contractSetHash,
        rootNodeId,
      }),
      ...(overlay === undefined ? {} : {
        preview: {
          transactionId: overlay.transactionId,
          baseRevisionId: overlay.baseRevisionId,
          overlaySequence: overlay.overlaySequence,
          overlayHash: overlay.overlayHash,
          renderableNodeIds: overlay.renderableNodeIds,
        },
      }),
      actions: lastGood?.actions ?? {},
      approvals: lastGood?.approvals ?? [],
      effectReceipts: this.#replay.effectReceipts,
      diagnostics: this.#replay.diagnostics,
    });
  }

  #publish(): void {
    this.#version += 1;
    this.#snapshot = this.#deriveSnapshot();
    for (const listener of [...this.#listeners]) listener(this.#snapshot);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertActive();
    const next = this.#tail.then(operation);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  #assertActive(): void {
    if (this.#disposed) throw controllerError("client.controller-disposed", "SurfaceController is disposed.");
  }
}

function collectNodeCommandScope(
  node: NodeProjection["node"],
  document: NonNullable<SurfaceReplayState["lastGood"]>["revision"]["content"],
) {
  const stateIds = new Set<StateId>(collectValueExprDependencies(node.props).stateIds);
  const resourceBindingIds = new Set<ResourceBindingId>(
    collectValueExprDependencies(node.props).resourceBindingIds,
  );
  for (const actionId of Object.values(node.events)) {
    const action = document.actions[actionId];
    if (!action) continue;
    if (action.kind === "host-intent") {
      const dependencies = collectValueExprDependencies(action.input);
      dependencies.stateIds.forEach((stateId) => stateIds.add(stateId));
      dependencies.resourceBindingIds.forEach((bindingId) => resourceBindingIds.add(bindingId));
      continue;
    }
    for (const transition of action.transitions) {
      if (transition.type === "state.set") {
        stateIds.add(transition.stateId);
        const dependencies = collectValueExprDependencies(transition.value);
        dependencies.stateIds.forEach((stateId) => stateIds.add(stateId));
        dependencies.resourceBindingIds.forEach((bindingId) => resourceBindingIds.add(bindingId));
      } else if (transition.type === "state.reset") {
        stateIds.add(transition.stateId);
      }
    }
  }
  return Object.freeze({
    stateIds: Object.freeze([...stateIds].sort()),
    resourceBindingIds: Object.freeze([...resourceBindingIds].sort()),
  });
}

function resourceResultValue(result: ResourceResolutionResult | undefined): JsonValue | undefined {
  if (result?.status !== "resolved") return undefined;
  return result.snapshot.payload.kind === "json"
    ? result.snapshot.payload.value
    : jsonValueSchema.parse(result.snapshot.payload.asset);
}

function eventIdAtSequence(state: Readonly<SurfaceReplayState>, sequence: number): EventId | undefined {
  for (const [eventId, rememberedSequence] of Object.entries(state.eventSequences)) {
    if (rememberedSequence === sequence) return eventId as EventId;
  }
  return undefined;
}

function freezeProjection(projection: NodeProjection): NodeProjection {
  return Object.freeze({
    ...projection,
    node: immutableClone(projection.node),
    contract: projection.contract === undefined ? undefined : immutableClone(projection.contract),
    resolvedProps: projection.resolvedProps === undefined ? undefined : immutableClone(projection.resolvedProps),
    stateBindings: immutableClone(projection.stateBindings),
    resourceBindings: immutableClone(projection.resourceBindings),
    diagnostics: immutableClone(projection.diagnostics),
  });
}

function validationDiagnostic(
  issue: ClientValidationIssue,
  nodeId: NodeId,
  revisionId: NodeProjection["revisionId"],
): Diagnostic {
  const code = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/.test(issue.code)
    ? issue.code
    : "client.schema-invalid";
  return renderDiagnostic(code, issue.message, nodeId, revisionId);
}

function renderDiagnostic(
  code: string,
  message: string,
  nodeId: NodeId,
  revisionId: NodeProjection["revisionId"],
): Diagnostic {
  return createDiagnostic({
    phase: "render",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
    location: { revisionId, entity: { kind: "node", id: nodeId } },
  });
}

function transportDiagnostic(
  code: string,
  message: string,
  event: SurfaceEventEnvelope,
): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code,
    severity: "error",
    recoverable: true,
    modelCorrectable: false,
    message,
    location: { streamId: event.streamId, sequence: event.sequence },
  });
}

function controllerError(code: string, message: string): SurfaceControllerError {
  return new SurfaceControllerError(code, message);
}

function createExactStateValidationPort(): SurfaceStateValidationPort {
  const validators = new Map<string, z.ZodType>();
  return {
    validateSurfaceStateValue: ({ stateId, definition, value }) => {
      const key = canonicalStringify(definition.schema);
      let validator = validators.get(key);
      if (!validator) {
        validator = z.fromJSONSchema(definition.schema as never);
        validators.set(key, validator);
      }
      const parsed = validator.safeParse(value);
      if (!parsed.success) {
        return [{ code: "client.state-schema-invalid", message: parsed.error.message, stateId }];
      }
      if (canonicalStringify(parsed.data) !== canonicalStringify(value)) {
        return [{
          code: "client.state-schema-transformation-forbidden",
          message: "State validators must not coerce, default, or transform canonical values.",
          stateId,
        }];
      }
      return [];
    },
  };
}
