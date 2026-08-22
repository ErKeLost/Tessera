import { describe, expect, test } from "bun:test";
import { contractRefKey } from "@open-generative/catalog";
import {
  createOfficialCatalog,
  createOfficialRendererRelease,
  createSingleChunkOfficialRendererArtifactSet,
  officialComponentTypes,
} from "@open-generative/components";
import { sha256HashSchema } from "@open-generative/protocol";
import {
  createOfficialRendererRegistrations,
  createOfficialRendererRegistry,
  createVerifiedOfficialRendererRegistry,
  officialRendererComponents,
  officialRendererEventPorts,
} from "./registry";

describe("official renderer registry", () => {
  test("registers exactly the data.chart contract", async () => {
    const catalog = await createOfficialCatalog();
    const registrations = createOfficialRendererRegistrations(catalog);
    const registry = await createOfficialRendererRegistry(catalog);
    const expectedRefs = catalog.componentContracts.map((contract) => contractRefKey(contract.ref)).sort();
    const actualRefs = registrations.map((registration) => contractRefKey(registration.contract)).sort();

    expect(Object.keys(officialRendererComponents).sort()).toEqual([...officialComponentTypes].sort());
    expect(registrations).toHaveLength(1);
    expect(registry.size).toBe(1);
    expect(actualRefs).toEqual(expectedRefs);
    expect(registry.entries().map((registration) => contractRefKey(registration.contract)).sort()).toEqual(expectedRefs);
  });

  test("uses each exact contract placement set and no compatibility fallback", async () => {
    const catalog = await createOfficialCatalog();
    const registrations = createOfficialRendererRegistrations(catalog);

    for (const registration of registrations) {
      const contract = catalog.componentContracts.find((candidate) => contractRefKey(candidate.ref) === contractRefKey(registration.contract));
      expect(contract).toBeDefined();
      expect(registration.placements).toEqual(contract!.placements);
      expect(registration.renderer).toBe(officialRendererComponents[registration.contract.componentType as keyof typeof officialRendererComponents]);
    }
  });

  test("declares exactly the event ports exposed by official contracts", async () => {
    const catalog = await createOfficialCatalog();
    const contractPorts = [...new Set(catalog.componentContracts.flatMap((contract) => Object.keys(contract.events)))].sort();
    expect(Object.values(officialRendererEventPorts).map(String).sort()).toEqual(contractPorts);
  });

  test("binds verified registrations to the official release manifest hashes", async () => {
    const catalog = await createOfficialCatalog();
    const artifacts = createSingleChunkOfficialRendererArtifactSet({
      chunkHash: sha256HashSchema.parse(`sha256:${"a".repeat(64)}`),
      stylesheetHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
    });
    const release = await createOfficialRendererRelease(catalog, artifacts);
    const { manifest } = release;
    const registry = await createVerifiedOfficialRendererRegistry(release, catalog);

    expect(registry.size).toBe(1);
    for (const registration of registry.entries()) {
      const capability = manifest.contracts.find((candidate) => contractRefKey(candidate.contract) === contractRefKey(registration.contract));
      expect(registration.integrity).toEqual({
        rendererCapabilityManifestHash: manifest.manifestHash,
        implementationHash: manifest.implementationHash,
        chunkHash: capability!.chunkHash,
        assetHashes: capability!.assetHashes,
      });
      expect(Object.isFrozen(registration.integrity)).toBe(true);
      expect(Object.isFrozen(registration.integrity!.assetHashes)).toBe(true);
    }

    const changedArtifacts = createSingleChunkOfficialRendererArtifactSet({
      chunkHash: sha256HashSchema.parse(`sha256:${"c".repeat(64)}`),
      stylesheetHash: sha256HashSchema.parse(`sha256:${"b".repeat(64)}`),
    });
    await expect(createVerifiedOfficialRendererRegistry({
      manifest,
      artifacts: changedArtifacts,
    }, catalog)).rejects.toThrow("release artifacts");
  });
});
