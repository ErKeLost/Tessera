import {
  verifyCommittedRevision,
  type DocumentId,
  type HashProvider,
  type RevisionId,
} from "@open-generative/protocol";
import type { RevisionBranchStorePort, StoredRevision } from "./store";
import { immutableClone } from "./utils";

export type RevisionDagIssue = {
  code:
    | "revision.cycle"
    | "revision.missing"
    | "revision.identity-mismatch"
    | "revision.hash-invalid"
    | "revision.walk-limit";
  message: string;
  revisionId?: RevisionId;
};

export type RevisionDagWalk = {
  revisions: readonly StoredRevision[];
  issues: readonly RevisionDagIssue[];
  complete: boolean;
};

export type RevisionDagWalkOptions = {
  maxRevisions?: number;
  verifyHashes?: boolean;
  hashProvider?: HashProvider;
};

export async function walkRevisionAncestors(
  store: Pick<RevisionBranchStorePort, "getRevision">,
  documentId: DocumentId,
  startRevisionIds: readonly RevisionId[],
  options: RevisionDagWalkOptions = {},
): Promise<RevisionDagWalk> {
  const maxRevisions = normalizeLimit(options.maxRevisions);
  const revisions: StoredRevision[] = [];
  const issues: RevisionDagIssue[] = [];
  const visited = new Set<RevisionId>();
  const active = new Set<RevisionId>();
  const unavailable = new Set<RevisionId>();
  let limitReached = false;

  const visit = async (revisionId: RevisionId): Promise<void> => {
    if (visited.has(revisionId) || unavailable.has(revisionId)) return;
    if (active.has(revisionId)) {
      issues.push(issue("revision.cycle", `Revision DAG contains a cycle at ${revisionId}.`, revisionId));
      return;
    }
    if (visited.size + active.size >= maxRevisions) {
      if (!limitReached) {
        issues.push(issue("revision.walk-limit", `Revision walk exceeds ${maxRevisions} revisions.`, revisionId));
        limitReached = true;
      }
      return;
    }

    active.add(revisionId);
    const stored = await store.getRevision(documentId, revisionId);
    if (!stored) {
      unavailable.add(revisionId);
      active.delete(revisionId);
      issues.push(issue("revision.missing", `Revision ${revisionId} is missing.`, revisionId));
      return;
    }
    if (
      stored.revision.envelope.documentId !== documentId
      || stored.revision.envelope.revisionId !== revisionId
    ) {
      unavailable.add(revisionId);
      active.delete(revisionId);
      issues.push(issue(
        "revision.identity-mismatch",
        `Stored revision ${revisionId} does not match its lookup identity.`,
        revisionId,
      ));
      return;
    }
    if (options.verifyHashes !== false) {
      let valid = false;
      try {
        valid = await verifyCommittedRevision(stored.revision, options.hashProvider);
      } catch {
        valid = false;
      }
      if (!valid) {
        unavailable.add(revisionId);
        active.delete(revisionId);
        issues.push(issue("revision.hash-invalid", `Revision ${revisionId} failed content-hash verification.`, revisionId));
        return;
      }
    }

    const parents = [...stored.revision.envelope.parentRevisionIds].sort();
    for (const parentId of parents) await visit(parentId);
    active.delete(revisionId);
    if (visited.has(revisionId)) return;
    visited.add(revisionId);
    revisions.push(stored);
  };

  for (const revisionId of [...new Set(startRevisionIds)].sort()) await visit(revisionId);
  return immutableClone({
    revisions,
    issues,
    complete: issues.length === 0,
  });
}

export type RevisionAncestryResult = {
  isAncestor: boolean;
  issues: readonly RevisionDagIssue[];
};

export async function isRevisionAncestor(
  store: Pick<RevisionBranchStorePort, "getRevision">,
  documentId: DocumentId,
  ancestorRevisionId: RevisionId,
  descendantRevisionId: RevisionId,
  options: RevisionDagWalkOptions = {},
): Promise<RevisionAncestryResult> {
  const walk = await walkRevisionAncestors(store, documentId, [descendantRevisionId], options);
  return {
    isAncestor: walk.revisions.some((stored) => stored.revision.envelope.revisionId === ancestorRevisionId),
    issues: walk.issues,
  };
}

export type RevisionMergeBasesResult = {
  bases: readonly StoredRevision[];
  issues: readonly RevisionDagIssue[];
  complete: boolean;
};

