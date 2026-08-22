import {
  HASH_DOMAINS,
  canonicalStringify,
  entityRevisionIdSchema,
  hashCanonical,
  type CanonicalEntityOperation,
  type DocumentContent,
  type EntityRevisionId,
  type HashProvider,
  type Sha256Hash,
} from "@open-generative/protocol";
import { cloneCanonical, exhaustive } from "./utils";

export type EntityRevisionIndex = {
  nodes: Record<string, EntityRevisionId>;
  states: Record<string, EntityRevisionId>;
  actions: Record<string, EntityRevisionId>;
  resources: Record<string, EntityRevisionId>;
  evidence: Record<string, EntityRevisionId>;
  claims: Record<string, EntityRevisionId>;
  metaHash: Sha256Hash;
};

export type OperationConflict = {
  code:
    | "entity.already-exists"
    | "entity.missing"
    | "entity.revision-mismatch"
    | "root.precondition-required"
    | "root.precondition-mismatch"
    | "meta.precondition-required"
    | "meta.precondition-mismatch";
  message: string;
};

export type CheckedOperationResult =
  | { ok: true; content: DocumentContent; entityRevisions: EntityRevisionIndex }
  | { ok: false; conflict: OperationConflict };

export async function computeEntityRevisionIndex(
  content: DocumentContent,
  provider?: HashProvider,
): Promise<EntityRevisionIndex> {
  const [nodes, states, actions, resources, evidence, claims, metaHash] = await Promise.all([
    hashEntityMap("node", content.nodes, provider),
    hashEntityMap("state", content.stateDefinitions, provider),
    hashEntityMap("action", content.actions, provider),
    hashEntityMap("resource", content.resourceBindings, provider),
    hashEntityMap("evidence", content.evidenceBindings, provider),
    hashEntityMap("claim", content.claims, provider),
    hashCanonical(HASH_DOMAINS.operationPayload, { kind: "meta", value: content.meta }, provider),
  ]);
  return { nodes, states, actions, resources, evidence, claims, metaHash };
}

