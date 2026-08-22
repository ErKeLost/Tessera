import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROTOCOL_LIMITS,
  actorAuditRefSchema,
  branchHeadSchema,
  branchIdSchema,
  documentContentSchema,
  hashDocumentContent,
  headTokenSchema,
  nodeIdSchema,
  revisionIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  transactionIdentityMapDeltaSchema,
  type CanonicalEntityOperation,
  type DocumentContent,
} from "@open-generative/protocol";
import { applyCanonicalOperationChecked } from "./document-operations";
import { InMemoryRuntimeStore } from "./store";
import {
  DocumentTransactionRuntime,
  type BeginTransactionInput,
  type RuntimeTransactionRecord,
} from "./transaction";
import {
  acceptingValidationPort,
  createOperationEnvelope,
  createStoredRevision,
} from "./test-fixtures";

describe("canonical document operations", () => {
  test("equivalent snapshot and ordered operations produce the same content hash", async () => {
    const base = await createStoredRevision();
    const rootRevision = base.entityRevisions.nodes.root!;
    const operation: CanonicalEntityOperation = {
      op: "put-node",
      nodeId: nodeIdSchema.parse("root"),
      expectedEntityRevision: rootRevision,
      value: {
        ...base.revision.content.nodes[nodeIdSchema.parse("root")]!,
        props: { gap: { kind: "literal", value: "lg" } },
      },
    };
    const reduced = await applyCanonicalOperationChecked(
      base.revision.content,
      base.entityRevisions,
      operation,
    );
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) return;

    const snapshot = documentContentSchema.parse({
      ...base.revision.content,
      nodes: {
        ...base.revision.content.nodes,
        root: operation.value,
      },
    });
    expect(await hashDocumentContent(reduced.content)).toBe(await hashDocumentContent(snapshot));
  });
});

