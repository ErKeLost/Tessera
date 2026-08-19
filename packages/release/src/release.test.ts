import { describe, expect, test } from "bun:test";
import { InMemoryDurableStateStore, durableStateKey } from "@data-elements/runtime";
import {
  DurableReleaseAliasStore,
  InMemoryReleaseAliasStore,
  artifactUIReleaseDigest,
  createArtifactUIReleaseManifest,
  evaluateArtifactUIRollout,
  readPersistedArtifactPart,
  runRollbackDrill,
  runRollbackDrillAsync,
  verifyArtifactUIReleaseManifest,
  writeArtifactTurn,
  type ArtifactUIReleaseManifestInput,
} from "./index";

function release(releaseId: string): ArtifactUIReleaseManifestInput {
  const hash = "sha256:" + "a".repeat(64);
  return {
    releaseId,
    catalog: {
      catalogReleaseId: releaseId,
      catalogId: "data-elements.default",
      catalogVersion: "2.0.0",
      schemaProfile: { profileId: "data-elements.schema-core", profileVersion: 1, profileHash: hash },
      policyProfileHash: hash,
      contractFingerprint: hash,
      nodeVersions: { "content.text": 1 },
      actionContractVersions: {},
      runtimeApiRange: "^2.0.0",
      rendererApiRange: "^2.0.0",
      rendererBuildHash: hash,
      rendererConformance: "official",
    },
    packages: { "@data-elements/runtime": { version: "2.0.0", tarballIntegrity: "sha512-YWJjZA==" } },
    registryItems: {
      "artifact-ui": { immutableUrl: `https://registry.example/r/${releaseId}/artifact-ui.json`, sha256: hash },
    },
    migrationRanges: ["1.x -> 2.0"],
    conformanceReportId: `report-${releaseId}`,
    publishedAt: "2026-08-15T10:00:00.000Z",
  };
}

describe("release manifests", () => {
  test("creates, freezes, hashes, and verifies immutable manifests", () => {
    const manifest = createArtifactUIReleaseManifest(release("release-1"));
    const hash = artifactUIReleaseDigest(manifest);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(verifyArtifactUIReleaseManifest(manifest, hash).success).toBe(true);
    expect(verifyArtifactUIReleaseManifest({ ...manifest, conformanceReportId: "changed" }, hash).success).toBe(false);
  });

  test("rejects mutable latest registry URLs", () => {
    const input = release("release-1");
    input.registryItems["artifact-ui"]!.immutableUrl = "https://registry.example/r/latest/artifact-ui.json";
    expect(() => createArtifactUIReleaseManifest(input)).toThrow("immutable HTTPS");
  });
});

describe("rollout and routing", () => {
  const context = {
    tenantId: "tenant-a",
    conversationId: "conversation-a",
    providerId: "provider-a",
    catalogReleaseId: "release-2",
    clientSupportsV2: true,
    manifestCompatible: true,
  };

  test("implements ordered rollout eligibility and compatibility fail-closed", () => {
    expect(evaluateArtifactUIRollout({ releaseId: "release-2", stage: "shadow" }, context).mode).toBe("shadow-v2");
    expect(evaluateArtifactUIRollout({ releaseId: "release-2", stage: "tenant-canary", tenantCanaryIds: ["tenant-a"] }, context).mode).toBe("v2");
    expect(evaluateArtifactUIRollout({ releaseId: "release-2", stage: "opt-in" }, context).mode).toBe("v1");
    expect(evaluateArtifactUIRollout({ releaseId: "release-2", stage: "default" }, { ...context, clientSupportsV2: false }).mode).toBe("v1");
  });

  test("dual-reads but writes exactly one preselected protocol", async () => {
    const persisted: unknown[] = [];
    const part = await writeArtifactTurn(
      { releaseId: "release-2", mode: "shadow-v2", reason: "shadow" },
      async (protocol) => ({ generatedFor: protocol }),
      (value) => { persisted.push(value); },
    );
    expect(part.artifactProtocol).toBe("1.0");
    expect(persisted).toHaveLength(1);
    expect(readPersistedArtifactPart(part, {
      readV1: (value) => ({ reader: "v1", value }),
      readV2: (value) => ({ reader: "v2", value }),
    }).reader).toBe("v1");
  });

  test("rollback moves only the alias and preserves both immutable releases", () => {
    const store = new InMemoryReleaseAliasStore();
    const result = runRollbackDrill({
      store,
      previous: createArtifactUIReleaseManifest(release("release-1")),
      candidate: createArtifactUIReleaseManifest(release("release-2")),
    });
    expect(result.success).toBe(true);
    expect(store.alias("latest")).toBe("release-1");
    expect(store.resolve("release-2")?.releaseId).toBe("release-2");
  });
});

