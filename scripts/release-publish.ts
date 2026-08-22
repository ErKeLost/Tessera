import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { packageGraph } from "./package-graph";

const registry = "https://registry.npmjs.org/";
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type JsonObject = Record<string, unknown>;

type VerifiedPackage = {
  name: string;
  version: string;
  stagedDirectory: string;
  tarballPath: string;
  integrity: string;
};

function usage(): never {
  console.log("Usage: bun scripts/release-publish.ts --manifest <path> [--verify-only] [--provenance]");
  process.exit(0);
}

function parseArguments(): { manifest: string; verifyOnly: boolean; provenance: boolean } {
  let manifest: string | undefined;
  let verifyOnly = false;
  let provenance = false;
  const args = Bun.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--verify-only") {
      if (verifyOnly) throw new Error("Argument --verify-only can only be provided once.");
      verifyOnly = true;
      continue;
    }
    if (argument === "--provenance") {
      if (provenance) throw new Error("Argument --provenance can only be provided once.");
      provenance = true;
      continue;
    }
    if (argument === "--manifest") {
      if (manifest) throw new Error("Argument --manifest can only be provided once.");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Argument --manifest requires a value.");
      manifest = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
  }

  if (!manifest) throw new Error("--manifest is required.");
  if (verifyOnly && provenance) throw new Error("--provenance cannot be used with --verify-only.");
  return { manifest, verifyOnly, provenance };
}

function assertObject(value: unknown, label: string): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

async function readJson(path: string, label: string): Promise<JsonObject> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}.`, { cause: error });
  }
  assertObject(value, label);
  return value;
}

function pathIsInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function resolveArtifactPath(manifestDirectory: string, value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const path = resolve(manifestDirectory, value);
  if (!pathIsInside(manifestDirectory, path)) throw new Error(`${label} escapes the release directory.`);
  return path;
}

function findWorkspaceValues(value: unknown, path = "package.json"): string[] {
  if (typeof value === "string") return value.startsWith("workspace:") ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findWorkspaceValues(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => findWorkspaceValues(entry, `${path}.${key}`));
}

function validateInternalDependencies(
  manifest: JsonObject,
  packageName: string,
  expectedDependencyNames: readonly string[],
  releaseVersion: string,
  label: string,
): void {
  const graphNames = new Set<string>(packageGraph.map(({ name }) => name));
  const expectedDependencies = new Set(expectedDependencyNames);
  const declaredDependencies = new Map<string, string[]>();

  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    assertObject(dependencies, `${label} ${packageName} ${field}`);

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!name.startsWith("@open-generative/") && !name.startsWith("@open-tessera/")) continue;
      if (!graphNames.has(name)) throw new Error(`${label} ${packageName} references unknown internal package ${name}.`);
      if (!expectedDependencies.has(name)) {
        throw new Error(`${label} ${packageName} has undeclared graph dependency ${name}.`);
      }
      if (specifier !== releaseVersion) {
        throw new Error(`${label} ${packageName} must depend on ${name}@${releaseVersion}.`);
      }
      const fields = declaredDependencies.get(name) ?? [];
      fields.push(field);
      declaredDependencies.set(name, fields);
    }
  }

  for (const dependency of expectedDependencies) {
    const fields = declaredDependencies.get(dependency) ?? [];
    if (fields.length === 0) throw new Error(`${label} ${packageName} is missing graph dependency ${dependency}.`);
    if (fields.length > 1) {
      throw new Error(`${label} ${packageName} declares ${dependency} in multiple dependency fields.`);
    }
  }
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function readPackedManifest(tarballPath: string, cwd: string): Promise<JsonObject> {
  const result = await run(["tar", "-xOf", tarballPath, "package/package.json"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`Unable to read package.json from ${tarballPath}: ${result.stderr.trim()}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Packed package.json is invalid in ${tarballPath}.`, { cause: error });
  }
  assertObject(value, `packed manifest in ${tarballPath}`);
  return value;
}

async function verifyReleaseManifest(manifestPath: string): Promise<{ version: string; packages: VerifiedPackage[] }> {
  const resolvedManifestPath = resolve(manifestPath);
  const manifestDirectory = resolve(resolvedManifestPath, "..");
  const manifest = await readJson(resolvedManifestPath, "release manifest");

  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported release manifest schema: ${String(manifest.schemaVersion)}`);
  if (typeof manifest.version !== "string" || !semverPattern.test(manifest.version)) {
    throw new Error(`Release manifest has an invalid version: ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== packageGraph.length) {
    throw new Error(`Release manifest must contain exactly ${packageGraph.length} packages.`);
  }

  const stagedDirectories = new Set<string>();
  const tarballPaths = new Set<string>();
  const verifiedPackages: VerifiedPackage[] = [];

  for (const [index, definition] of packageGraph.entries()) {
    const entry = manifest.packages[index];
    assertObject(entry, `release manifest package ${index}`);
    if (entry.name !== definition.name) {
      throw new Error(`Release package ${index} must be ${definition.name}, received ${String(entry.name)}.`);
    }
    if (entry.version !== manifest.version) {
      throw new Error(`${definition.name} must use release version ${manifest.version}.`);
    }
    if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
      throw new Error(`${definition.name} has an invalid integrity value.`);
    }

    const stagedDirectory = resolveArtifactPath(manifestDirectory, entry.stagedDirectory, `${definition.name} stagedDirectory`);
    const tarballPath = resolveArtifactPath(manifestDirectory, entry.tarballPath, `${definition.name} tarballPath`);
    if (stagedDirectories.has(stagedDirectory)) throw new Error(`Duplicate staged directory: ${stagedDirectory}`);
    if (tarballPaths.has(tarballPath)) throw new Error(`Duplicate tarball path: ${tarballPath}`);
    stagedDirectories.add(stagedDirectory);
    tarballPaths.add(tarballPath);

    const stagedStats = await stat(stagedDirectory);
    if (!stagedStats.isDirectory()) throw new Error(`Staged package directory is missing: ${stagedDirectory}`);
    const tarballStats = await stat(tarballPath);
    if (!tarballStats.isFile()) throw new Error(`Release tarball is missing: ${tarballPath}`);

    const actualIntegrity = `sha512-${createHash("sha512").update(await readFile(tarballPath)).digest("base64")}`;
    if (actualIntegrity !== entry.integrity) throw new Error(`Tarball integrity mismatch for ${definition.name}.`);

    const stagedManifest = await readJson(resolve(stagedDirectory, "package.json"), `${definition.name} staged manifest`);
    const packedManifest = await readPackedManifest(tarballPath, manifestDirectory);
    for (const [label, packageManifest] of [["staged", stagedManifest], ["packed", packedManifest]] as const) {
      if (packageManifest.name !== definition.name || packageManifest.version !== manifest.version) {
        throw new Error(`${label} manifest identity does not match ${definition.name}@${manifest.version}.`);
      }
      const workspaceValues = findWorkspaceValues(packageManifest);
      if (workspaceValues.length > 0) {
        throw new Error(`${label} ${definition.name} contains workspace specifiers at ${workspaceValues.join(", ")}.`);
      }
      validateInternalDependencies(
        packageManifest,
        definition.name,
        definition.dependencies,
        manifest.version,
        label,
      );
    }

    verifiedPackages.push({
      name: definition.name,
      version: manifest.version,
      stagedDirectory,
      tarballPath,
      integrity: entry.integrity,
    });
  }

  return { version: manifest.version, packages: verifiedPackages };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function registryVersionUrl(name: string, version: string): URL {
  return new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, registry);
}

async function registryHasVersion(name: string, version: string, attempts = 3): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(registryVersionUrl(name, version), {
        headers: { "Cache-Control": "no-cache", "User-Agent": "open-generative-release" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}.`);
      const document: unknown = await response.json();
      assertObject(document, `npm registry document for ${name}@${version}`);
      if (document.name !== name || document.version !== version) {
        throw new Error(`npm registry returned the wrong package identity for ${name}@${version}.`);
      }
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(1_000 * attempt);
    }
  }
  throw new Error(`Unable to determine whether ${name}@${version} is published.`, { cause: lastError });
}

