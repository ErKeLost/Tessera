import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { npmReleasePackages } from "./npm-release-config";

type PackageManifest = Readonly<{
  name?: string;
  version?: string;
  private?: boolean;
  files?: readonly string[];
  dependencies?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, unknown>>;
}>;

const root = join(import.meta.dir, "..");
const requiredPackages = npmReleasePackages;

async function readManifest(directory: string): Promise<PackageManifest> {
  const content = await readFile(join(root, directory, "package.json"), "utf8");
  return JSON.parse(content) as PackageManifest;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const rootManifest = await readManifest(".");
if (!rootManifest.version) throw new Error("Root package.json must define the release version.");
const version = rootManifest.version;
const issues: string[] = [];

for (const packageDefinition of requiredPackages) {
  const manifest = await readManifest(packageDefinition.directory);
  const label = manifest.name ?? packageDefinition.directory;
  if (manifest.private) issues.push(`${label} is private and cannot be published.`);
  if (manifest.version !== version) {
    issues.push(`${label} has version ${manifest.version ?? "missing"}; expected ${version}.`);
  }
  if (!manifest.files?.includes("dist") && packageDefinition.directory !== "packages/cli") {
    issues.push(`${label} does not explicitly include dist in its publish files.`);
  }
  for (const file of packageDefinition.files) {
    if (!await exists(join(root, packageDefinition.directory, file))) {
      issues.push(`${label} is missing required publish file ${file}.`);
    }
  }
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if ((dependency.startsWith("@data-elements/") || dependency.startsWith("@open-tessera/") || dependency === "@open-tessera/studio")
      && range !== version
      && !range.startsWith("workspace:")) {
      issues.push(`${label} depends on ${dependency} through unexpected range ${range}.`);
    }
  }
  for (const dependency of packageDefinition.dependencies ?? []) {
    const range = manifest.dependencies?.[dependency];
    if (range !== version && range !== "workspace:*") {
      issues.push(`${label} must depend on ${dependency}@${version}; found ${range ?? "missing"}.`);
    }
  }

  if (manifest.name === "@open-tessera/studio") {
    const entry = manifest.exports?.["./main"];
    if (!entry || typeof entry !== "object" || (entry as { default?: unknown }).default !== "./dist/main.mjs") {
      issues.push("@open-tessera/studio must expose ./main through a default export so the Node CLI can resolve its Bun entry point.");
    }
  }
}

if (issues.length > 0) {
  throw new Error(["npm release readiness check failed:", ...issues.map((issue) => `- ${issue}`)].join("\n"));
}

console.log(`Verified ${requiredPackages.length} publishable packages for version ${version} in workspace mode.`);
