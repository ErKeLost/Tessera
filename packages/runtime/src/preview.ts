import {
  HASH_DOMAINS,
  hashCanonical,
  validatedPreviewSchema,
  type ActionDefinition,
  type ActionId,
  type CanonicalEntityOperation,
  type DocumentContent,
  type HashProvider,
  type NodeId,
  type ResourceBindingId,
  type Sha256Hash,
  type SurfaceSessionId,
  type TransactionId,
  type TransactionIdentityMapDelta,
  type ValidatedPreview,
  type ValueExpr,
} from "@open-generative/protocol";
import type { RuntimeValidationIssue, RuntimeValidationPort } from "./validation";

export type PreviewProjectionInput = {
  surfaceSessionId: SurfaceSessionId;
  transactionId: TransactionId;
  baseRevisionId: ValidatedPreview["baseRevisionId"];
  overlaySequence: number;
  previousOverlayHash?: Sha256Hash;
  identityMapDelta: TransactionIdentityMapDelta;
  operations: CanonicalEntityOperation[];
  projectionOperations?: readonly CanonicalEntityOperation[];
  document: DocumentContent;
};

export type PreviewProjectionResult =
  | { ok: true; preview: ValidatedPreview }
  | { ok: false; issues: RuntimeValidationIssue[] };