export async function findRevisionMergeBases(
  store: Pick<RevisionBranchStorePort, "getRevision">,
  documentId: DocumentId,
  leftRevisionId: RevisionId,
  rightRevisionId: RevisionId,
  options: RevisionDagWalkOptions = {},
): Promise<RevisionMergeBasesResult> {
  const [left, right] = await Promise.all([
    walkRevisionAncestors(store, documentId, [leftRevisionId], options),
    walkRevisionAncestors(store, documentId, [rightRevisionId], options),
  ]);
  const issues = deduplicateIssues([...left.issues, ...right.issues]);
  const records = new Map<RevisionId, StoredRevision>();
  for (const stored of [...left.revisions, ...right.revisions]) {
    records.set(stored.revision.envelope.revisionId, stored);
  }
  const leftIds = new Set(left.revisions.map((stored) => stored.revision.envelope.revisionId));
  const rightIds = new Set(right.revisions.map((stored) => stored.revision.envelope.revisionId));
  const common = [...leftIds].filter((revisionId) => rightIds.has(revisionId));
  const ancestorMemo = new Map<RevisionId, ReadonlySet<RevisionId>>();
  const isOlderCommonAncestor = (candidate: RevisionId): boolean => common.some((other) => (
    other !== candidate && ancestorsOf(other, records, ancestorMemo).has(candidate)
  ));
  const bases = common
    .filter((candidate) => !isOlderCommonAncestor(candidate))
    .sort()
    .map((revisionId) => records.get(revisionId)!)
    .filter(Boolean);
  return immutableClone({
    bases,
    issues,
    complete: left.complete && right.complete,
  });
}

export type UniqueRevisionMergeBaseResult =
  | { status: "unique"; base: StoredRevision; issues: readonly RevisionDagIssue[] }
  | { status: "none" | "ambiguous" | "incomplete"; bases: readonly StoredRevision[]; issues: readonly RevisionDagIssue[] };

export async function findUniqueRevisionMergeBase(
  store: Pick<RevisionBranchStorePort, "getRevision">,
  documentId: DocumentId,
  leftRevisionId: RevisionId,
  rightRevisionId: RevisionId,
  options: RevisionDagWalkOptions = {},
): Promise<UniqueRevisionMergeBaseResult> {
  const result = await findRevisionMergeBases(
    store,
    documentId,
    leftRevisionId,
    rightRevisionId,
    options,
  );
  if (!result.complete) return { status: "incomplete", bases: result.bases, issues: result.issues };
  if (result.bases.length === 0) return { status: "none", bases: [], issues: result.issues };
  if (result.bases.length > 1) return { status: "ambiguous", bases: result.bases, issues: result.issues };
  return { status: "unique", base: result.bases[0]!, issues: result.issues };
}

export async function findRevisionHeads(
  store: Pick<RevisionBranchStorePort, "listDocumentRevisions">,
  documentId: DocumentId,
): Promise<readonly StoredRevision[]> {
  const revisions = await store.listDocumentRevisions(documentId);
  const parentIds = new Set(revisions.flatMap((stored) => stored.revision.envelope.parentRevisionIds));
  return immutableClone(revisions
    .filter((stored) => (
      stored.revision.envelope.documentId === documentId
      && !parentIds.has(stored.revision.envelope.revisionId)
    ))
    .sort((left, right) => (
      left.revision.envelope.revisionId.localeCompare(right.revision.envelope.revisionId)
    )));
}

function ancestorsOf(
  revisionId: RevisionId,
  records: ReadonlyMap<RevisionId, StoredRevision>,
  memo: Map<RevisionId, ReadonlySet<RevisionId>>,
): ReadonlySet<RevisionId> {
  const cached = memo.get(revisionId);
  if (cached) return cached;
  const ancestors = new Set<RevisionId>();
  const pending = [...(records.get(revisionId)?.revision.envelope.parentRevisionIds ?? [])];
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (ancestors.has(candidate)) continue;
    ancestors.add(candidate);
    pending.push(...(records.get(candidate)?.revision.envelope.parentRevisionIds ?? []));
  }
  memo.set(revisionId, ancestors);
  return ancestors;
}

function normalizeLimit(value = 10_000): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError("maxRevisions must be a positive integer.");
  return value;
}

function issue(
  code: RevisionDagIssue["code"],
  message: string,
  revisionId?: RevisionId,
): RevisionDagIssue {
  return revisionId === undefined ? { code, message } : { code, message, revisionId };
}

function deduplicateIssues(issues: readonly RevisionDagIssue[]): RevisionDagIssue[] {
  const unique = new Map<string, RevisionDagIssue>();
  for (const item of issues) unique.set(`${item.code}\u0000${item.revisionId ?? ""}\u0000${item.message}`, item);
  return [...unique.values()];
}
