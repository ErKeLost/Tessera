import { describe, expect, test } from "bun:test";
import { canonicalHash } from "./canonical";
import { ARTIFACT_PROTOCOL, ARTIFACT_PROTOCOL_VERSION } from "./constants";
import { projectArtifactSemanticContent, validateArtifactDocument } from "./document";
import {
  JsonSchemaContractError,
  parseJsonWithSchema,
  prepareJsonSchema,
} from "./json-schema";
import {
  canExecuteActionLocally,
  createImplicitRuntimeSnapshot,
  executeLocalArtifactAction,
  resolveRuntimeStateValues,
} from "./local-action";
import type { ArtifactDocument, JsonObject } from "./schemas";
import { validateRuntimeSnapshot } from "./snapshot";

const NOW = "2026-08-15T00:00:00.000Z";
const FINGERPRINT = "runtime-local-action-fingerprint";

describe("runtime JSON Schema profile", () => {
  test("verifies schema identity and validates JSON values", async () => {
    const schema: JsonObject = { type: "string", maxLength: 5 };
    const prepared = await prepareJsonSchema(schema, await canonicalHash(schema));
    expect(parseJsonWithSchema(prepared.validator, "short")).toBe("short");
    expect(() => parseJsonWithSchema(prepared.validator, "too long")).toThrow(JsonSchemaContractError);
    await expect(prepareJsonSchema(schema, "wrong-hash")).rejects.toMatchObject({ code: "schema.hash-mismatch" });
  });

  test("rejects unbounded schemas before compilation", async () => {
    const schema: JsonObject = { type: "string" };
    await expect(prepareJsonSchema(schema, await canonicalHash(schema))).rejects.toMatchObject({ code: "schema.unbounded" });
  });
});

describe("local Artifact actions", () => {
  test("rejects inconsistent state definitions and snapshot records at the trust boundary", async () => {
    const document = await createFormDocument();
    const snapshot = createImplicitRuntimeSnapshot(document);
    const definition = document.state.name!;
    snapshot.state = [{
      documentId: document.documentId,
      branchId: document.revision.branchId,
      stateId: "name",
      stateRevision: "state-invalid",
      schemaId: definition.schemaId,
      schemaVersion: definition.schemaVersion,
      schemaHash: definition.schemaHash,
      policyHash: definition.policy.policyHash,
      value: 42,
    }];
    const invalidSnapshot = await validateRuntimeSnapshot(snapshot, { expectedContractFingerprint: FINGERPRINT });
    expect(invalidSnapshot).toMatchObject({ success: false });
    if (!invalidSnapshot.success) {
      expect(invalidSnapshot.diagnostics.some(({ code }) => code === "schema.value-invalid")).toBe(true);
    }

    document.state.name!.schemaHash = "wrong-hash";
    document.revision.contentHash = await canonicalHash(projectArtifactSemanticContent(document));
    const invalidDocument = await validateArtifactDocument(document, { expectedContractFingerprint: FINGERPRINT });
    expect(invalidDocument).toMatchObject({ success: false });
    if (!invalidDocument.success) {
      expect(invalidDocument.diagnostics.some(({ code }) => code === "schema.hash-mismatch")).toBe(true);
    }
  });

  test("atomically resolves event values, validates state, and returns focus work", async () => {
    const document = await createFormDocument();
    const initial = createImplicitRuntimeSnapshot(document);
    let sequence = 0;
    const result = await executeLocalArtifactAction({
      snapshot: initial,
      nodeId: "name-input",
      port: "change",
      payload: { value: "Ada" },
      options: {
        now: () => NOW,
        idFactory: (kind) => `local-${kind}-${++sequence}`,
        requestId: "request-local",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveRuntimeStateValues(document, result.snapshot)).toMatchObject({ name: "Ada" });
    expect(result.focusNodeIds).toEqual(["name-input"]);
    expect(result.snapshot.stateTransitionReceipts).toHaveLength(1);
    expect(initial.state).toHaveLength(0);

    const reset = await executeLocalArtifactAction({
      snapshot: result.snapshot,
      nodeId: "name-input",
      port: "reset",
      payload: {},
      options: {
        now: () => NOW,
        idFactory: (kind) => `local-reset-${kind}-${++sequence}`,
        requestId: "request-reset",
      },
    });
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(resolveRuntimeStateValues(document, reset.snapshot)).toMatchObject({ name: "" });
  });

  test("rejects invalid state without publishing a partial write", async () => {
    const document = await createFormDocument();
    const initial = createImplicitRuntimeSnapshot(document);
    const result = await executeLocalArtifactAction({
      snapshot: initial,
      nodeId: "name-input",
      port: "change",
      payload: { value: "This value is too long" },
    });
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "runtime.state-write-invalid" } });
    expect(initial.state).toHaveLength(0);
  });

  test("keeps mixed and host-persisted plans on the authorized transport path", async () => {
    const document = await createFormDocument();
    expect(canExecuteActionLocally(document, document.actions["set-name"]!)).toBe(true);
    expect(canExecuteActionLocally(document, {
      contractId: "mixed",
      contractVersion: 1,
      onError: "halt",
      steps: [
        { stepId: "local", type: "state.set", stateId: "name", value: { kind: "literal", value: "Ada" } },
        { stepId: "external", type: "capability.request", capabilityId: "crm.write", input: {} },
      ],
    })).toBe(false);
    document.state.name!.policy.persistence = "host";
    expect(canExecuteActionLocally(document, document.actions["set-name"]!)).toBe(false);
  });
});

