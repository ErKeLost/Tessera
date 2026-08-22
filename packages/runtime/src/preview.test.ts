import { describe, expect, test } from "bun:test";
import {
  nodeIdSchema,
  revisionIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
  type CanonicalEntityOperation,
  type DocumentContent,
} from "@open-generative/protocol";
import {
  projectValidatedPreview,
  verifyValidatedPreviewHash,
} from "./preview";
import { createDocumentContent } from "./test-fixtures";
import type { RuntimeValidationPort } from "./validation";

describe("validated preview projection", () => {
  test("gates progressive and atomic nodes through distinct readiness policies", async () => {
    const base = createDocumentContent();
    const operation = rootUpdate(base, "lg");
    const document = {
      ...base,
      nodes: { ...base.nodes, root: operation.value },
    } as DocumentContent;
    const progressive = await projectValidatedPreview(previewInput(document, operation), validation("progressive", false));
    expect(progressive.ok).toBe(true);
    if (!progressive.ok) return;
    expect(progressive.preview.renderableNodeIds.map(String)).toEqual(["root"]);

    const atomic = await projectValidatedPreview(previewInput(document, operation), validation("atomic", false));
    expect(atomic.ok).toBe(true);
    if (!atomic.ok) return;
    expect(atomic.preview.renderableNodeIds).toEqual([]);

    const ready = await projectValidatedPreview(previewInput(document, operation), validation("atomic", true));
    expect(ready.ok).toBe(true);
    if (ready.ok) expect(ready.preview.renderableNodeIds.map(String)).toEqual(["root"]);
  });

  test("keeps forward references in draft without exposing or rejecting the incomplete node", async () => {
    const base = createDocumentContent();
    const operation: CanonicalEntityOperation = {
      op: "put-node",
      nodeId: nodeIdSchema.parse("root"),
      value: {
        ...base.nodes[nodeIdSchema.parse("root")]!,
        slots: { body: [nodeIdSchema.parse("future-child")] },
      },
    };
    const document = {
      ...base,
      nodes: { ...base.nodes, root: operation.value },
    } as DocumentContent;
    let validationCalls = 0;
    const port: RuntimeValidationPort = {
      validateNode: () => {
        validationCalls += 1;
        return [];
      },
      validateDocument: () => [],
      commitPolicy: () => "progressive",
      isNodeReady: () => true,
    };
    const result = await projectValidatedPreview(previewInput(document, operation), port);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.renderableNodeIds).toEqual([]);
    expect(validationCalls).toBe(0);
  });

  test("tracks identity references as preview dependencies and affected-node inputs", async () => {
    const base = createDocumentContent();
    const stateId = "filter.region" as never;
    const definition = {
      schema: { type: "string" },
      schemaHash: base.contracts.contractSetHash,
      initial: "all",
      sensitivity: "private" as const,
      modelVisibility: "descriptor" as const,
      retention: "retain" as const,
      scope: "surface" as const,
      persistence: "session" as const,
    };
    const operation: CanonicalEntityOperation = {
      op: "put-state",
      stateId,
      value: definition,
    };
    const document = {
      ...base,
      nodes: {
        ...base.nodes,
        root: {
          ...base.nodes[base.rootNodeId]!,
          props: { filterStateId: { kind: "state-id-ref", stateId } },
        },
      },
      stateDefinitions: { [stateId]: definition },
    } as DocumentContent;
    let validatedNode = false;
    const result = await projectValidatedPreview(previewInput(document, operation), {
      ...validation("progressive", true),
      validateNode: () => {
        validatedNode = true;
        return [];
      },
    });

    expect(result.ok).toBe(true);
    expect(validatedNode).toBe(true);
    if (result.ok) expect(result.preview.renderableNodeIds.map(String)).toEqual(["root"]);
  });

  test("rejects a dependency-closed affected node that fails Contract validation", async () => {
    const base = createDocumentContent();
    const operation = rootUpdate(base, "invalid");
    const result = await projectValidatedPreview(
      previewInput({ ...base, nodes: { ...base.nodes, root: operation.value } } as DocumentContent, operation),
      {
        ...validation("progressive", true),
        validateNode: () => [{ code: "contract.invalid", message: "Invalid props." }],
      },
    );
    expect(result).toEqual({
      ok: false,
      issues: [{ code: "contract.invalid", message: "Invalid props." }],
    });
  });

  test("binds and verifies the complete overlay hash chain", async () => {
    const base = createDocumentContent();
    const firstOperation = rootUpdate(base, "lg");
    const first = await projectValidatedPreview(
      previewInput({ ...base, nodes: { ...base.nodes, root: firstOperation.value } } as DocumentContent, firstOperation),
      validation("progressive", true),
    );
    if (!first.ok) throw new Error("expected valid first preview");
    expect(await verifyValidatedPreviewHash(first.preview)).toBe(true);

    const secondOperation = rootUpdate(base, "xl");
    const second = await projectValidatedPreview({
      ...previewInput({ ...base, nodes: { ...base.nodes, root: secondOperation.value } } as DocumentContent, secondOperation),
      overlaySequence: 2,
      previousOverlayHash: first.preview.overlayHash,
    }, validation("progressive", true));
    if (!second.ok) throw new Error("expected valid second preview");
    expect(await verifyValidatedPreviewHash(second.preview)).toBe(true);
    expect(second.preview.overlayHash).not.toBe(first.preview.overlayHash);

    const changedBase = {
      ...second.preview,
      baseRevisionId: revisionIdSchema.parse("revision-other"),
    };
    expect(await verifyValidatedPreviewHash(changedBase)).toBe(false);
  });
});

function previewInput(document: DocumentContent, operation: CanonicalEntityOperation) {
  return {
    surfaceSessionId: surfaceSessionIdSchema.parse("surface-test"),
    transactionId: transactionIdSchema.parse("transaction-preview"),
    baseRevisionId: revisionIdSchema.parse("revision-base"),
    overlaySequence: 1,
    identityMapDelta: [],
    operations: [operation],
    document,
  };
}

function rootUpdate(content: DocumentContent, gap: string) {
  return {
    op: "put-node" as const,
    nodeId: nodeIdSchema.parse("root"),
    value: {
      ...content.nodes[nodeIdSchema.parse("root")]!,
      props: { gap: { kind: "literal" as const, value: gap } },
    },
  };
}

function validation(
  policy: "progressive" | "atomic",
  ready: boolean,
): RuntimeValidationPort {
  return {
    validateNode: () => [],
    validateDocument: () => [],
    commitPolicy: () => policy,
    isNodeReady: () => ready,
  };
}
