import { describe, expect, test } from "bun:test";
import { createRendererCapabilityManifest } from "@open-generative/catalog";
import { sha256HashSchema } from "@open-generative/protocol";
import { createOfficialCatalog } from "./contracts";
import {
  createOfficialRendererCapabilityManifest,
  createOfficialRendererRelease,
  createSingleChunkOfficialRendererArtifactSet,
  officialRendererBuildProfile,
  officialRendererFeatures,
  verifyOfficialRendererArtifacts,
  verifyOfficialRendererCapabilityManifest,
  verifyOfficialRendererRelease,
} from "./renderer-integrity";

const hash = (character: string) => sha256HashSchema.parse(`sha256:${character.repeat(64)}`);

describe("official renderer integrity", () => {
  test("binds every official contract to one verified implementation, chunk, and asset set", async () => {
    const catalog = await createOfficialCatalog();
    const artifacts = createSingleChunkOfficialRendererArtifactSet({
      chunkHash: hash("a"),
      stylesheetHash: hash("b"),
    });
    const manifest = await createOfficialRendererCapabilityManifest(catalog, artifacts);

    expect(manifest.rendererId).toBe(officialRendererBuildProfile.rendererId);
    expect(manifest.contracts).toHaveLength(12);
    expect(new Set(manifest.contracts.map((capability) => capability.chunkHash))).toEqual(new Set([hash("a")]));
    expect(new Set(manifest.contracts.flatMap((capability) => capability.assetHashes))).toEqual(new Set([hash("b")]));
    for (const capability of manifest.contracts) {
      expect([...capability.features]).toEqual([
        ...officialRendererFeatures[capability.contract.componentType as keyof typeof officialRendererFeatures],
      ]);
    }
    await expect(verifyOfficialRendererCapabilityManifest(manifest, catalog)).resolves.toEqual(manifest);
    await expect(verifyOfficialRendererArtifacts(manifest, catalog, artifacts)).resolves.toEqual(manifest);
    const release = await createOfficialRendererRelease(catalog, artifacts);
    await expect(verifyOfficialRendererRelease(release, catalog)).resolves.toEqual(release);
    expect(Object.isFrozen(release)).toBe(true);
    expect(Object.isFrozen(release.artifacts)).toBe(true);
  });

  test("rejects both byte tampering and a self-consistent non-official feature claim", async () => {
    const catalog = await createOfficialCatalog();
    const artifacts = createSingleChunkOfficialRendererArtifactSet({ chunkHash: hash("c"), stylesheetHash: hash("d") });
    const manifest = await createOfficialRendererCapabilityManifest(catalog, artifacts);
    const changedArtifacts = createSingleChunkOfficialRendererArtifactSet({ chunkHash: hash("e"), stylesheetHash: hash("d") });
    await expect(verifyOfficialRendererArtifacts(manifest, catalog, changedArtifacts)).rejects.toThrow("release artifacts");
    await expect(verifyOfficialRendererRelease({ manifest, artifacts: changedArtifacts }, catalog)).rejects.toThrow("release artifacts");

    const [first, ...rest] = manifest.contracts;
    const altered = await createRendererCapabilityManifest({
      rendererId: manifest.rendererId,
      rendererRevision: manifest.rendererRevision,
      implementationHash: manifest.implementationHash,
      conformanceRevision: manifest.conformanceRevision,
      contracts: [
        { ...first!, features: first!.features.slice(1) },
        ...rest,
      ],
    });
    await expect(verifyOfficialRendererCapabilityManifest(altered, catalog)).rejects.toThrow("feature binding mismatch");
  });
});
