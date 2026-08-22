import type { HashProvider } from "./canonical";
import { canonicalHash, canonicalize, webCryptoSha256Provider } from "./canonical";
import type { ArtifactDocument, CommitCommand, DraftOperation } from "./schemas";

export function snapshotToDraftOperations(
  previous: ArtifactDocument | undefined,
  next: ArtifactDocument,
): DraftOperation[] {
  const operations: DraftOperation[] = [];
  appendMapDelta(previous?.nodes ?? {}, next.nodes, "node", operations);
  appendMapDelta(previous?.state ?? {}, next.state, "state", operations);
  appendMapDelta(previous?.actions ?? {}, next.actions, "action", operations);
  appendResourceDelta(previous?.resources ?? {}, next.resources, operations);
  appendMapDelta(previous?.claims ?? {}, next.claims, "claim", operations);

  if (!previous || previous.root !== next.root) operations.push({ op: "set-root", nodeId: next.root });
  const previousMeta = previous
    ? stripDocumentTimes(previous.meta)
    : undefined;
  const nextMeta = stripDocumentTimes(next.meta);
  if (!previousMeta || canonicalize(previousMeta) !== canonicalize(nextMeta)) {
    operations.push({ op: "set-meta", value: nextMeta });
  }
  return operations;
}

export async function stampDraftOperations(
  transactionId: string,
  operations: readonly DraftOperation[],
  options: {
    startSequence?: number;
    opIdFactory?: (transactionId: string, sequence: number) => string;
    hashProvider?: HashProvider;
  } = {},
): Promise<Extract<CommitCommand, { type: "apply" }>[]> {
  const start = options.startSequence ?? 1;
  const idFactory = options.opIdFactory ?? ((id, sequence) => `op:${id}:${sequence}`);
  const provider = options.hashProvider ?? webCryptoSha256Provider;
  return Promise.all(operations.map(async (operation, index) => {
    const seq = start + index;
    return {
      type: "apply" as const,
      transactionId,
      seq,
      opId: idFactory(transactionId, seq),
      payloadHash: await canonicalHash(operation, provider),
      operation,
    };
  }));
}

function appendMapDelta(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  kind: "node" | "state" | "action" | "claim",
  operations: DraftOperation[],
): void {
  const removed = Object.keys(previous).filter((id) => !(id in next)).sort();
  for (const id of removed) {
    if (kind === "node") operations.push({ op: "remove-node", nodeId: id });
    else if (kind === "state") operations.push({ op: "remove-state", stateId: id });
    else if (kind === "action") operations.push({ op: "remove-action", actionId: id });
    else operations.push({ op: "remove-claim", claimId: id });
  }
  const changed = Object.keys(next)
    .filter((id) => !(id in previous) || canonicalize(previous[id]) !== canonicalize(next[id]))
    .sort();
  for (const id of changed) {
    if (kind === "node") operations.push({ op: "put-node", nodeId: id, value: next[id] as ArtifactDocument["nodes"][string] });
    else if (kind === "state") operations.push({ op: "put-state", stateId: id, value: next[id] as ArtifactDocument["state"][string] });
    else if (kind === "action") operations.push({ op: "put-action", actionId: id, value: next[id] as ArtifactDocument["actions"][string] });
    else operations.push({ op: "put-claim", claimId: id, value: next[id] as ArtifactDocument["claims"][string] });
  }
}

function appendResourceDelta(
  previous: ArtifactDocument["resources"],
  next: ArtifactDocument["resources"],
  operations: DraftOperation[],
): void {
  const detached = Object.keys(previous)
    .filter((id) => !next[id] || canonicalize(previous[id]) !== canonicalize(next[id]))
    .sort();
  for (const resourceId of detached) operations.push({ op: "detach-resource", resourceId });
  const attached = Object.keys(next)
    .filter((id) => !previous[id] || canonicalize(previous[id]) !== canonicalize(next[id]))
    .sort();
  for (const resourceId of attached) operations.push({ op: "attach-resource", resourceId });
}

function stripDocumentTimes(meta: ArtifactDocument["meta"]): Omit<ArtifactDocument["meta"], "createdAt" | "updatedAt"> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = meta;
  return value;
}
