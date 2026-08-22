import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageByName, packageGraph } from "./package-graph";

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
};

const root = join(import.meta.dir, "..");
const graphDirectories = new Set(packageGraph.map(({ directory }) => directory));
const packageDirectories = (await readdir(join(root, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .filter((entry) => !entry.name.startsWith("."));
const manifestDirectories: string[] = [];
for (const entry of packageDirectories) {
  if (!graphDirectories.has(`packages/${entry.name}`)) continue;
  try {
    await readFile(join(root, "packages", entry.name, "package.json"), "utf8");
    manifestDirectories.push(`packages/${entry.name}`);
  } catch {
    // Ignored build residue is not a workspace package.
  }
}
try {
  await readFile(join(root, "apps/studio/package.json"), "utf8");
  manifestDirectories.push("apps/studio");
} catch {
  // Studio is optional in source-only package checks.
}

const expectedDirectories = packageGraph.map(({ directory }) => directory).sort();
if (manifestDirectories.sort().join("\n") !== expectedDirectories.join("\n")) {
  throw new Error(`Workspace package directories differ from the final graph.\nExpected:\n${expectedDirectories.join("\n")}\nActual:\n${manifestDirectories.sort().join("\n")}`);
}

const issues: string[] = [];
for (const definition of packageGraph) {
  const manifest = JSON.parse(await readFile(join(root, definition.directory, "package.json"), "utf8")) as Manifest;
  if (manifest.name !== definition.name) issues.push(`${definition.directory} must be named ${definition.name}.`);
  const internalDependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => name.startsWith("@open-generative/") || name.startsWith("@open-tessera/"),
  );
  for (const dependency of internalDependencies) {
    if (!packageByName.has(dependency)) {
      issues.push(`${definition.name} depends on unknown internal package ${dependency}.`);
    }
    if (!definition.dependencies.includes(dependency)) {
      issues.push(`${definition.name} has forbidden dependency ${dependency}.`);
    }
  }
  for (const dependency of definition.dependencies) {
    if (manifest.dependencies?.[dependency] !== "workspace:*") {
      issues.push(`${definition.name} must declare ${dependency} as workspace:*.`);
    }
  }
}

if (issues.length > 0) throw new Error(["Package boundary check failed:", ...issues].join("\n"));
console.log(`Verified the acyclic boundaries of ${packageGraph.length} Open Generative packages.`);
