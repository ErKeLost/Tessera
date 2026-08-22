import { DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { createDiagnostic } from "./diagnostics";
import { JsonSchemaContractError, parseJsonWithSchema, prepareStateSchema } from "./json-schema";
import {
  jsonValueSchema,
  type ActionPlan,
  type ArtifactDocument,
  type ClientStateTransitionReceipt,
  type Diagnostic,
  type JsonValue,
  type RuntimeSnapshot,
  type StateRecord,
} from "./schemas";
import { resolveArtifactValue, type ValueResolutionContext } from "./values";

export type LocalActionEvent = {
  port: string;
  payload: JsonValue;
};

export type LocalActionExecutionOptions = {
  requestId?: string;
  now?: () => string;
  idFactory?: (kind: "state-revision" | "receipt" | "operation", stepId: string, stateId?: string) => string;
};

export type LocalActionExecutionResult =
  | { ok: true; snapshot: RuntimeSnapshot; focusNodeIds: string[] }
  | { ok: false; diagnostic: Diagnostic };

export function createImplicitRuntimeSnapshot(document: ArtifactDocument): RuntimeSnapshot {
  return {
    document,
    branchHead: {
      branchId: document.revision.branchId,
      revisionId: document.revision.revisionId,
      headToken: `local:${document.revision.revisionId}`,
    },
    state: [],
    pendingActions: [],
    pendingEffects: [],
    activeApprovals: [],
    stateMigrationReceipts: [],
    stateTransitionReceipts: [],
  };
}

export function canExecuteActionLocally(document: ArtifactDocument, plan: ActionPlan): boolean {
  for (const step of plan.steps) {
    if (step.type === "node.focus") continue;
    if (step.type === "state.set") {
      const definition = document.state[step.stateId];
      if (!definition || definition.policy.persistence === "host") return false;
      continue;
    }
    if (step.type === "state.reset") {
      if (step.stateIds.some((stateId) => {
        const definition = document.state[stateId];
        return !definition || definition.policy.persistence === "host";
      })) return false;
      continue;
    }
    return false;
  }
  return true;
}

export function resolveRuntimeStateValues(
  document: ArtifactDocument,
  snapshot?: RuntimeSnapshot,
): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const [stateId, definition] of Object.entries(document.state)) values[stateId] = definition.initial;
  for (const record of snapshot?.state ?? []) {
    const definition = document.state[record.stateId];
    if (
      definition
      && record.documentId === document.documentId
      && record.branchId === document.revision.branchId
      && record.schemaId === definition.schemaId
      && record.schemaVersion === definition.schemaVersion
      && record.schemaHash === definition.schemaHash
      && record.policyHash === definition.policy.policyHash
    ) values[record.stateId] = record.value;
  }
  return values;
}