async function appearedAfterPublishError(name: string, version: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (await registryHasVersion(name, version)) return true;
    if (attempt < 4) await delay(2_000 * attempt);
  }
  return false;
}

async function publishPackage(
  releasePackage: VerifiedPackage,
  distTag: string,
  provenance: boolean,
  npmEnvironment: Record<string, string | undefined>,
  cwd: string,
): Promise<void> {
  if (await registryHasVersion(releasePackage.name, releasePackage.version)) {
    console.log(`${releasePackage.name}@${releasePackage.version} is already published; skipping.`);
    return;
  }

  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const command = [
      "npm",
      "publish",
      releasePackage.tarballPath,
      "--access",
      "public",
      "--tag",
      distTag,
      "--ignore-scripts",
      "--registry",
      registry,
    ];
    if (provenance) command.push("--provenance");

    const result = await run(command, cwd, npmEnvironment);
    if (result.exitCode === 0) {
      console.log(`Published ${releasePackage.name}@${releasePackage.version} with dist-tag ${distTag}.`);
      return;
    }

    lastFailure = result.stderr.trim() || result.stdout.trim();
    if (await appearedAfterPublishError(releasePackage.name, releasePackage.version)) {
      console.log(`${releasePackage.name}@${releasePackage.version} became available after npm returned an error.`);
      return;
    }
    if (attempt < 3) await delay(5_000 * attempt);
  }

  throw new Error(`npm publish failed for ${releasePackage.name}@${releasePackage.version}:\n${lastFailure}`);
}

const { manifest, verifyOnly, provenance } = parseArguments();
const release = await verifyReleaseManifest(manifest);
console.log(`Verified ${release.packages.length} release tarballs for ${release.version}.`);

if (!verifyOnly) {
  const token = process.env.NODE_AUTH_TOKEN?.trim() || process.env.NPM_TOKEN?.trim();
  if (!token) throw new Error("NODE_AUTH_TOKEN or NPM_TOKEN is required to publish.");

  const npmEnvironment = { ...process.env, NODE_AUTH_TOKEN: token };
  const manifestDirectory = resolve(resolve(manifest), "..");
  const authentication = await run(["npm", "whoami", "--registry", registry], manifestDirectory, npmEnvironment);
  if (authentication.exitCode !== 0) {
    throw new Error(`npm authentication failed: ${authentication.stderr.trim() || authentication.stdout.trim()}`);
  }

  const distTag = release.version.split("+")[0]?.includes("-") ? "next" : "latest";
  for (const releasePackage of release.packages) {
    await publishPackage(releasePackage, distTag, provenance, npmEnvironment, manifestDirectory);
  }
}
