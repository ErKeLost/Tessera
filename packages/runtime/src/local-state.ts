import {
  HASH_DOMAINS,
  hashCanonical,
  jsonValueSchema,
  stateRevisionIdSchema,
  stateValueSnapshotSchema,
  type ActionId,
  type DocumentContent,
  type EventPort,
  type HashProvider,
  type JsonValue,
  type NodeId,
  type RequestId,
  type ResourceBindingId,
  type StateDefinition,
  type StateId,
  type StateRevisionId,
  type StateValueSnapshot,
  type SurfaceSessionId,
} from "@open-generative/protocol";
import type { MaybePromise } from "./utils";
import { cloneCanonical, immutableClone } from "./utils";
import { materializeValueExpr, type ValueMaterializationContext } from "./values";

export type SurfaceStateMap = Record<StateId, StateValueSnapshot>;

export type SurfaceStateValidationIssue = {
  code: string;
  message: string;
  stateId?: StateId;
};

export interface SurfaceStateValidationPort {
  validateSurfaceStateValue(input: {
    stateId: StateId;
    definition: Extract<StateDefinition, { scope: "surface" }>;
    value: JsonValue;
  }): MaybePromise<readonly SurfaceStateValidationIssue[]>;
}

export type ReduceSurfaceLocalActionInput = {
  surfaceSessionId: SurfaceSessionId;
  requestId: RequestId;
  actionId: ActionId;
  document: DocumentContent;
  state: Readonly<SurfaceStateMap>;
  resources?: Readonly<Record<ResourceBindingId, JsonValue>>;
  event: { port: EventPort; payload: JsonValue };
  context?: ValueMaterializationContext["context"];
};

export type SurfaceStateChange = {
  transitionIndex: number;
  transition: "set" | "reset";
  stateId: StateId;
  fromStateRevisionId?: StateRevisionId;
  state: StateValueSnapshot;
};

export type ReduceSurfaceLocalActionResult =
  | {
      ok: true;
      state: Readonly<SurfaceStateMap>;
      changes: readonly SurfaceStateChange[];
      focusNodeIds: readonly NodeId[];
    }
  | { ok: false; issues: readonly SurfaceStateValidationIssue[] };

export async function reduceSurfaceLocalAction(
  input: ReduceSurfaceLocalActionInput,
  validation: SurfaceStateValidationPort,
  provider?: HashProvider,
): Promise<ReduceSurfaceLocalActionResult> {
  const eventPayload = jsonValueSchema.safeParse(input.event.payload);
  if (!eventPayload.success) {
    return failed("local-state.event-invalid", "Local action event payload is not strict JSON data.");
  }
  const normalized = normalizeState(input.state, input.document);
  if (!normalized.ok) return normalized;

  const action = input.document.actions[input.actionId];
  if (!action) return failed("local-state.action-missing", `Action ${input.actionId} does not exist.`);
  if (action.kind !== "local-transition") {
    return failed("local-state.host-intent-forbidden", "Host intents cannot execute in the surface-local reducer.");
  }

  const scratch = cloneCanonical(normalized.state);
  const changes: SurfaceStateChange[] = [];
  const focusNodeIds: NodeId[] = [];

  for (const [transitionIndex, transition] of action.transitions.entries()) {
    if (transition.type === "node.focus") {
      if (!input.document.nodes[transition.nodeId]) {
        return failed("local-state.focus-node-missing", `Focus node ${transition.nodeId} does not exist.`);
      }
      if (!focusNodeIds.includes(transition.nodeId)) focusNodeIds.push(transition.nodeId);
      continue;
    }

    const definition = input.document.stateDefinitions[transition.stateId];
    if (!definition) {
      return failed("local-state.definition-missing", `State ${transition.stateId} is not defined.`, transition.stateId);
    }
    if (definition.scope !== "surface") {
      return failed(
        "local-state.scope-forbidden",
        `State ${transition.stateId} is document-scoped and requires an authorized state write.`,
        transition.stateId,
      );
    }

    let value: JsonValue;
    if (transition.type === "state.reset") {
      value = cloneCanonical(definition.initial);
    } else {
      const materialized = materializeValueExpr(transition.value, {
        state: currentStateValues(input.document, scratch),
        resources: input.resources,
        event: { port: input.event.port, payload: eventPayload.data },
        context: input.context,
      });
      if (!materialized.ok) {
        return failed(
          materialized.diagnostic.code,
          materialized.diagnostic.message,
          transition.stateId,
        );
      }
      value = materialized.value;
    }

    const issues = await validation.validateSurfaceStateValue({
      stateId: transition.stateId,
      definition,
      value,
    });
    if (issues.length > 0) {
      return {
        ok: false,
        issues: issues.map((issue) => ({ ...issue, stateId: issue.stateId ?? transition.stateId })),
      };
    }

    const previous = scratch[transition.stateId];
    const stateRevisionId = await createSurfaceStateRevisionId({
      surfaceSessionId: input.surfaceSessionId,
      requestId: input.requestId,
      actionId: input.actionId,
      transitionIndex,
      transition: transition.type,
      stateId: transition.stateId,
      fromStateRevisionId: previous?.stateRevisionId,
      schemaHash: definition.schemaHash,
      value,
    }, provider);
    const state = stateValueSnapshotSchema.parse({
      stateId: transition.stateId,
      stateRevisionId,
      schemaHash: definition.schemaHash,
      scope: "surface",
      value,
    });
    scratch[transition.stateId] = state;
    changes.push({
      transitionIndex,
      transition: transition.type === "state.set" ? "set" : "reset",
      stateId: transition.stateId,
      state,
      ...(previous ? { fromStateRevisionId: previous.stateRevisionId } : {}),
    });
  }

  return {
    ok: true,
    state: immutableClone(scratch),
    changes: immutableClone(changes),
    focusNodeIds: immutableClone(focusNodeIds),
  };
}