export async function executeLocalArtifactAction(input: {
  snapshot: RuntimeSnapshot;
  nodeId: string;
  port: string;
  payload: JsonValue;
  resources?: Readonly<Record<string, JsonValue>>;
  context?: ValueResolutionContext["context"];
  options?: LocalActionExecutionOptions;
}): Promise<LocalActionExecutionResult> {
  const { snapshot } = input;
  const { document } = snapshot;
  if (
    snapshot.branchHead.branchId !== document.revision.branchId
    || snapshot.branchHead.revisionId !== document.revision.revisionId
  ) return localFailure("runtime.snapshot-invalid", "The local runtime snapshot does not match its document revision.", input.nodeId);

  const node = document.nodes[input.nodeId];
  const actionId = node?.events?.[input.port];
  const plan = actionId ? document.actions[actionId] : undefined;
  if (!node || !actionId || !plan) {
    return localFailure("runtime.action-unavailable", "The node event is not bound to an action plan.", input.nodeId);
  }
  if (!canExecuteActionLocally(document, plan)) {
    return localFailure("runtime.action-not-local", "This action requires an authorized runtime transport.", input.nodeId);
  }
  const payload = jsonValueSchema.safeParse(input.payload);
  if (!payload.success) {
    return localFailure("runtime.event-payload-invalid", "The event payload is not valid JSON data.", input.nodeId);
  }

  const records = new Map(snapshot.state.map((record) => [record.stateId, record]));
  const state = resolveRuntimeStateValues(document, snapshot);
  const receipts: ClientStateTransitionReceipt[] = [];
  const focusNodeIds: string[] = [];
  const now = input.options?.now ?? (() => new Date().toISOString());
  const idFactory = input.options?.idFactory ?? defaultLocalId;
  const requestId = input.options?.requestId ?? idFactory("operation", "invocation");

  for (const step of plan.steps) {
    if (step.type === "node.focus") {
      if (!focusNodeIds.includes(step.nodeId)) focusNodeIds.push(step.nodeId);
      continue;
    }
    if (step.type !== "state.set" && step.type !== "state.reset") {
      return localFailure("runtime.action-not-local", "This action requires an authorized runtime transport.", input.nodeId);
    }
    const stateIds = step.type === "state.set" ? [step.stateId] : step.stateIds;
    for (const stateId of stateIds) {
      const definition = document.state[stateId];
      if (!definition) return localFailure("runtime.state-missing", `State ${stateId} is not defined.`, input.nodeId);
      let candidate: JsonValue;
      if (step.type === "state.set") {
        const resolved = resolveArtifactValue(step.value, {
          state,
          resources: input.resources,
          event: { port: input.port, payload: payload.data },
          context: input.context,
        });
        if (!resolved.ok) return { ok: false, diagnostic: resolved.diagnostic };
        candidate = resolved.value;
      } else {
        candidate = definition.initial;
      }

      let value: JsonValue;
      try {
        const prepared = await prepareStateSchema(definition);
        value = parseJsonWithSchema(prepared.validator, candidate);
      } catch (error) {
        const detail = error instanceof JsonSchemaContractError ? error.message : "State schema validation failed.";
        return localFailure("runtime.state-write-invalid", detail, input.nodeId, stateId);
      }

      const previous = records.get(stateId);
      const stateRevision = idFactory("state-revision", step.stepId, stateId);
      const transition = step.type === "state.set" ? "write" as const : "reset" as const;
      const record: StateRecord = {
        documentId: document.documentId,
        branchId: document.revision.branchId,
        stateId,
        stateRevision,
        schemaId: definition.schemaId,
        schemaVersion: definition.schemaVersion,
        schemaHash: definition.schemaHash,
        policyHash: definition.policy.policyHash,
        value,
      };
      const receipt: ClientStateTransitionReceipt = {
        receiptId: idFactory("receipt", step.stepId, stateId),
        operationKey: idFactory("operation", step.stepId, stateId),
        invocationId: requestId,
        stepId: step.stepId,
        documentId: document.documentId,
        branchId: document.revision.branchId,
        stateId,
        transition,
        fromStateRevision: previous?.stateRevision ?? "initial",
        toStateRevision: stateRevision,
        schemaHash: definition.schemaHash,
        policyHash: definition.policy.policyHash,
        recordedAt: now(),
      };
      records.set(stateId, record);
      state[stateId] = value;
      receipts.push(receipt);
    }
  }

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      state: [...records.values()],
      stateTransitionReceipts: [
        ...snapshot.stateTransitionReceipts,
        ...receipts,
      ].slice(-DEFAULT_PROTOCOL_LIMITS.maxSnapshotReceipts),
    },
    focusNodeIds,
  };
}

let localIdSequence = 0;

function defaultLocalId(
  kind: "state-revision" | "receipt" | "operation",
  stepId: string,
  stateId?: string,
): string {
  localIdSequence += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}:${localIdSequence.toString(36)}`;
  return `local:${kind}:${stepId.slice(0, 80)}${stateId ? `:${stateId.slice(0, 80)}` : ""}:${random}`;
}

function localFailure(
  code: string,
  message: string,
  nodeId: string,
  stateId?: string,
): { ok: false; diagnostic: Diagnostic } {
  return {
    ok: false,
    diagnostic: createDiagnostic({
      phase: "effect",
      code,
      severity: "error",
      recoverable: true,
      modelCorrectable: false,
      message,
      location: { entity: { kind: stateId ? "state" : "node", id: stateId ?? nodeId } },
    }),
  };
}
