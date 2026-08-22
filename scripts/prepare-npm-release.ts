import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { npmReleasePackages } from "./npm-release-config";

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const root = join(import.meta.dir, "..");
const releaseManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageManifest;
const version = releaseManifest.version;
if (!version) throw new Error("Root package.json must define the release version.");

const workspaceNames = new Set<string>();
for (const packageDefinition of npmReleasePackages) {
  const path = join(root, packageDefinition.directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as PackageManifest;
  if (manifest.name) workspaceNames.add(manifest.name);
}

for (const packageDefinition of npmReleasePackages) {
  const path = join(root, packageDefinition.directory, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as PackageManifest;
  let changed = false;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = manifest[field];
    if (!dependencies) continue;
    for (const dependency of workspaceNames) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, dependency)) continue;
      if (dependencies[dependency] === version) continue;
      dependencies[dependency] = version;
      changed = true;
    }
  }
  if (packageDefinition.directory === "apps/studio" && manifest.dependencies) {
    for (const dependency of Object.keys(manifest.dependencies)) {
      if (dependency.startsWith("@data-elements/")) {
        delete manifest.dependencies[dependency];
        changed = true;
      }
    }
  }
  if (changed) {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

console.log(`Prepared npm manifests for ${version}.`);
