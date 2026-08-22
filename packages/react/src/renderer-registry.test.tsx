import { describe, expect, test } from "bun:test";
import { createRendererCapabilityManifest } from "@open-generative/catalog";
import type { NodeRenderer } from "./types";
import {
  RendererRegistry,
  createVerifiedRendererRegistry,
} from "./renderer-registry";
import {
  OTHER_CONTRACT_REF,
  OTHER_HASH,
  PANEL_PLACEMENT,
  TEST_CONTRACT,
  TEST_HASH,
  createRegistry,
  panelPlacement,
} from "./test-fixtures";

const Renderer: NodeRenderer = () => <div />;

describe("RendererRegistry", () => {
  test("indexes only the exact full ContractRef", () => {
    const registry = createRegistry(Renderer);

    expect(registry.get(TEST_CONTRACT.ref)?.renderer).toBe(Renderer);
    expect(registry.get(OTHER_CONTRACT_REF)).toBeUndefined();
    expect(registry.size).toBe(1);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.entries())).toBe(true);
    expect(Object.isFrozen(registry.entries()[0])).toBe(true);
  });

  test("rejects duplicate exact registrations", () => {
    expect(() => new RendererRegistry([
      {
        contract: TEST_CONTRACT.ref,
        placements: TEST_CONTRACT.placements,
        renderer: Renderer,
      },
      {
        contract: TEST_CONTRACT.ref,
        placements: TEST_CONTRACT.placements,
        renderer: Renderer,
      },
    ])).toThrow("registered more than once");
  });

  test("requires both Contract and renderer placement constraints", () => {
    const registry = createRegistry(Renderer, [{
      kind: "panel",
      minWidth: 400,
      maxWidth: 800,
      minHeight: 200,
      maxHeight: 700,
    }]);

    expect(registry.resolve(TEST_CONTRACT, panelPlacement(400)).status).toBe("ready");
    expect(registry.resolve(TEST_CONTRACT, panelPlacement(800, 700)).status).toBe("ready");
    expect(registry.resolve(TEST_CONTRACT, panelPlacement(399))).toEqual({
      status: "unsupported",
      reason: "placement-unsupported",
    });
    expect(registry.resolve(TEST_CONTRACT, panelPlacement(801))).toEqual({
      status: "unsupported",
      reason: "placement-unsupported",
    });
    expect(registry.resolve(TEST_CONTRACT, {
      ...PANEL_PLACEMENT,
      kind: "inline",
    })).toEqual({
      status: "unsupported",
      reason: "placement-unsupported",
    });
  });

  test("rejects invalid registrations and placement inputs", () => {
    expect(() => createRegistry(Renderer, [])).toThrow("at least one placement");
    const registry = createRegistry(Renderer);
    expect(() => registry.resolve(TEST_CONTRACT, {
      ...PANEL_PLACEMENT,
      width: -1,
    })).toThrow();
  });

  test("binds verified manifest integrity to the exact registration", async () => {
    const manifest = await createTestManifest();
    const registry = await createVerifiedRendererRegistry([{
      contract: TEST_CONTRACT.ref,
      placements: TEST_CONTRACT.placements,
      renderer: Renderer,
    }], manifest);

    const integrity = registry.get(TEST_CONTRACT.ref)?.integrity;
    expect(integrity).toEqual({
      rendererCapabilityManifestHash: manifest.manifestHash,
      implementationHash: TEST_HASH,
      chunkHash: OTHER_HASH,
      assetHashes: [TEST_HASH],
    });
    expect(Object.isFrozen(integrity)).toBe(true);
    expect(Object.isFrozen(integrity?.assetHashes)).toBe(true);
  });

  test("rejects incomplete, placement-drifted, and tampered verified registries", async () => {
    const manifest = await createTestManifest();
    await expect(createVerifiedRendererRegistry([], manifest)).rejects.toThrow("exactly cover");
    await expect(createVerifiedRendererRegistry([{
      contract: TEST_CONTRACT.ref,
      placements: [{ ...TEST_CONTRACT.placements[0]!, minWidth: 301 }],
      renderer: Renderer,
    }], manifest)).rejects.toThrow("placement binding");
    await expect(createVerifiedRendererRegistry([{
      contract: TEST_CONTRACT.ref,
      placements: TEST_CONTRACT.placements,
      renderer: Renderer,
    }], { ...manifest, manifestHash: OTHER_HASH })).rejects.toThrow("integrity check failed");
  });
});

async function createTestManifest() {
  return createRendererCapabilityManifest({
    rendererId: "open-generative.react-test",
    rendererRevision: "1",
    implementationHash: TEST_HASH,
    conformanceRevision: "1",
    contracts: [{
      contract: TEST_CONTRACT.ref,
      placements: TEST_CONTRACT.placements,
      features: ["test.feature"],
      chunkHash: OTHER_HASH,
      assetHashes: [TEST_HASH],
    }],
  });
}