describe("document transaction runtime", () => {
  test("buffers out-of-order operations, drains dependencies, and replays identity deltas", async () => {
    const { runtime, store, base, begin } = await setupTransaction("transaction-order", "revision-order");
    expect((await runtime.begin(begin)).status).toBe("begun");
    const child = childNode(base.revision.content, "hello");
    const first = await createOperationEnvelope({
      transactionId: begin.transactionId,
      operationId: "operation-child",
      sequence: 1,
      operation: { op: "put-node", nodeId: nodeIdSchema.parse("child"), value: child },
    });
    const second = await createOperationEnvelope({
      transactionId: begin.transactionId,
      operationId: "operation-root",
      sequence: 2,
      dependsOn: [first.operationId],
      operation: {
        op: "put-node",
        nodeId: nodeIdSchema.parse("root"),
        expectedEntityRevision: base.entityRevisions.nodes.root,
        value: {
          ...base.revision.content.nodes[nodeIdSchema.parse("root")]!,
          slots: { body: [nodeIdSchema.parse("child")] },
        },
      },
    });
    expect((await runtime.apply(second)).status).toBe("buffered");

    const delta = transactionIdentityMapDeltaSchema.parse([
      { kind: "node", localId: "child-local", canonicalId: "child" },
    ]);
    const accepted = await runtime.apply(first, delta);
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;
    expect(accepted.acceptedThroughSequence).toBe(2);
    expect(accepted.previews).toHaveLength(1);
    expect(accepted.previews[0]?.renderableNodeIds.map(String)).toEqual(["child", "root"]);
    expect((await runtime.apply(first, delta)).status).toBe("replayed");

    const record = await store.getTransaction(begin.transactionId);
    expect(record?.value.applied).toHaveLength(2);
    expect(record?.value.applied[0]?.identityMapDelta).toEqual(delta);
  });

  test("atomically commits transaction, immutable revision, and branch head", async () => {
    const { runtime, store, base, begin } = await setupTransaction("transaction-commit", "revision-commit");
    await runtime.begin(begin);
    const operation = await rootGapOperation(base, begin, "xl", "operation-commit");
    const applied = await runtime.apply(operation);
    expect(applied.status).toBe("accepted");
    if (applied.status !== "accepted") return;
    const record = await runtime.getTransaction(begin.transactionId);
    const expectedContentHash = await hashDocumentContent(record!.draft);
    const committed = await runtime.finalize({
      transactionId: begin.transactionId,
      finalOperationSequence: 1,
      expectedContentHash,
      expectedOverlayHash: applied.previews[0]!.overlayHash,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") return;
    expect((await store.getTransaction(begin.transactionId))?.value.status).toBe("committed");
    expect((await store.getRevision(begin.documentId, begin.targetRevisionId))?.revision).toEqual(committed.revision);
    expect(await store.getBranchHead(begin.documentId, begin.branchId)).toEqual({
      documentId: begin.documentId,
      branchId: begin.branchId,
      revisionId: begin.targetRevisionId,
      headToken: begin.nextHeadToken,
    });
    expect((await runtime.finalize({
      transactionId: begin.transactionId,
      finalOperationSequence: 1,
      expectedContentHash,
      expectedOverlayHash: applied.previews[0]!.overlayHash,
    })).status).toBe("replayed");
  });

  test("preserves the new last-good revision when a concurrent branch CAS loses", async () => {
    const base = await createStoredRevision();
    const store = new InMemoryRuntimeStore<RuntimeTransactionRecord>();
    const branchHead = branchHeadSchema.parse({
      documentId: base.revision.envelope.documentId,
      branchId: "main",
      revisionId: base.revision.envelope.revisionId,
      headToken: "head-base",
    });
    store.seedRevision(base, branchHead);
    const runtime = new DocumentTransactionRuntime({ store, validation: acceptingValidationPort });
    const first = beginInput(base, "transaction-first", "revision-first", "head-first");
    const second = beginInput(base, "transaction-second", "revision-second", "head-second");
    await runtime.begin(first);
    await runtime.begin(second);

    const firstApply = await runtime.apply(await rootGapOperation(base, first, "lg", "operation-first"));
    const secondApply = await runtime.apply(await rootGapOperation(base, second, "lg", "operation-second"));
    if (firstApply.status !== "accepted" || secondApply.status !== "accepted") throw new Error("expected accepted");
    const expectedHash = await hashDocumentContent((await runtime.getTransaction(first.transactionId))!.draft);
    expect((await runtime.finalize({
      transactionId: first.transactionId,
      finalOperationSequence: 1,
      expectedContentHash: expectedHash,
      expectedOverlayHash: firstApply.previews[0]!.overlayHash,
    })).status).toBe("committed");
    const conflict = await runtime.finalize({
      transactionId: second.transactionId,
      finalOperationSequence: 1,
      expectedContentHash: expectedHash,
      expectedOverlayHash: secondApply.previews[0]!.overlayHash,
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") return;
    expect(conflict.lastGood?.envelope.revisionId).toBe(first.targetRevisionId);
    expect((await runtime.getTransaction(second.transactionId))?.status).toBe("aborted");
  });

  test("keeps canonical identity claims retired after abort", async () => {
    const base = await createStoredRevision();
    const store = new InMemoryRuntimeStore<RuntimeTransactionRecord>();
    store.seedRevision(base, branchHeadSchema.parse({
      documentId: base.revision.envelope.documentId,
      branchId: "main",
      revisionId: base.revision.envelope.revisionId,
      headToken: "head-base",
    }));
    const runtime = new DocumentTransactionRuntime({ store, validation: acceptingValidationPort });
    const first = beginInput(base, "transaction-retire-1", "revision-retire-1", "head-retire-1");
    const second = beginInput(base, "transaction-retire-2", "revision-retire-2", "head-retire-2");
    await runtime.begin(first);
    const operationOne = await createOperationEnvelope({
      transactionId: first.transactionId,
      operationId: "operation-retire-1",
      sequence: 1,
      operation: { op: "put-node", nodeId: nodeIdSchema.parse("retired-node"), value: childNode(base.revision.content, "one") },
    });
    const firstDelta = transactionIdentityMapDeltaSchema.parse([
      { kind: "node", localId: "local-one", canonicalId: "retired-node" },
    ]);
    expect((await runtime.apply(operationOne, firstDelta)).status).toBe("accepted");
    await runtime.abort(first.transactionId);

    await runtime.begin(second);
    const operationTwo = await createOperationEnvelope({
      transactionId: second.transactionId,
      operationId: "operation-retire-2",
      sequence: 1,
      operation: { op: "put-node", nodeId: nodeIdSchema.parse("retired-node"), value: childNode(base.revision.content, "two") },
    });
    const secondDelta = transactionIdentityMapDeltaSchema.parse([
      { kind: "node", localId: "local-two", canonicalId: "retired-node" },
    ]);
    expect((await runtime.apply(operationTwo, secondDelta)).status).toBe("conflict");
  });

  test("rejects malformed transaction boundaries and excessive operation sequences", async () => {
    const { runtime, begin, base } = await setupTransaction("transaction-limits", "revision-limits");
    expect((await runtime.begin({
      ...begin,
      createdAt: "not-an-iso-timestamp",
    })).status).toBe("rejected");
    expect((await runtime.begin({
      ...begin,
      targetRevisionId: begin.baseRevisionId,
    })).status).toBe("rejected");
    expect((await runtime.begin(begin)).status).toBe("begun");

    const excessive = await createOperationEnvelope({
      transactionId: begin.transactionId,
      operationId: "operation-over-limit",
      sequence: DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction + 1,
      operation: {
        op: "put-node",
        nodeId: nodeIdSchema.parse("root"),
        expectedEntityRevision: base.entityRevisions.nodes.root,
        value: base.revision.content.nodes[nodeIdSchema.parse("root")]!,
      },
    });
    expect((await runtime.apply(excessive)).status).toBe("rejected");

    const invalidFinalize = await runtime.finalize({
      transactionId: begin.transactionId,
      finalOperationSequence: DEFAULT_PROTOCOL_LIMITS.maxOperationsPerTransaction + 1,
      expectedContentHash: await hashDocumentContent(base.revision.content),
    });
    expect(invalidFinalize.status).toBe("rejected");
    if (invalidFinalize.status === "rejected") {
      expect(invalidFinalize.issues[0]?.code).toBe("finalize.input-invalid");
    }
    expect((await runtime.getTransaction(begin.transactionId))?.status).toBe("active");
  });
});

async function setupTransaction(transactionId: string, targetRevisionId: string) {
  const base = await createStoredRevision();
  const store = new InMemoryRuntimeStore<RuntimeTransactionRecord>();
  store.seedRevision(base, branchHeadSchema.parse({
    documentId: base.revision.envelope.documentId,
    branchId: "main",
    revisionId: base.revision.envelope.revisionId,
    headToken: "head-base",
  }));
  const runtime = new DocumentTransactionRuntime({ store, validation: acceptingValidationPort });
  return {
    runtime,
    store,
    base,
    begin: beginInput(base, transactionId, targetRevisionId, `head-${targetRevisionId}`),
  };
}

function beginInput(
  base: Awaited<ReturnType<typeof createStoredRevision>>,
  transactionId: string,
  targetRevisionId: string,
  nextHeadToken: string,
): BeginTransactionInput {
  return {
    transactionId: transactionIdSchema.parse(transactionId),
    surfaceSessionId: surfaceSessionIdSchema.parse("surface-test"),
    documentId: base.revision.envelope.documentId,
    branchId: branchIdSchema.parse("main"),
    baseRevisionId: base.revision.envelope.revisionId,
    expectedHeadToken: headTokenSchema.parse("head-base"),
    targetRevisionId: revisionIdSchema.parse(targetRevisionId),
    nextHeadToken: headTokenSchema.parse(nextHeadToken),
    createdAt: "2026-08-22T01:00:00Z",
    createdBy: actorAuditRefSchema.parse("audit-test"),
  };
}

async function rootGapOperation(
  base: Awaited<ReturnType<typeof createStoredRevision>>,
  begin: BeginTransactionInput,
  gap: string,
  operationId: string,
) {
  return createOperationEnvelope({
    transactionId: begin.transactionId,
    operationId,
    sequence: 1,
    operation: {
      op: "put-node",
      nodeId: nodeIdSchema.parse("root"),
      expectedEntityRevision: base.entityRevisions.nodes.root,
      value: {
        ...base.revision.content.nodes[nodeIdSchema.parse("root")]!,
        props: { gap: { kind: "literal", value: gap } },
      },
    },
  });
}

function childNode(content: DocumentContent, text: string) {
  const root = content.nodes[nodeIdSchema.parse("root")]!;
  return {
    ...root,
    contract: { ...root.contract, componentType: root.contract.componentType },
    props: { text: { kind: "literal" as const, value: text } },
  };
}
