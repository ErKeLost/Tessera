import { describe, expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRenderArtifactTool } from "../packages/ai-sdk/src/index";
import { artifactContracts, defaultArtifactCatalog } from "../packages/core/src/index";
import { defaultRendererRegistry } from "../packages/react/src/index";
import { artifactActionContracts, artifactKinds, artifactSchemas } from "../packages/schema/src/index";

const root = join(import.meta.dir, "..");
const expectedKinds = [...artifactKinds];

function sorted(values: Iterable<string>) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe("artifact contract parity", () => {
  test("keeps schema, contracts, catalog, and official renderers at 100% parity", () => {
    expect(sorted(Object.keys(artifactSchemas))).toEqual(sorted(expectedKinds));
    expect(sorted(artifactContracts.map((contract) => contract.kind))).toEqual(sorted(expectedKinds));
    expect(sorted(defaultArtifactCatalog.entries().map((contract) => contract.kind))).toEqual(sorted(expectedKinds));
    expect(sorted(Object.keys(defaultRendererRegistry))).toEqual(sorted(expectedKinds));
    expect(new Set(artifactContracts.map((contract) => contract.kind)).size).toBe(expectedKinds.length);
  });

  test("keeps every built-in action attached to exactly one contract", () => {
    const contractActions = artifactContracts.flatMap((contract) => (
      Object.keys(contract.eventPorts).map((action) => `${contract.kind}:${action}`)
    ));
    const schemaActions = Object.entries(artifactActionContracts).map(([action, contract]) => (
      `${contract.artifactKind}:${action}`
    ));
    expect(sorted(contractActions)).toEqual(sorted(schemaActions));
  });

  test("generates every AI provider branch from the active catalog", () => {
    const tool = createRenderArtifactTool();
    const schema = (tool.inputSchema as unknown as { jsonSchema: { oneOf?: unknown[] } }).jsonSchema;
    expect(schema.oneOf).toHaveLength(expectedKinds.length);
    const encoded = JSON.stringify(schema);
    for (const kind of expectedKinds) expect(encoded).toContain(`"const":"${kind}"`);
  });

  test("keeps registry entries and component docs aligned with contracts", async () => {
    const registry = JSON.parse(await readFile(join(root, "registry.json"), "utf8")) as { items: { name: string }[] };
    const registryNames = new Set(registry.items.map((item) => item.name));
    for (const contract of artifactContracts) {
      expect(registryNames.has(contract.distribution.registryName), contract.kind).toBe(true);
      await access(join(root, "apps", "docs", "content", "docs", "components", `${contract.distribution.registryName}.mdx`));
    }
  });
});
