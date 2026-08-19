import { describe, expect, test } from "bun:test";
import {
  MigrationRegistry,
  migrateV1Artifact,
  negotiateBootstrap,
  versionSatisfies,
  type BootstrapHello,
  type CatalogCompatibilityManifest,
} from "./index";
import { DEFAULT_PROTOCOL_LIMITS } from "./constants";
import { TEST_FINGERPRINT, TEST_TIME, testPolicy } from "./test-fixtures";

describe("versioned migration", () => {
  test("projects an exact v1 artifact into an immutable v2 revision with a receipt", async () => {
    const result = await migrateV1Artifact({
      protocolVersion: "1.0",
      kind: "metric",
      id: "metric-1",
      title: "Revenue",
      description: "Monthly revenue",
      metrics: [{ id: "mrr", label: "MRR", value: 42_000 }],
    }, {
      branchId: "main",
      revisionId: "revision:migrated",
      receiptId: "receipt:migration",
      policy: testPolicy,
      catalog: { id: "catalog:test", version: "1", contractFingerprint: TEST_FINGERPRINT },
      appliedAt: TEST_TIME,
    });
    expect(result.document.protocolVersion).toBe("2.0");
    expect(result.document.nodes["metric-1"]?.type).toBe("artifact.metric");
    expect(result.document.nodes["metric-1"]?.props.metrics?.kind).toBe("array");
    expect(Object.keys(result.document.nodes["metric-1"]?.props ?? {}).sort()).toEqual(["metrics"]);
    expect(result.document.meta).toMatchObject({ title: "Revenue", description: "Monthly revenue" });
    expect(result.receipt.source.version).toBe("1.0");
    expect(result.receipt.target.contentHash).toBe(result.document.revision.contentHash);
    expect(result.receipt.warnings[0]).toContain("no formal evidence provenance");
  });

  test("rejects ambiguous migration chains", () => {
    const registry = new MigrationRegistry<number>()
      .register({ id: "a-b", entity: "node", fromVersion: "1", toVersion: "2", transform: (value) => value + 1 })
      .register({ id: "b-c", entity: "node", fromVersion: "2", toVersion: "3", transform: (value) => value + 1 })
      .register({ id: "a-x", entity: "node", fromVersion: "1", toVersion: "2.5", transform: (value) => value + 1 })
      .register({ id: "x-c", entity: "node", fromVersion: "2.5", toVersion: "3", transform: (value) => value + 1 });
    expect(() => registry.plan("node", "1", "3")).toThrow("Ambiguous migration paths");
  });
});

describe("bootstrap compatibility", () => {
  test("selects a catalog manifest atomically and intersects limits", () => {
    const manifest: CatalogCompatibilityManifest = {
      catalogReleaseId: "release-1",
      catalogId: "catalog:test",
      catalogVersion: "1.0.0",
      schemaProfile: { profileId: "data-elements.schema-core", profileVersion: 1, profileHash: "schema-hash" },
      policyProfileHash: "policy-hash",
      contractFingerprint: TEST_FINGERPRINT,
      nodeVersions: { "layout.stack": 1 },
      actionContractVersions: {},
      runtimeApiRange: "^1.0.0",
      rendererApiRange: "^1.0.0",
      rendererBuildHash: "renderer-hash",
      rendererConformance: "official",
    };
    const hello: BootstrapHello = {
      bootstrapProtocol: "data-elements.bootstrap/1",
      type: "hello",
      requestId: "hello-1",
      offer: {
        documentProtocolRanges: ["^2.0.0"],
        streamProtocolRanges: ["^2.0.0"],
        codecs: [{ id: "json", versions: ["1.0"] }],
        runtimeApiRanges: ["^1.0.0"],
        rendererApiRanges: ["^1.0.0"],
        requiredFeatures: ["transactions"],
        optionalFeatures: ["preview"],
        catalogManifests: [manifest],
        limits: { ...DEFAULT_PROTOCOL_LIMITS, maxNodes: 100 },
      },
    };
    const response = negotiateBootstrap(hello, {
      documentProtocolVersions: ["2.0"],
      streamProtocolVersions: ["2.0"],
      codecs: [{ id: "json", versions: ["1.0"] }],
      runtimeApiVersions: ["1.2.0"],
      rendererApiVersions: ["1.1.0"],
      features: ["transactions", "preview"],
      catalogManifests: [manifest],
      limitCeilings: DEFAULT_PROTOCOL_LIMITS,
    }, { streamId: "stream-ready" });
    expect(response.type).toBe("ready");
    if (response.type === "ready") {
      expect(response.selection.catalogManifest).toEqual(manifest);
      expect(response.selection.limits.maxNodes).toBe(100);
      expect(response.selection.enabledFeatures).toEqual(["transactions", "preview"]);
    }
  });

  test("supports the bounded semver range forms used by manifests", () => {
    expect(versionSatisfies("2.0", "^2.0.0")).toBe(true);
    expect(versionSatisfies("1.4.2", ">=1.2.0 <2.0.0")).toBe(true);
    expect(versionSatisfies("2.0.0", "1.x")).toBe(false);
  });
});
