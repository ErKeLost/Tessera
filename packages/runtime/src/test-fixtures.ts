import { canonicalHash } from "./canonical";
import { ARTIFACT_PROTOCOL_VERSION } from "./constants";
import type {
  DocumentPolicy,
  DraftOperation,
  ProposalContext,
  RuntimeSnapshot,
} from "./schemas";
import { InMemoryArtifactRuntimeStore } from "./store";
import { ArtifactTransactionRuntime } from "./transaction";

export const TEST_TIME = "2026-08-15T00:00:00.000Z";
export const TEST_FINGERPRINT = "contract-fingerprint-v1";

export const testPolicy: DocumentPolicy = {
  scopeRef: "scope:test",
  sensitivity: "private",
  persistence: "session",
  allowedSinks: ["renderer"],
  policyId: "policy:test",
  policyVersion: 1,
  policyHash: "policy-hash-v1",
};

export function createContext(
  target: ProposalContext["target"] = {
    mode: "create",
    documentId: "document-1",
    branchId: "main",
    parentRevisionIds: [],
  },
  renderMode: ProposalContext["renderMode"] = "progressive",
): ProposalContext {
  return {
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    contractFingerprint: TEST_FINGERPRINT,
    promptBundleHash: "prompt-hash-v1",
    schemaProfile: {
      profileId: "data-elements.schema-core",
      profileVersion: 1,
      profileHash: "schema-profile-hash-v1",
    },
    documentPolicy: testPolicy,
    generationTaintHash: "generation-taint-v1",
    renderMode,
    actionContractVersions: {},
    resourceGrants: {},
    evidenceGrants: {},
    capabilityGrantVersions: {},
    messageTemplateGrantVersions: {},
    grantSetVersion: 1,
    authorizationContextRef: "authorization:test",
    policyProfileHash: "policy-profile-hash-v1",
    target,
  };
}

export function rootNodeOperation(title = "Revenue"): DraftOperation {
  return {
    op: "put-node",
    nodeId: "root",
    value: {
      type: "layout.stack",
      typeVersion: 1,
      props: { title: { kind: "literal", value: title } },
    },
  };
}

export async function createCommittedFixture(options: {
  store?: InMemoryArtifactRuntimeStore;
  transactionId?: string;
  withState?: boolean;
} = {}): Promise<{
  store: InMemoryArtifactRuntimeStore;
  runtime: ArtifactTransactionRuntime;
  snapshot: RuntimeSnapshot;
}> {
  const store = options.store ?? new InMemoryArtifactRuntimeStore({ now: () => TEST_TIME });
  const runtime = new ArtifactTransactionRuntime({
    store,
    streamId: "stream-1",
    catalog: {
      id: "catalog:test",
      version: "1.0.0",
      contractFingerprint: TEST_FINGERPRINT,
      nodeVersions: { "layout.stack": 1 },
    },
    now: () => TEST_TIME,
    nodeCommitPolicy: () => "progressive",
  });
  await runtime.initialize();
  const transactionId = options.transactionId ?? "tx-create";
  const begin = await runtime.begin(transactionId, createContext());
  if (begin.status === "rejected") throw new Error(begin.diagnostics[0]?.message);
  const operations: DraftOperation[] = [rootNodeOperation()];
  if (options.withState) {
    const stateSchema = { type: "string", maxLength: 100 };
    operations.push({
      op: "put-state",
      stateId: "filter",
      value: {
        schemaId: "schema:filter",
        schema: stateSchema,
        schemaVersion: 1,
        schemaHash: await canonicalHash(stateSchema),
        initial: "all",
        policy: {
          policyId: "state-policy:filter",
          policyVersion: 1,
          policyHash: "state-policy-filter-hash-v1",
          scope: "document",
          persistence: "session",
          sensitivity: "private",
          modelAccess: "none",
          lifecycle: "retain",
        },
      },
    });
  }
  operations.push({ op: "set-root", nodeId: "root" });
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    const result = await runtime.apply({
      type: "apply",
      transactionId,
      seq: index + 1,
      opId: `op:${transactionId}:${index + 1}`,
      payloadHash: await canonicalHash(operation),
      operation,
    });
    if (result.status === "aborted" || result.status === "rejected" || result.status === "too-late") {
      throw new Error(result.diagnostics[0]?.message);
    }
  }
  const hash = await runtime.computeDraftHash(transactionId);
  const result = await runtime.finalize(transactionId, hash);
  if (result.status !== "committed" && result.status !== "replayed") {
    throw new Error("diagnostics" in result ? result.diagnostics[0]?.message : "Fixture commit failed.");
  }
  return { store, runtime, snapshot: result.snapshot };
}
