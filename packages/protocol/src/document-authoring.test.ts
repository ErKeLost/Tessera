import { describe, expect, test } from "bun:test";
import {
  authoringActionDefinitionSchema,
  authoringProposalOperationSchema,
  authoringResourceBindingSchema,
  authoringSnapshotProposalSchema,
  canonicalEntityOperationSchema,
  committedRevisionSchema,
  documentContentSchema,
  hashDocumentContent,
  resourceBindingDeclarationSchema,
  surfaceResourceGrantSchema,
  transactionIdentityMapDeltaSchema,
  transactionIdentityMapSchema,
  verifyCommittedRevision,
} from "./index";
import { createCommittedRevision, createDocumentContent, testHash } from "./test-fixtures";

describe("canonical Document and Revision boundaries", () => {
  test("hashes only DocumentContent, never envelope identity or audit time", async () => {
    const committed = await createCommittedRevision();
    expect(await verifyCommittedRevision(committed)).toBe(true);

    const movedEnvelope = committedRevisionSchema.parse({
      ...committed,
      envelope: {
        ...committed.envelope,
        documentId: "document-copy",
        revisionId: "revision-copy",
        createdBy: "audit-copy",
        createdAt: "2026-08-23T00:00:00Z",
      },
    });
    expect(await verifyCommittedRevision(movedEnvelope)).toBe(true);
    expect(movedEnvelope.envelope.contentHash).toBe(committed.envelope.contentHash);
  });

  test("changes contentHash for semantic content changes", async () => {
    const content = createDocumentContent();
    const changed = documentContentSchema.parse({
      ...content,
      meta: { ...content.meta, title: "Changed" },
    });
    expect(await hashDocumentContent(changed)).not.toBe(await hashDocumentContent(content));
  });

  test("rejects runtime authority and branch fields in persistent content", () => {
    const content = createDocumentContent();
    expect(documentContentSchema.safeParse({ ...content, branchId: "main" }).success).toBe(false);
    expect(documentContentSchema.safeParse({ ...content, grantId: "grant" }).success).toBe(false);
    expect(documentContentSchema.safeParse({ ...content, resourcePayload: [] }).success).toBe(false);

    const committed = {
      documentId: "document-test",
      revisionId: "revision-test",
      parentRevisionIds: [],
      contentHash: testHash(),
      hashProfile: "open-generative.jcs-sha256.2026-08-22",
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00Z",
      createdBy: "audit-test",
      branchId: "main",
    };
    expect(committedRevisionSchema.safeParse({ envelope: committed, content }).success).toBe(false);
  });

  test("rejects dangling and cyclic node graphs", () => {
    const content = createDocumentContent();
    const dangling = structuredClone(content) as unknown as Record<string, unknown>;
    (dangling.nodes as Record<string, any>).root.slots = { body: ["missing"] };
    expect(documentContentSchema.safeParse(dangling).success).toBe(false);

    const cyclic = structuredClone(content) as unknown as Record<string, unknown>;
    (cyclic.nodes as Record<string, any>).root.slots = { body: ["root"] };
    expect(documentContentSchema.safeParse(cyclic).success).toBe(false);
  });
});

