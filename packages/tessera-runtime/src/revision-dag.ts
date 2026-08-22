import { createDiagnostic } from "./diagnostics";
import type { ArtifactDocument, Diagnostic } from "./schemas";
import type { ArtifactRuntimeStorePort } from "./store";

export type RevisionDagWalk = {
  revisions: ArtifactDocument[];
  diagnostics: Diagnostic[];
};

export async function walkRevisionAncestors(
  store: Pick<ArtifactRuntimeStorePort, "getRevision">,
  documentId: string,
  startRevisionIds: readonly string[],
  maxRevisions = 10_000,
): Promise<RevisionDagWalk> {
  const revisions: ArtifactDocument[] = [];
  const diagnostics: Diagnostic[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();

  const visit = async (revisionId: string): Promise<void> => {
    if (visited.has(revisionId)) return;
    if (active.has(revisionId)) {
      diagnostics.push(dagDiagnostic("revision.cycle", `Revision DAG contains a cycle at ${revisionId}.`, revisionId));
      return;
    }
    if (visited.size >= maxRevisions) {
      diagnostics.push(dagDiagnostic("revision.walk-limit", `Revision walk exceeds ${maxRevisions} revisions.`, revisionId));
      return;
    }

    active.add(revisionId);
    const revision = await store.getRevision(documentId, revisionId);
    if (!revision) {
      diagnostics.push(dagDiagnostic("revision.missing-parent", `Revision ${revisionId} is missing.`, revisionId));
      active.delete(revisionId);
      return;
    }
    for (const parentId of revision.revision.parentRevisionIds) await visit(parentId);
    active.delete(revisionId);
    visited.add(revisionId);
    revisions.push(revision);
  };

  for (const startRevisionId of startRevisionIds) await visit(startRevisionId);
  return { revisions, diagnostics };
}

export async function isRevisionAncestor(
  store: Pick<ArtifactRuntimeStorePort, "getRevision">,
  documentId: string,
  ancestorRevisionId: string,
  descendantRevisionId: string,
  maxRevisions = 10_000,
): Promise<boolean> {
  if (ancestorRevisionId === descendantRevisionId) return true;
  const pending = [descendantRevisionId];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < maxRevisions) {
    const revisionId = pending.pop()!;
    if (visited.has(revisionId)) continue;
    visited.add(revisionId);
    const revision = await store.getRevision(documentId, revisionId);
    if (!revision) continue;
    for (const parentId of revision.revision.parentRevisionIds) {
      if (parentId === ancestorRevisionId) return true;
      pending.push(parentId);
    }
  }
  return false;
}

export async function findRevisionHeads(
  store: Pick<ArtifactRuntimeStorePort, "listRevisions">,
  documentId: string,
): Promise<ArtifactDocument[]> {
  const revisions = await store.listRevisions(documentId);
  const parentIds = new Set(revisions.flatMap((revision) => revision.revision.parentRevisionIds));
  return revisions.filter((revision) => !parentIds.has(revision.revision.revisionId));
}

function dagDiagnostic(code: string, message: string, revisionId: string): Diagnostic {
  return createDiagnostic({
    phase: "validate",
    code,
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
    location: { revisionId },
  });
}