export async function projectValidatedPreview(
  input: PreviewProjectionInput,
  validation: RuntimeValidationPort,
  provider?: HashProvider,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PreviewProjectionResult> {
  options.signal?.throwIfAborted();
  const affectedNodeIds = collectAffectedNodeIds(
    input.projectionOperations ?? input.operations,
    input.document,
  );
  const closureMemo = new Map<NodeId, boolean>();
  const renderableNodeIds: NodeId[] = [];
  const disabledActionIds = new Set<ActionId>();

  for (const nodeId of [...affectedNodeIds].sort()) {
    const node = input.document.nodes[nodeId];
    if (!node || !isNodeDependencyClosed(nodeId, input.document, closureMemo, new Set())) continue;

    const issues = await validation.validateNode({
      nodeId,
      node,
      document: input.document,
      phase: "preview",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.signal?.throwIfAborted();
    if (issues.length > 0) return { ok: false, issues: [...issues] };

    const policy = await validation.commitPolicy(
      node.contract,
      options.signal ? { signal: options.signal } : undefined,
    );
    options.signal?.throwIfAborted();
    if (policy === "atomic" && !await validation.isNodeReady({
      nodeId,
      node,
      document: input.document,
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      continue;
    }
    options.signal?.throwIfAborted();
    renderableNodeIds.push(nodeId);
    for (const actionId of Object.values(node.events)) disabledActionIds.add(actionId);
  }

  const disabled = [...disabledActionIds].sort();
  const overlayHash = await computeValidatedPreviewHash({
    surfaceSessionId: input.surfaceSessionId,
    transactionId: input.transactionId,
    baseRevisionId: input.baseRevisionId,
    overlaySequence: input.overlaySequence,
    previousOverlayHash: input.previousOverlayHash,
    identityMapDelta: input.identityMapDelta,
    operations: input.operations,
    renderableNodeIds,
    disabledActionIds: disabled,
  }, provider);

  return {
    ok: true,
    preview: validatedPreviewSchema.parse({
      surfaceSessionId: input.surfaceSessionId,
      transactionId: input.transactionId,
      baseRevisionId: input.baseRevisionId,
      overlaySequence: input.overlaySequence,
      ...(input.previousOverlayHash === undefined
        ? {}
        : { previousOverlayHash: input.previousOverlayHash }),
      overlayHash,
      identityMapDelta: input.identityMapDelta,
      operations: input.operations,
      renderableNodeIds,
      disabledActionIds: disabled,
    }),
  };
}

export async function computeValidatedPreviewHash(
  preview: Omit<ValidatedPreview, "overlayHash">,
  provider?: HashProvider,
): Promise<Sha256Hash> {
  return hashCanonical(HASH_DOMAINS.operationPayload, {
    surfaceSessionId: preview.surfaceSessionId,
    transactionId: preview.transactionId,
    baseRevisionId: preview.baseRevisionId,
    overlaySequence: preview.overlaySequence,
    previousOverlayHash: preview.previousOverlayHash ?? null,
    identityMapDelta: preview.identityMapDelta,
    operations: preview.operations,
    renderableNodeIds: preview.renderableNodeIds,
    disabledActionIds: preview.disabledActionIds,
  }, provider);
}

export async function verifyValidatedPreviewHash(
  previewInput: ValidatedPreview,
  provider?: HashProvider,
): Promise<boolean> {
  const preview = validatedPreviewSchema.parse(previewInput);
  return preview.overlayHash === await computeValidatedPreviewHash(preview, provider);
}

function collectAffectedNodeIds(
  operations: readonly CanonicalEntityOperation[],
  document: DocumentContent,
): Set<NodeId> {
  const affected = new Set<NodeId>();
  const changedStates = new Set<string>();
  const changedResources = new Set<string>();
  const changedActions = new Set<string>();
  const changedEvidence = new Set<string>();

  for (const operation of operations) {
    switch (operation.op) {
      case "put-node":
      case "remove-node":
        affected.add(operation.nodeId);
        break;
      case "put-state":
      case "remove-state":
        changedStates.add(operation.stateId);
        break;
      case "put-action":
      case "remove-action":
        changedActions.add(operation.actionId);
        break;
      case "put-resource-binding":
      case "remove-resource-binding":
        changedResources.add(operation.bindingId);
        break;
      case "put-evidence":
      case "remove-evidence":
        changedEvidence.add(operation.evidenceId);
        break;
      case "put-claim":
        affected.add(operation.value.nodeId);
        break;
      case "remove-claim":
      case "set-meta":
        break;
      case "set-root":
        affected.add(operation.nodeId);
        break;
    }
  }

  for (const [nodeIdText, node] of Object.entries(document.nodes)) {
    const nodeId = nodeIdText as NodeId;
    if (Object.values(node.events).some((actionId) => changedActions.has(actionId))) affected.add(nodeId);
    if (node.evidence.some((evidenceId) => changedEvidence.has(evidenceId))) affected.add(nodeId);
    if (Object.values(node.props).some((expression) => expressionTouches(
      expression,
      changedStates,
      changedResources,
    ))) affected.add(nodeId);
  }
  return affected;
}

function expressionTouches(
  expression: ValueExpr,
  states: ReadonlySet<string>,
  resources: ReadonlySet<string>,
): boolean {
  if (expression.kind === "state-ref" || expression.kind === "state-id-ref") return states.has(expression.stateId);
  if (expression.kind === "resource-ref" || expression.kind === "resource-id-ref") return resources.has(expression.bindingId);
  if (expression.kind === "array") return expression.items.some((item) => expressionTouches(item, states, resources));
  if (expression.kind === "object") return Object.values(expression.entries).some((item) => expressionTouches(item, states, resources));
  if (expression.kind === "condition") return expression.args.some((item) => expressionTouches(item, states, resources));
  return false;
}

function isNodeDependencyClosed(
  nodeId: NodeId,
  document: DocumentContent,
  memo: Map<NodeId, boolean>,
  active: Set<NodeId>,
): boolean {
  const cached = memo.get(nodeId);
  if (cached !== undefined) return cached;
  if (active.has(nodeId)) return false;
  const node = document.nodes[nodeId];
  if (!node) return false;

  active.add(nodeId);
  let closed = true;
  for (const children of Object.values(node.slots)) {
    for (const childId of children) {
      if (!isNodeDependencyClosed(childId, document, memo, active)) closed = false;
    }
  }
  for (const actionId of Object.values(node.events)) {
    const action = document.actions[actionId];
    if (!action || !actionDependenciesExist(action, document)) closed = false;
  }
  for (const evidenceId of node.evidence) {
    const evidence = document.evidenceBindings[evidenceId];
    if (!evidence) {
      closed = false;
    } else if (
      evidence.source.kind === "resource-snapshot"
      && !resourceDependencyExists(evidence.source.bindingId, document)
    ) {
      closed = false;
    }
  }
  for (const expression of Object.values(node.props)) {
    if (!valueDependenciesExist(expression, document)) closed = false;
  }
  active.delete(nodeId);
  memo.set(nodeId, closed);
  return closed;
}

function actionDependenciesExist(action: ActionDefinition, document: DocumentContent): boolean {
  if (action.kind === "host-intent") {
    return Object.values(action.input).every((expression) => valueDependenciesExist(expression, document));
  }
  return action.transitions.every((transition) => {
    if (transition.type === "node.focus") return document.nodes[transition.nodeId] !== undefined;
    if (document.stateDefinitions[transition.stateId] === undefined) return false;
    return transition.type !== "state.set" || valueDependenciesExist(transition.value, document);
  });
}

function valueDependenciesExist(expression: ValueExpr, document: DocumentContent): boolean {
  if (expression.kind === "state-ref" || expression.kind === "state-id-ref") {
    return document.stateDefinitions[expression.stateId] !== undefined;
  }
  if (expression.kind === "resource-ref" || expression.kind === "resource-id-ref") {
    return resourceDependencyExists(expression.bindingId, document);
  }
  if (expression.kind === "array") return expression.items.every((item) => valueDependenciesExist(item, document));
  if (expression.kind === "object") return Object.values(expression.entries).every((item) => valueDependenciesExist(item, document));
  if (expression.kind === "condition") return expression.args.every((item) => valueDependenciesExist(item, document));
  return true;
}

function resourceDependencyExists(bindingId: ResourceBindingId, document: DocumentContent): boolean {
  const binding = document.resourceBindings[bindingId];
  if (!binding) return false;
  return binding.selector.filterStateRef === undefined
    || document.stateDefinitions[binding.selector.filterStateRef] !== undefined;
}