describe("authoring proposal boundary", () => {
  const emptySnapshot = {
    kind: "snapshot",
    root: { localId: "same", component: "stack", slots: {} },
    stateDefinitions: [{ localId: "same", value: { schema: true, initial: null } }],
    actions: [],
    resourceBindings: [],
    evidenceBindings: [],
    claims: [],
    meta: { tags: [] },
  } as const;

  test("allows the same local string in different entity namespaces", () => {
    expect(authoringSnapshotProposalSchema.safeParse(emptySnapshot).success).toBe(true);
  });

  test("rejects duplicate local IDs within one entity namespace", () => {
    const duplicate = {
      ...emptySnapshot,
      root: {
        ...emptySnapshot.root,
        slots: {
          body: [
            { localId: "child", component: "text", slots: {} },
            { localId: "child", component: "text", slots: {} },
          ],
        },
      },
    };
    expect(authoringSnapshotProposalSchema.safeParse(duplicate).success).toBe(false);
  });

  test("accepts only Slice IDs for resource, evidence, action, and component selection", () => {
    expect(authoringResourceBindingSchema.safeParse({ source: "query-result" }).success).toBe(true);
    expect(authoringResourceBindingSchema.safeParse({
      source: { bindingId: "query", offerHash: testHash() },
      resourceKey: "forbidden-host-key",
    }).success).toBe(false);

    expect(authoringActionDefinitionSchema.safeParse({
      kind: "host-intent",
      action: "export-csv",
      input: {},
    }).success).toBe(true);
    expect(authoringActionDefinitionSchema.safeParse({
      kind: "host-intent",
      contract: {
        publisher: "host",
        catalogId: "private",
        actionType: "data.export",
        revision: 1,
        contractHash: testHash(),
      },
      input: {},
    }).success).toBe(false);
  });

  test("operation node bodies cannot recursively smuggle nested nodes", () => {
    const valid = {
      op: "put-node",
      target: { kind: "node", localId: "root" },
      value: { component: "stack", props: {}, slots: {}, events: {}, evidence: [] },
    };
    expect(authoringProposalOperationSchema.safeParse(valid).success).toBe(true);
    expect(authoringProposalOperationSchema.safeParse({
      ...valid,
      value: { ...valid.value, slots: { body: [{ localId: "nested", component: "text" }] } },
    }).success).toBe(false);
  });

  test("canonical remove operations always carry entity revision preconditions", () => {
    expect(canonicalEntityOperationSchema.safeParse({
      op: "remove-node",
      nodeId: "root",
    }).success).toBe(false);
    expect(canonicalEntityOperationSchema.safeParse({
      op: "remove-node",
      nodeId: "root",
      expectedEntityRevision: "entity-revision-1",
    }).success).toBe(true);
  });
});

describe("transaction identity and resource separation", () => {
  test("identity-map delta is an actual typed delta and keeps entity namespaces separate", () => {
    expect(transactionIdentityMapDeltaSchema.safeParse([
      { kind: "node", localId: "same", canonicalId: "node-1" },
      { kind: "state", localId: "same", canonicalId: "state-1" },
    ]).success).toBe(true);
    expect(transactionIdentityMapDeltaSchema.safeParse([
      { kind: "node", localId: "same", canonicalId: "node-1" },
      { kind: "node", localId: "same", canonicalId: "node-2" },
    ]).success).toBe(false);
    expect(transactionIdentityMapSchema.safeParse({
      "node:local": { kind: "state", id: "state-1" },
    }).success).toBe(false);
  });

  test("persistent declarations and runtime grants reject each other's fields", () => {
    const declaration = {
      resourceKey: "query-result-key",
      kind: "dataset",
      schemaConstraint: {
        schemaId: "query-table",
        schemaRevision: 1,
        schemaHash: testHash("4"),
        compatibility: "exact",
      },
      selector: {},
      resolution: { mode: "pinned", versionId: "query-v1", contentHash: testHash("5") },
    };
    expect(resourceBindingDeclarationSchema.safeParse(declaration).success).toBe(true);
    expect(resourceBindingDeclarationSchema.safeParse({ ...declaration, grantId: "grant" }).success).toBe(false);

    const grant = {
      grantId: "grant-1",
      bindingId: "query-binding",
      surfaceSessionId: "surface-1",
      actorBindingHash: testHash("6"),
      tenantBindingHash: testHash("7"),
      authorityPolicyRevision: "policy-1",
      allowedOperations: ["read"],
      rowPolicyHash: testHash("8"),
      columnPolicyHash: testHash("9"),
      expiresAt: "2026-08-23T00:00:00Z",
      revocationEpoch: 1,
    };
    expect(surfaceResourceGrantSchema.safeParse(grant).success).toBe(true);
    expect(surfaceResourceGrantSchema.safeParse({ ...grant, resourceKey: "forbidden" }).success).toBe(false);
  });
});
