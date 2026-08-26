import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const linkedPackageNames = [
  "@open-generative/components",
  "@open-generative/mastra",
  "@open-generative/protocol",
  "@open-generative/ui",
] as const;

const studioRoot = resolve(import.meta.dir, "..");
const tesseraRoot = resolve(studioRoot, "../..");

export function resolveOpenGenerativeRoot(): string | undefined {
  const configuredRoot = process.env.OPEN_GENERATIVE_ROOT?.trim();
  const candidate = resolve(configuredRoot || resolve(tesseraRoot, "../open-generative"));
  return isOpenGenerativeWorkspace(candidate) ? candidate : undefined;
}

export async function ensureOpenGenerativeLinks(openGenerativeRoot: string): Promise<void> {
  assertSupportedBunVersion();
  for (const packageName of linkedPackageNames) {
    const packageRoot = packageRootFor(openGenerativeRoot, packageName);
    assertPackageName(packageRoot, packageName);
    await run(["bun", "link", "--no-save"], packageRoot);
  }

  await run([
    "bun",
    "add",
    "--filter=@open-tessera/studio",
    "--no-save",
    ...linkedPackageNames.map((packageName) => `${packageName}@link:${packageName}`),
  ], tesseraRoot);

  for (const packageName of linkedPackageNames) {
    assertResolvedInside(packageName, packageRootFor(openGenerativeRoot, packageName));
  }
  assertResolvedInside("@open-generative/ui/styles.css", packageRootFor(openGenerativeRoot, "@open-generative/ui"));
  assertResolvedInside("@open-generative/ui/renderer-release.json", packageRootFor(openGenerativeRoot, "@open-generative/ui"));
}

function assertSupportedBunVersion(): void {
  const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
  if (major < 1 || (major === 1 && minor < 4)) {
    throw new Error(`Open Generative workspace linking requires Bun >= 1.4.0; received ${Bun.version}.`);
  }
}

export async function buildOpenGenerativePackages(openGenerativeRoot: string): Promise<void> {
  await run([
    "bun",
    "x",
    "turbo",
    "run",
    "build",
    "--filter=@open-generative/mastra...",
    "--filter=@open-generative/ui...",
    "--output-logs=new-only",
  ], openGenerativeRoot);
}

function isOpenGenerativeWorkspace(root: string): boolean {
  if (!existsSync(resolve(root, "package.json"))) return false;
  try {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === "open-generative";
  } catch {
    return false;
  }
}

function assertPackageName(packageRoot: string, expectedName: string): void {
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing linked package manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown };
  if (manifest.name !== expectedName) {
    throw new Error(`Expected ${manifestPath} to declare ${expectedName}.`);
  }
}

function packageRootFor(openGenerativeRoot: string, packageName: string): string {
  return resolve(openGenerativeRoot, "packages", packageName.slice("@open-generative/".length));
}

function assertResolvedInside(specifier: string, expectedPackageRoot: string): void {
  const expectedRoot = realpathSync(expectedPackageRoot);
  const actualEntry = realpathSync(Bun.resolveSync(specifier, studioRoot));
  const relativeEntry = relative(expectedRoot, actualEntry);
  if (relativeEntry === ".." || relativeEntry.startsWith(`..${sep}`) || isAbsolute(relativeEntry)) {
    throw new Error(`Expected ${specifier} to resolve inside ${expectedRoot}, received ${actualEntry}.`);
  }
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed in ${cwd} with exit code ${exitCode}.`);
  }
}

if (import.meta.main) {
  const openGenerativeRoot = resolveOpenGenerativeRoot();
  if (!openGenerativeRoot) {
    throw new Error(
      "Open Generative workspace not found. Set OPEN_GENERATIVE_ROOT or place it next to open-tessera.",
    );
  }
  await buildOpenGenerativePackages(openGenerativeRoot);
  await ensureOpenGenerativeLinks(openGenerativeRoot);
  console.info(`Linked Tessera Studio to ${openGenerativeRoot}.`);
}