describe("durable release aliases", () => {
  test("persists immutable releases and uses versioned alias transitions to reject ABA", async () => {
    const state = new InMemoryDurableStateStore();
    const storageKey = durableStateKey("artifact-releases", "production:catalog-a");
    const first = new DurableReleaseAliasStore({
      state,
      storageKey,
      now: () => "2026-08-15T10:00:00.000Z",
      eventIdFactory: (sequence) => `event-${sequence}`,
    });
    const r1 = createArtifactUIReleaseManifest(release("release-1"));
    const r2 = createArtifactUIReleaseManifest(release("release-2"));
    await first.register(r1);
    await first.register(r2);
    const initial = await first.readAliasState("latest");
    const toR1 = {
      alias: "latest",
      expected: initial,
      nextReleaseId: "release-1",
      idempotencyKey: "move-1",
      actorId: "release-bot",
      correlationId: "deploy-1",
    };
    expect((await first.transitionAlias(toR1)).status).toBe("moved");
    const atR1 = await first.readAliasState("latest");
    const toR2 = {
      ...toR1,
      expected: atR1,
      nextReleaseId: "release-2",
      idempotencyKey: "move-2",
      correlationId: "deploy-2",
    };
    expect((await first.transitionAlias(toR2)).status).toBe("moved");
    const atR2 = await first.readAliasState("latest");
    expect((await first.transitionAlias({ ...toR1, expected: atR2, idempotencyKey: "move-3", correlationId: "rollback-1" })).status).toBe("moved");
    expect((await first.transitionAlias({ ...toR2, expected: atR1, idempotencyKey: "stale", correlationId: "stale" })).status).toBe("conflict");

    const restarted = new DurableReleaseAliasStore({ state, storageKey });
    expect((await restarted.resolve("latest"))?.releaseId).toBe("release-1");
    expect(await restarted.listAliasEvents("latest")).toHaveLength(3);
    expect((await restarted.transitionAlias(toR1)).status).toBe("moved");
  });

  test("runs the rollback drill through the asynchronous production port", async () => {
    const store = new DurableReleaseAliasStore({ state: new InMemoryDurableStateStore() });
    const result = await runRollbackDrillAsync({
      store,
      previous: createArtifactUIReleaseManifest(release("release-1")),
      candidate: createArtifactUIReleaseManifest(release("release-2")),
    });
    expect(result.success).toBe(true);
    expect(await store.alias("latest")).toBe("release-1");
  });

  test("fails closed when durable manifest bytes no longer match their digest", async () => {
    const storageKey = durableStateKey("artifact-releases", "tampered");
    const manifest = createArtifactUIReleaseManifest(release("release-1"));
    const state = new InMemoryDurableStateStore({
      initial: {
        [storageKey]: {
          formatVersion: 1,
          releases: {
            "release-1": { manifest, digest: `sha256:${"b".repeat(64)}` },
          },
          aliases: { latest: { releaseId: "release-1", version: 1 } },
          events: [],
          idempotency: {},
          nextEventSequence: 1,
        },
      },
    });
    const store = new DurableReleaseAliasStore({ state, storageKey });
    await expect(store.resolve("latest")).rejects.toThrow("failed verification");
    await expect(store.compareAndSwapAlias("latest", "release-1", "release-1")).rejects.toThrow("failed verification");
  });
});