function normalizeState(
  input: Readonly<SurfaceStateMap>,
  document: DocumentContent,
): { ok: true; state: SurfaceStateMap } | { ok: false; issues: readonly SurfaceStateValidationIssue[] } {
  const state: SurfaceStateMap = {} as SurfaceStateMap;
  for (const [stateIdText, value] of Object.entries(input)) {
    const parsed = stateValueSnapshotSchema.safeParse(value);
    const stateId = stateIdText as StateId;
    if (!parsed.success || parsed.data.stateId !== stateId) {
      return failed("local-state.snapshot-invalid", `State snapshot ${stateId} has invalid or mismatched identity.`);
    }
    const definition = document.stateDefinitions[stateId];
    if (
      !definition
      || parsed.data.schemaHash !== definition.schemaHash
      || parsed.data.scope !== definition.scope
    ) {
      return failed("local-state.snapshot-stale", `State snapshot ${stateId} does not match the active definition.`, stateId);
    }
    state[stateId] = parsed.data;
  }
  return { ok: true, state };
}

function currentStateValues(
  document: DocumentContent,
  snapshots: Readonly<SurfaceStateMap>,
): Record<StateId, JsonValue> {
  const values = {} as Record<StateId, JsonValue>;
  for (const [stateIdText, definition] of Object.entries(document.stateDefinitions)) {
    const stateId = stateIdText as StateId;
    values[stateId] = cloneCanonical(snapshots[stateId]?.value ?? definition.initial);
  }
  return values;
}

async function createSurfaceStateRevisionId(
  input: {
    surfaceSessionId: SurfaceSessionId;
    requestId: RequestId;
    actionId: ActionId;
    transitionIndex: number;
    transition: "state.set" | "state.reset";
    stateId: StateId;
    fromStateRevisionId?: StateRevisionId;
    schemaHash: StateDefinition["schemaHash"];
    value: JsonValue;
  },
  provider?: HashProvider,
): Promise<StateRevisionId> {
  const hash = await hashCanonical(HASH_DOMAINS.operationPayload, {
    kind: "surface-local-state-revision",
    surfaceSessionId: input.surfaceSessionId,
    requestId: input.requestId,
    actionId: input.actionId,
    transitionIndex: input.transitionIndex,
    transition: input.transition,
    stateId: input.stateId,
    fromStateRevisionId: input.fromStateRevisionId ?? null,
    schemaHash: input.schemaHash,
    value: input.value,
  }, provider);
  return stateRevisionIdSchema.parse(hash);
}

function failed(
  code: string,
  message: string,
  stateId?: StateId,
): { ok: false; issues: readonly SurfaceStateValidationIssue[] } {
  return { ok: false, issues: [{ code, message, stateId }] };
}
