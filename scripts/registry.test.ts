import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { registryItemSchema, registrySchema } from "shadcn/schema";
import { sha256 } from "../packages/core/src/index";
import { assertBrowserSafeImports, collectSourceClosure } from "./prepare-registry";

const root = join(import.meta.dir, "..");
const outputDirectory = join(root, "apps", "docs", ".registry");

async function readJson(name: string) {
  return JSON.parse(await readFile(join(outputDirectory, name), "utf8"));
}

describe("shadcn registry distribution", () => {
  test("publishes a valid index with a flat all item", async () => {
    const registry = registrySchema.parse(await readJson("registry.json"));
    const itemNames = registry.items.map((item) => item.name);
    expect(new Set(itemNames).size).toBe(itemNames.length);
    expect(itemNames).toContain("all");
    expect(itemNames).toContain("artifact-ui");
    expect(itemNames).toContain("data-elements");

    const all = registryItemSchema.parse(await readJson("all.json"));
    expect(all.type).toBe("registry:component");
    expect(all.registryDependencies ?? []).toEqual([]);
    const lockFile = all.files?.find((file) => file.target?.endsWith("data-elements.lock.json"));
    const lock = JSON.parse(lockFile?.content ?? "null");
    expect(Object.keys(lock.files)).toHaveLength(32);
    expect(all.files).toHaveLength(Object.keys(lock.files).length + 1);
    expect(all.files?.every((file) => file.content && file.target?.startsWith("@components/data-elements/"))).toBe(true);
    expect(new Set(all.files?.map((file) => file.target)).size).toBe(all.files?.length);

    const outputNames = (await readdir(outputDirectory))
      .filter((name) => name.endsWith(".json") && name !== "registry.json")
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(outputNames).toEqual([...itemNames].sort());
  });

  test("keeps generated source self-contained and closes the CSS dependency", async () => {
    const all = registryItemSchema.parse(await readJson("all.json"));
    const content = all.files?.map((file) => file.content ?? "").join("\n") ?? "";
    const internalImports = [...content.matchAll(/(?:from\s+["']|import\s*["'])(@data-elements\/[^"']+)/g)]
      .map((match) => match[1]);
    expect(new Set(internalImports)).toEqual(new Set([
      "@data-elements/core",
      "@data-elements/runtime",
      "@data-elements/schema",
    ]));
    expect(content).not.toMatch(/@data-elements\/(?:capability-broker|compiler|resources)/);
    expect(all.files?.some((file) => /\/(?:schema|core|runtime)\.(?:ts|tsx|js|jsx)$/.test(file.target ?? ""))).toBe(false);

    const primitives = all.files?.find((file) => file.target?.endsWith("/primitives.tsx"));
    const artifactUi = all.files?.find((file) => file.target?.endsWith("/artifact-ui.tsx"));
    const styles = all.files?.find((file) => file.target?.endsWith("/styles.css"));
    expect(artifactUi?.content).toContain('export * from "./renderer";');
    expect(artifactUi?.content).toContain("ArtifactPart");
    expect(artifactUi?.content).toContain("ArtifactDocument");
    expect(primitives?.content).toContain('import "./styles.css";');
    expect(styles?.content).toContain(".de-artifact");
    expect(styles?.content).toContain(".de-slider");
  });

  test("makes every individual component target portable", async () => {
    const registry = registrySchema.parse(await readJson("registry.json"));
    for (const item of registry.items) {
      for (const file of item.files ?? []) {
        expect(file.target?.startsWith("@components/data-elements/")).toBe(true);
        expect(file.path).not.toMatch(/registry\/generated\/(?:schema|core|runtime)\.(?:ts|tsx|js|jsx)$/);
      }
    }

    const primitives = registryItemSchema.parse(await readJson("data-elements-primitives.json"));
    expect(primitives.files?.some((file) => file.target === "@components/data-elements/styles.css")).toBe(true);
    expect(primitives.registryDependencies).toEqual(["http://localhost:3000/r/data-elements-provider.json"]);

    const renderer = registryItemSchema.parse(await readJson("artifact-renderer.json"));
    const rendererTargets = new Set(renderer.files?.map((file) => file.target));
    expect(rendererTargets).toEqual(new Set([
      "@components/data-elements/renderer.tsx",
      "@components/data-elements/node-types.ts",
      "@components/data-elements/surface-nodes.tsx",
      "@components/data-elements/form-nodes.tsx",
    ]));

    const lockItem = registryItemSchema.parse(await readJson("data-elements-lock.json"));
    expect(lockItem.files?.map((file) => file.target)).toEqual([
      "@components/data-elements/data-elements.lock.json",
    ]);

    const artifactUi = registryItemSchema.parse(await readJson("artifact-ui.json"));
    expect(artifactUi.registryDependencies).toEqual(["http://localhost:3000/r/all.json"]);
    expect(artifactUi.files?.map((file) => file.target)).toEqual([
      "@components/data-elements/artifact-ui.tsx",
    ]);
    const all = registryItemSchema.parse(await readJson("all.json"));
    expect(all.files?.some((file) => file.target === "@components/data-elements/artifact-ui.tsx")).toBe(true);
  });

  test("publishes contract metadata and an install lock", async () => {
    const query = registryItemSchema.parse(await readJson("query-artifact.json"));
    expect(query.meta?.contract).toBe("query@1");
    expect(query.meta?.contractFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(query.meta?.rendererBuildHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const all = registryItemSchema.parse(await readJson("all.json"));
    const lockFile = all.files?.find((file) => file.target?.endsWith("data-elements.lock.json"));
    expect(lockFile).toBeDefined();
    const lock = JSON.parse(lockFile?.content ?? "null");
    expect(lock.formatVersion).toBe(2);
    expect(lock.catalog.nodeVersions).toHaveProperty("driver", 1);
    expect(lock.catalog.nodeVersions).toHaveProperty("ranking", 1);
    expect(lock.catalog.nodeVersions).toHaveProperty("target", 1);
    expect(lock.catalog.nodeVersions).toHaveProperty("timeline", 1);
    expect(lock.protocolRange).toBe(">=1.0 <3");
    expect(lock.contractApiRange).toBe(">=0.1 <1");
    expect(lock.runtimeApiRange).toBe(">=0.1 <1");
    expect(lock.rendererApiRange).toBe(">=0.1 <1");
    expect(lock.dependencies).toEqual({
      "@data-elements/core": "0.1.0",
      "@data-elements/runtime": "0.1.0",
      "@data-elements/schema": "0.1.0",
    });
    expect(lock.rendererConformance).toBe("official");

    const installedByName = new Map(all.files?.map((file) => [
      file.target?.replace(/^@components\/data-elements\//, ""),
      file.content,
    ]));
    for (const [name, record] of Object.entries(lock.files) as Array<[string, { source: string; sha256: string }]>) {
      expect(record.source.startsWith("packages/react/src/"), name).toBe(true);
      expect(record.sha256, name).toBe(`sha256:${sha256(installedByName.get(name) ?? "")}`);
    }

    const dependencies = new Set(all.dependencies);
    expect(dependencies).toEqual(new Set([
      "@data-elements/core@0.1.0",
      "@data-elements/runtime@0.1.0",
      "@data-elements/schema@0.1.0",
      "@radix-ui/react-tabs@1.1.21",
      "lucide-react@1.31.0",
      "recharts@3.10.1",
    ]));
  });

  test("fails closed outside the React source boundary and for every unapproved internal package", async () => {
    expect(() => assertBrowserSafeImports(["@data-elements/schema", "@data-elements/runtime"])).not.toThrow();
    expect(() => assertBrowserSafeImports(["@data-elements/runtime/server"], "fixture.ts")).toThrow("unapproved");
    expect(() => assertBrowserSafeImports(["@data-elements/compiler"], "fixture.ts")).toThrow("server-only");
    expect(() => assertBrowserSafeImports(["@data-elements/capability-broker/browser"], "fixture.ts")).toThrow("server-only");
    expect(() => assertBrowserSafeImports(["@data-elements/resources"], "fixture.ts")).toThrow("server-only");
    expect(() => assertBrowserSafeImports(["@data-elements/future-server-package"], "fixture.ts")).toThrow("unapproved");
    await expect(collectSourceClosure(["packages/schema/src/index.ts"])).rejects.toThrow("outside packages/react/src");
  });

  test("keeps the legacy bundle as a single compatibility alias", async () => {
    const legacy = registryItemSchema.parse(await readJson("data-elements.json"));
    expect(legacy.files ?? []).toEqual([]);
    expect(legacy.registryDependencies).toEqual(["http://localhost:3000/r/artifact-ui.json"]);
  });
});
