import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageGraph } from "./package-graph";

const root = join(import.meta.dir, "..");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const issues: string[] = [];

for (const definition of packageGraph) {
  const manifest = JSON.parse(await readFile(join(root, definition.directory, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    private?: boolean;
    files?: string[];
  };
  if (manifest.version !== rootManifest.version) issues.push(`${definition.name} version must be ${rootManifest.version}.`);
  if (manifest.private) issues.push(`${definition.name} cannot be private.`);
  if (!manifest.files?.includes("dist")) issues.push(`${definition.name} must publish only dist.`);
  try {
    await access(join(root, definition.directory, "dist", "index.mjs"));
    await access(join(root, definition.directory, "dist", "index.d.mts"));
  } catch {
    issues.push(`${definition.name} is missing built root exports.`);
  }
}

if (issues.length > 0) throw new Error(["Release check failed:", ...issues].join("\n"));
console.log(`Verified ${packageGraph.length} publishable packages at ${rootManifest.version}.`);