async function createFormDocument(): Promise<ArtifactDocument> {
  const schema: JsonObject = { type: "string", maxLength: 12 };
  const document: ArtifactDocument = {
    protocol: ARTIFACT_PROTOCOL,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    documentId: "local-form-document",
    revision: {
      revisionId: "local-form-revision",
      parentRevisionIds: [],
      branchId: "main",
      sequence: 1,
      contentHash: "pending",
      contractFingerprint: FINGERPRINT,
      migrationReceiptIds: [],
      stateTransitionReceiptIds: [],
    },
    policy: {
      policyId: "document-policy",
      policyVersion: 1,
      policyHash: "document-policy-hash",
      scopeRef: "scope:test",
      sensitivity: "private",
      persistence: "session",
      allowedSinks: ["renderer"],
    },
    catalog: { id: "catalog", version: "1", contractFingerprint: FINGERPRINT },
    renderMode: "progressive",
    root: "name-input",
    nodes: {
      "name-input": {
        type: "form.input",
        typeVersion: 1,
        props: {
          label: { kind: "literal", value: "Name" },
          value: { kind: "state-ref", stateId: "name" },
        },
        events: { change: "set-name", reset: "reset-name" },
      },
    },
    state: {
      name: {
        schemaId: "schema:name",
        schema,
        schemaVersion: 1,
        schemaHash: await canonicalHash(schema),
        initial: "",
        policy: {
          policyId: "state-policy",
          policyVersion: 1,
          policyHash: "state-policy-hash",
          scope: "document",
          persistence: "session",
          sensitivity: "private",
          modelAccess: "none",
          lifecycle: "retain",
        },
      },
    },
    actions: {
      "set-name": {
        contractId: "form.change",
        contractVersion: 1,
        onError: "halt",
        steps: [
          {
            stepId: "write-name",
            type: "state.set",
            stateId: "name",
            value: { kind: "event-ref", port: "change", path: ["value"] },
          },
          { stepId: "focus-name", type: "node.focus", nodeId: "name-input" },
        ],
      },
      "reset-name": {
        contractId: "form.reset",
        contractVersion: 1,
        onError: "halt",
        steps: [{ stepId: "reset-name", type: "state.reset", stateIds: ["name"] }],
      },
    },
    resources: {},
    evidence: {},
    claims: {},
    meta: { title: "Local form", createdAt: NOW, updatedAt: NOW },
  };
  document.revision.contentHash = await canonicalHash(projectArtifactSemanticContent(document));
  return document;
}