export async function applyCanonicalOperationChecked(
  contentInput: DocumentContent,
  revisionInput: EntityRevisionIndex,
  operation: CanonicalEntityOperation,
  provider?: HashProvider,
): Promise<CheckedOperationResult> {
  const content = cloneCanonical(contentInput);
  const entityRevisions = cloneCanonical(revisionInput);

  switch (operation.op) {
    case "put-node":
      return applyPut(content, entityRevisions, "nodes", operation.nodeId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-node":
      return applyRemove(content, entityRevisions, "nodes", operation.nodeId, operation.expectedEntityRevision);
    case "put-state":
      return applyPut(content, entityRevisions, "states", operation.stateId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-state":
      return applyRemove(content, entityRevisions, "states", operation.stateId, operation.expectedEntityRevision);
    case "put-action":
      return applyPut(content, entityRevisions, "actions", operation.actionId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-action":
      return applyRemove(content, entityRevisions, "actions", operation.actionId, operation.expectedEntityRevision);
    case "put-resource-binding":
      return applyPut(content, entityRevisions, "resources", operation.bindingId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-resource-binding":
      return applyRemove(content, entityRevisions, "resources", operation.bindingId, operation.expectedEntityRevision);
    case "put-evidence":
      return applyPut(content, entityRevisions, "evidence", operation.evidenceId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-evidence":
      return applyRemove(content, entityRevisions, "evidence", operation.evidenceId, operation.expectedEntityRevision);
    case "put-claim":
      return applyPut(content, entityRevisions, "claims", operation.claimId, operation.expectedEntityRevision, operation.value, provider);
    case "remove-claim":
      return applyRemove(content, entityRevisions, "claims", operation.claimId, operation.expectedEntityRevision);
    case "set-root": {
      if (operation.expectedRootId === undefined) {
        return failure("root.precondition-required", "Replacing an existing root requires expectedRootId.");
      }
      if (content.rootNodeId !== operation.expectedRootId) {
        return failure("root.precondition-mismatch", "Root precondition does not match the current draft root.");
      }
      content.rootNodeId = operation.nodeId;
      return { ok: true, content, entityRevisions };
    }
    case "set-meta": {
      if (operation.expectedMetaHash === undefined) {
        return failure("meta.precondition-required", "Replacing document metadata requires expectedMetaHash.");
      }
      if (entityRevisions.metaHash !== operation.expectedMetaHash) {
        return failure("meta.precondition-mismatch", "Metadata precondition does not match the current draft metadata.");
      }
      content.meta = operation.value;
      entityRevisions.metaHash = await hashCanonical(
        HASH_DOMAINS.operationPayload,
        { kind: "meta", value: operation.value },
        provider,
      );
      return { ok: true, content, entityRevisions };
    }
    default:
      return exhaustive(operation);
  }
}

export function applyCanonicalOperationUnchecked(
  contentInput: DocumentContent,
  operation: CanonicalEntityOperation,
): DocumentContent {
  const content = cloneCanonical(contentInput);
  switch (operation.op) {
    case "put-node":
      content.nodes[operation.nodeId] = operation.value;
      break;
    case "remove-node":
      delete content.nodes[operation.nodeId];
      break;
    case "put-state":
      content.stateDefinitions[operation.stateId] = operation.value;
      break;
    case "remove-state":
      delete content.stateDefinitions[operation.stateId];
      break;
    case "put-action":
      content.actions[operation.actionId] = operation.value;
      break;
    case "remove-action":
      delete content.actions[operation.actionId];
      break;
    case "put-resource-binding":
      content.resourceBindings[operation.bindingId] = operation.value;
      break;
    case "remove-resource-binding":
      delete content.resourceBindings[operation.bindingId];
      break;
    case "put-evidence":
      content.evidenceBindings[operation.evidenceId] = operation.value;
      break;
    case "remove-evidence":
      delete content.evidenceBindings[operation.evidenceId];
      break;
    case "put-claim":
      content.claims[operation.claimId] = operation.value;
      break;
    case "remove-claim":
      delete content.claims[operation.claimId];
      break;
    case "set-root":
      content.rootNodeId = operation.nodeId;
      break;
    case "set-meta":
      content.meta = operation.value;
      break;
    default:
      exhaustive(operation);
  }
  return content;
}

type EntityMapName = "nodes" | "states" | "actions" | "resources" | "evidence" | "claims";

async function applyPut(
  content: DocumentContent,
  entityRevisions: EntityRevisionIndex,
  mapName: EntityMapName,
  entityId: string,
  expectedRevision: EntityRevisionId | undefined,
  value: unknown,
  provider?: HashProvider,
): Promise<CheckedOperationResult> {
  const revisionMap = entityRevisions[mapName];
  const currentRevision = revisionMap[entityId];
  if (expectedRevision === undefined && currentRevision !== undefined) {
    return failure("entity.already-exists", `${mapName}:${entityId} already exists; update requires a revision precondition.`);
  }
  if (expectedRevision !== undefined && currentRevision === undefined) {
    return failure("entity.missing", `${mapName}:${entityId} does not exist.`);
  }
  if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
    return failure("entity.revision-mismatch", `${mapName}:${entityId} revision precondition does not match.`);
  }

  const map = documentMap(content, mapName);
  map[entityId] = value;
  revisionMap[entityId] = await hashEntityRevision(mapName, entityId, value, provider);
  return { ok: true, content, entityRevisions };
}

function applyRemove(
  content: DocumentContent,
  entityRevisions: EntityRevisionIndex,
  mapName: EntityMapName,
  entityId: string,
  expectedRevision: EntityRevisionId,
): CheckedOperationResult {
  const revisionMap = entityRevisions[mapName];
  const currentRevision = revisionMap[entityId];
  if (currentRevision === undefined) return failure("entity.missing", `${mapName}:${entityId} does not exist.`);
  if (currentRevision !== expectedRevision) {
    return failure("entity.revision-mismatch", `${mapName}:${entityId} revision precondition does not match.`);
  }
  delete documentMap(content, mapName)[entityId];
  delete revisionMap[entityId];
  return { ok: true, content, entityRevisions };
}

function documentMap(content: DocumentContent, name: EntityMapName): Record<string, unknown> {
  if (name === "nodes") return content.nodes;
  if (name === "states") return content.stateDefinitions;
  if (name === "actions") return content.actions;
  if (name === "resources") return content.resourceBindings;
  if (name === "evidence") return content.evidenceBindings;
  return content.claims;
}

async function hashEntityMap(
  kind: string,
  values: Record<string, unknown>,
  provider?: HashProvider,
): Promise<Record<string, EntityRevisionId>> {
  const entries = await Promise.all(Object.entries(values).map(async ([id, value]) => (
    [id, await hashEntityRevision(kind, id, value, provider)] as const
  )));
  return Object.fromEntries(entries);
}

async function hashEntityRevision(
  kind: string,
  id: string,
  value: unknown,
  provider?: HashProvider,
): Promise<EntityRevisionId> {
  const hash = await hashCanonical(HASH_DOMAINS.operationPayload, { kind, id, value }, provider);
  return entityRevisionIdSchema.parse(hash);
}

function failure(code: OperationConflict["code"], message: string): CheckedOperationResult {
  return { ok: false, conflict: { code, message } };
}

export function sameCanonicalOperation(left: CanonicalEntityOperation, right: CanonicalEntityOperation): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
