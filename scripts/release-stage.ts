import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { packageGraph, type PackageDefinition } from "./package-graph";

const root = resolve(import.meta.dir, "..");
const repositoryUrl = "git+https://github.com/ErKeLost/Tessera.git";
const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const publishFilePattern = /^(?:README|LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|HISTORY)(?:\..*)?$/i;
const unsupportedFilePattern = /[*?[\]{}!]/;

type DependencyField = (typeof dependencyFields)[number];
type JsonObject = Record<string, unknown>;

type ReleasePackage = {
  name: string;
  version: string;
  stagedDirectory: string;
  tarballPath: string;
  integrity: string;
};

type ReleaseManifest = {
  schemaVersion: 1;
  version: string;
  packages: ReleasePackage[];
};

type PreparedPackage = {
  definition: PackageDefinition;
  sourceDirectory: string;
  manifest: JsonObject;
  files: string[];
};

function usage(): never {
  console.log("Usage: bun scripts/release-stage.ts --version <semver> --output <empty-directory>");
  process.exit(0);
}

function parseArguments(): { version: string; output: string } {
  const values = new Map<string, string>();
  const args = Bun.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument !== "--version" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument ?? "<missing>"}`);
    }
    if (values.has(argument)) throw new Error(`Argument ${argument} can only be provided once.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Argument ${argument} requires a value.`);
    values.set(argument, value);
    index += 1;
  }

  const version = values.get("--version");
  const output = values.get("--output");
  if (!version || !output) throw new Error("Both --version and --output are required.");
  if (!semverPattern.test(version)) throw new Error(`Invalid semantic version: ${version}`);
  return { version, output };
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

function toManifestPath(base: string, path: string): string {
  return relative(base, path).split(sep).join("/");
}

function findWorkspaceValues(value: unknown, path = "package.json"): string[] {
  if (typeof value === "string") return value.startsWith("workspace:") ? [path] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findWorkspaceValues(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => findWorkspaceValues(entry, `${path}.${key}`));
}

function validateGraph(): void {
  const packageNames = new Set<string>();
  const packageDirectories = new Set<string>();
  const packageIndexes = new Map(packageGraph.map((definition, index) => [definition.name, index]));

  for (const [index, definition] of packageGraph.entries()) {
    if (packageNames.has(definition.name)) throw new Error(`Duplicate package graph name: ${definition.name}`);
    if (packageDirectories.has(definition.directory)) throw new Error(`Duplicate package graph directory: ${definition.directory}`);
    packageNames.add(definition.name);
    packageDirectories.add(definition.directory);

    for (const dependency of definition.dependencies) {
      const dependencyIndex = packageIndexes.get(dependency);
      if (dependencyIndex === undefined) throw new Error(`${definition.name} references unknown graph package ${dependency}.`);
      if (dependencyIndex >= index) throw new Error(`${definition.name} must appear after ${dependency} in the package graph.`);
    }
  }
}

function rewriteInternalDependencies(
  manifest: JsonObject,
  definition: PackageDefinition,
  releaseVersion: string,
): void {
  const graphNames = new Set<string>(packageGraph.map(({ name }) => name));
  const expectedDependencies = new Set<string>(definition.dependencies);
  const declaredDependencies = new Map<string, DependencyField[]>();

  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    assertObject(dependencies, `${definition.name} ${field}`);

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string") throw new Error(`${definition.name} ${field}.${name} must be a string.`);
      if (!name.startsWith("@open-tessera/")) continue;
      if (!graphNames.has(name)) throw new Error(`${definition.name} depends on unknown internal package ${name}.`);
      if (!expectedDependencies.has(name)) throw new Error(`${definition.name} has undeclared graph dependency ${name}.`);
      if (specifier !== "workspace:*") {
        throw new Error(`${definition.name} ${field}.${name} must use workspace:* before staging.`);
      }
      const fields = declaredDependencies.get(name) ?? [];
      fields.push(field);
      declaredDependencies.set(name, fields);
      dependencies[name] = releaseVersion;
    }
  }

  for (const dependency of expectedDependencies) {
    const fields = declaredDependencies.get(dependency) ?? [];
    if (fields.length === 0) throw new Error(`${definition.name} is missing graph dependency ${dependency}.`);
    if (fields.length > 1) {
      throw new Error(`${definition.name} declares ${dependency} in multiple dependency fields: ${fields.join(", ")}.`);
    }
  }

  const devDependencies = manifest.devDependencies;
  if (devDependencies !== undefined) {
    assertObject(devDependencies, `${definition.name} devDependencies`);
    for (const [name, specifier] of Object.entries(devDependencies)) {
      if (!name.startsWith("@open-tessera/")) continue;
      if (!graphNames.has(name)) throw new Error(`${definition.name} depends on unknown internal package ${name}.`);
      if (specifier !== "workspace:*") {
        throw new Error(`${definition.name} devDependencies.${name} must use workspace:* before staging.`);
      }
      devDependencies[name] = releaseVersion;
    }
  }

  const remainingWorkspaceValues = findWorkspaceValues(manifest);
  if (remainingWorkspaceValues.length > 0) {
    throw new Error(`${definition.name} contains unstaged workspace specifiers at ${remainingWorkspaceValues.join(", ")}.`);
  }
}

function applyRepositoryMetadata(manifest: JsonObject, definition: PackageDefinition): void {
  manifest.repository = {
    type: "git",
    url: repositoryUrl,
    directory: definition.directory,
  };
}

function validateManifest(
  manifest: JsonObject,
  definition: PackageDefinition,
  releaseVersion: string,
): string[] {
  if (manifest.name !== definition.name) {
    throw new Error(`${definition.directory}/package.json must be named ${definition.name}.`);
  }
  if (manifest.version !== releaseVersion) {
    throw new Error(`${definition.name} version must be ${releaseVersion}, received ${String(manifest.version)}.`);
  }
  if (manifest.private === true) throw new Error(`${definition.name} cannot be private.`);
  if (!Array.isArray(manifest.files) || !manifest.files.every((entry) => typeof entry === "string")) {
    throw new Error(`${definition.name} must have a string-only files array.`);
  }
  if (!manifest.files.includes("dist")) throw new Error(`${definition.name} must include dist in its files array.`);
  return manifest.files;
}

async function copyPublishableFiles(
  sourceDirectory: string,
  stagedDirectory: string,
  files: string[],
): Promise<void> {
  const copied = new Set<string>();

  for (const entry of files) {
    const normalizedEntry = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalizedEntry || isAbsolute(normalizedEntry) || unsupportedFilePattern.test(normalizedEntry)) {
      throw new Error(`Unsupported package files entry ${JSON.stringify(entry)} in ${sourceDirectory}.`);
    }
    const source = resolve(sourceDirectory, normalizedEntry);
    if (!pathIsInside(sourceDirectory, source)) {
      throw new Error(`Package files entry escapes its package directory: ${entry}`);
    }
    await stat(source).catch((error) => {
      throw new Error(`Publishable path does not exist: ${source}`, { cause: error });
    });
    const destination = join(stagedDirectory, normalizedEntry);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    copied.add(normalizedEntry);
  }

  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !publishFilePattern.test(entry.name) || copied.has(entry.name)) continue;
    await cp(join(sourceDirectory, entry.name), join(stagedDirectory, entry.name), {
      force: false,
      errorOnExist: true,
    });
  }
}

function collectPackageTargets(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("./") && !value.includes("*") ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectPackageTargets);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(collectPackageTargets);
}

async function validatePackageTargets(manifest: JsonObject, stagedDirectory: string): Promise<void> {
  const targets = new Set<string>();
  for (const field of ["main", "module", "types", "exports", "bin"] as const) {
    for (const target of collectPackageTargets(manifest[field])) targets.add(target);
  }

  for (const target of targets) {
    const resolvedTarget = resolve(stagedDirectory, target);
    if (!pathIsInside(stagedDirectory, resolvedTarget)) throw new Error(`Package target escapes staging: ${target}`);
    await stat(resolvedTarget).catch((error) => {
      throw new Error(`Published package target does not exist: ${target}`, { cause: error });
    });
  }
}

async function run(command: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(command, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function readPackedManifest(tarballPath: string): Promise<JsonObject> {
  const result = await run(["tar", "-xOf", tarballPath, "package/package.json"], root);
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

async function packPackage(
  definition: PackageDefinition,
  releaseVersion: string,
  stagedDirectory: string,
  tarballDirectory: string,
  outputDirectory: string,
): Promise<ReleasePackage> {
  const result = await run([
    "npm",
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    tarballDirectory,
    ".",
  ], stagedDirectory);
  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed for ${definition.name}:\n${result.stderr.trim() || result.stdout.trim()}`);
  }

  let packResult: unknown;
  try {
    packResult = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON for ${definition.name}.`, { cause: error });
  }
  if (!Array.isArray(packResult) || packResult.length !== 1) {
    throw new Error(`npm pack returned an unexpected result for ${definition.name}.`);
  }
  const packed = packResult[0];
  assertObject(packed, `npm pack result for ${definition.name}`);
  if (typeof packed.filename !== "string" || basename(packed.filename) !== packed.filename) {
    throw new Error(`npm pack returned an unsafe filename for ${definition.name}.`);
  }

  const tarballPath = join(tarballDirectory, packed.filename);
  const tarballStats = await stat(tarballPath);
  if (!tarballStats.isFile()) throw new Error(`npm pack did not create a tarball for ${definition.name}.`);

  const packedManifest = await readPackedManifest(tarballPath);
  if (packedManifest.name !== definition.name || packedManifest.version !== releaseVersion) {
    throw new Error(`Packed manifest identity does not match ${definition.name}@${releaseVersion}.`);
  }
  const workspaceValues = findWorkspaceValues(packedManifest);
  if (workspaceValues.length > 0) {
    throw new Error(`Packed ${definition.name} contains workspace specifiers at ${workspaceValues.join(", ")}.`);
  }

  const integrity = `sha512-${createHash("sha512").update(await readFile(tarballPath)).digest("base64")}`;
  return {
    name: definition.name,
    version: releaseVersion,
    stagedDirectory: toManifestPath(outputDirectory, stagedDirectory),
    tarballPath: toManifestPath(outputDirectory, tarballPath),
    integrity,
  };
}

const { version: releaseVersion, output } = parseArguments();
validateGraph();

const rootManifest = await readJson(join(root, "package.json"), "root package manifest");
if (rootManifest.version !== releaseVersion) {
  throw new Error(`Release version ${releaseVersion} does not match root version ${String(rootManifest.version)}.`);
}

const preparedPackages: PreparedPackage[] = [];
for (const definition of packageGraph) {
  const sourceDirectory = resolve(root, definition.directory);
  const manifest = await readJson(join(sourceDirectory, "package.json"), `${definition.name} manifest`);
  const files = validateManifest(manifest, definition, releaseVersion);
  rewriteInternalDependencies(manifest, definition, releaseVersion);
  applyRepositoryMetadata(manifest, definition);
  preparedPackages.push({ definition, sourceDirectory, manifest, files });
}

const outputDirectory = resolve(output);
if (outputDirectory === root) throw new Error("Release output cannot be the repository root.");
for (const definition of packageGraph) {
  const sourceDirectory = resolve(root, definition.directory);
  if (outputDirectory === sourceDirectory || pathIsInside(sourceDirectory, outputDirectory)) {
    throw new Error(`Release output cannot be inside source package ${definition.name}.`);
  }
}
await mkdir(outputDirectory, { recursive: true });
const existingOutput = await readdir(outputDirectory);
if (existingOutput.length > 0) throw new Error(`Release output directory must be empty: ${outputDirectory}`);

const stagedPackageRoot = join(outputDirectory, "packages");
const tarballDirectory = join(outputDirectory, "tarballs");
await mkdir(stagedPackageRoot);
await mkdir(tarballDirectory);

const releasePackages: ReleasePackage[] = [];
for (const { definition, sourceDirectory, manifest, files } of preparedPackages) {
  const stagedDirectory = join(stagedPackageRoot, basename(definition.directory));
  await mkdir(stagedDirectory);
  await copyPublishableFiles(sourceDirectory, stagedDirectory, files);
  await writeFile(join(stagedDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await validatePackageTargets(manifest, stagedDirectory);
  releasePackages.push(await packPackage(
    definition,
    releaseVersion,
    stagedDirectory,
    tarballDirectory,
    outputDirectory,
  ));
}

const releaseManifest: ReleaseManifest = {
  schemaVersion: 1,
  version: releaseVersion,
  packages: releasePackages,
};
const releaseManifestPath = join(outputDirectory, "release-manifest.json");
await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
console.log(`Staged and packed ${releasePackages.length} packages for ${releaseVersion}.`);
console.log(`Release manifest: ${releaseManifestPath}`);
