import { describe, expect, test } from "bun:test";
import {
  canonicalHash,
  isArtifactPart as isRuntimeArtifactPart,
  type StateDefinition,
} from "@open-tessera/runtime";
import { materializeArtifactPart } from "./commit";
import {
  createDocumentPolicy,
  DEFAULT_DOCUMENT_POLICY,
  type DocumentPolicyInput,
} from "./information-flow";
import { prepareTurn } from "./turn";

function ids() {
  let next = 0;
  return (kind: string, hint = "artifact") => `${kind}:${hint}:${next += 1}`;
}

async function prepare(
  proposal: unknown,
  options: { resourceIds?: readonly string[]; documentPolicy?: typeof DEFAULT_DOCUMENT_POLICY } = {},
) {
  const turn = await prepareTurn({
    messages: [{ role: "user", content: "Show a short summary." }],
    requestedNodeTypes: ["content.text"],
    resourceIds: options.resourceIds,
    documentPolicy: options.documentPolicy,
  });
  const part = await turn.accept(proposal, {
    id: "compiler.commit-test",
    extractProposal: (value) => value,
  });
  return { part, turn };
}

describe("runtime artifact materialization", () => {
  test("turns only a matching compiler part into a branded runtime snapshot", async () => {
    const { part, turn } = await prepare({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
    });
    const runtimePart = await materializeArtifactPart(part, {
      bundle: turn.bundle,
      documentPolicy: DEFAULT_DOCUMENT_POLICY,
      idFactory: ids(),
      now: () => "2026-08-15T00:00:00.000Z",
    });

    expect(isRuntimeArtifactPart(runtimePart)).toBe(true);
    expect(runtimePart.kind).toBe("artifact-snapshot");
    if (runtimePart.kind !== "artifact-snapshot") throw new Error("Expected a snapshot.");
    expect(runtimePart.snapshot.document.root).toBe("summary");
    expect(runtimePart.snapshot.document.revision.contentHash).not.toBe("pending");
  });

  test("rejects a compiler part from a different prompt bundle", async () => {
    const { part, turn } = await prepare({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
    });
    await expect(materializeArtifactPart(part, {
      bundle: { ...turn.bundle, promptBundleHash: "wrong-bundle" },
      documentPolicy: DEFAULT_DOCUMENT_POLICY,
      idFactory: ids(),
    })).rejects.toThrow("does not match");
  });

  test("validates state initial values against their declared JSON Schema", async () => {
    const { part, turn } = await prepare({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
      state: { count: { schema: { type: "number" }, initial: "not-a-number" } },
    });
    await expect(materializeArtifactPart(part, {
      bundle: turn.bundle,
      documentPolicy: DEFAULT_DOCUMENT_POLICY,
      idFactory: ids(),
    })).rejects.toThrow();
  });

  test("binds expiry into document and state policy hashes", async () => {
    const base: DocumentPolicyInput = {
      policyId: "tenant-policy",
      scopeRef: "tenant:acme",
      sensitivity: "private",
      persistence: "session",
      allowedSinks: ["model-generation", "renderer", "model-repair"],
    };
    const first = createDocumentPolicy({ ...base, expiresAt: "2099-01-01T00:00:00.000Z" });
    const second = createDocumentPolicy({ ...base, expiresAt: "2099-02-01T00:00:00.000Z" });
    expect(first.policyHash).not.toBe(second.policyHash);

    const { part, turn } = await prepare({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
      state: { count: { schema: { type: "number" }, initial: 1 } },
    }, { documentPolicy: first });
    const schema = { type: "number" } as const;
    const schemaHash = await canonicalHash(schema);
    const statePolicy = {
      policyId: "state.count",
      policyVersion: 1,
      scope: "document" as const,
      persistence: "session" as const,
      sensitivity: "private" as const,
      modelAccess: "none" as const,
      lifecycle: "retain" as const,
      expiresAt: "2099-03-01T00:00:00.000Z",
    };
    const policyHash = await canonicalHash(statePolicy);

    const commit = materializeArtifactPart(part, {
      bundle: turn.bundle,
      documentPolicy: first,
      now: () => "2090-01-01T00:00:00.000Z",
      idFactory: ids(),
      stateDefinition: (): StateDefinition => ({
        schemaId: "state.count",
        schema,
        schemaVersion: 1,
        schemaHash,
        initial: 1,
        policy: { ...statePolicy, policyHash },
      }),
    });
    await expect(commit).rejects.toMatchObject({
      code: "commit.state-expiry-broadened",
    });
  });

  test("rejects host resources outside the document information-flow boundary", async () => {
    const documentPolicy = createDocumentPolicy({
      policyId: "tenant-private",
      scopeRef: "tenant:acme",
      sensitivity: "private",
      persistence: "session",
      allowedSinks: ["model-generation", "renderer", "model-repair"],
    });
    const { part, turn } = await prepare({
      root: { id: "summary", type: "content.text", props: { text: "Ready" } },
      resourceIds: ["revenue"],
    }, { resourceIds: ["revenue"], documentPolicy });

    const commit = materializeArtifactPart(part, {
      bundle: turn.bundle,
      documentPolicy,
      idFactory: ids(),
      resources: {
        revenue: {
          resourceId: "revenue",
          schemaId: "table",
          schemaVersion: 1,
          schemaHash: "schema-hash",
          codec: { id: "json", version: "1" },
          mediaType: "application/json",
          contentHash: "content-hash",
          scopeRef: "tenant:acme",
          sensitivity: "public",
        },
      },
    });
    await expect(commit).rejects.toMatchObject({
      code: "commit.resource-sensitivity-lowered",
    });
  });
});
