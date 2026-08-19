import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_CONTRACT_FINGERPRINT,
  artifactContracts,
  canonicalJson,
  sha256,
} from "../packages/core/src/index";

const root = join(import.meta.dir, "..");
const reactSourceDirectory = join(root, "packages", "react", "src");
const generatedDirectory = join(root, "registry", "generated");
const registryOutputDirectory = join(root, "apps", "docs", ".registry");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".css"] as const;
const entrySources = [
  "packages/react/src/artifact-ui.tsx",
  "packages/react/src/bridge.tsx",
  "packages/react/src/primitives.tsx",
  "packages/react/src/renderer.tsx",
  ...artifactContracts.map((contract) => contract.distribution.entryFile),
  "packages/react/src/styles.css",
];

const BROWSER_RUNTIME_PACKAGES = new Set([
  "@data-elements/schema",
  "@data-elements/core",
  "@data-elements/runtime",
]);
const STATIC_IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
const CSS_IMPORT_PATTERN = /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/g;

function loaderFor(source: string): "ts" | "tsx" | "js" | "jsx" {
  if (source.endsWith(".tsx")) return "tsx";
  if (source.endsWith(".jsx")) return "jsx";
  if (source.endsWith(".js")) return "js";
  return "ts";
}

function scanSourceImports(input: string, source: string): string[] {
  if (source.endsWith(".css")) {
    return [...new Set([...input.matchAll(CSS_IMPORT_PATTERN)].map((match) => match[1]!))].sort();
  }
  if (![".ts", ".tsx", ".js", ".jsx"].includes(extname(source))) return [];
  const transpiler = new Bun.Transpiler({ loader: loaderFor(source) });
  return [...new Set([
    ...transpiler.scanImports(input).map(({ path }) => path),
    ...[...input.matchAll(STATIC_IMPORT_PATTERN)].map((match) => match[1]!),
  ])].sort();
}

function internalPackageName(specifier: string): string | undefined {
  if (!specifier.startsWith("@data-elements/")) return undefined;
  return specifier.split("/").slice(0, 2).join("/");
}

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

export function assertBrowserSafeImports(imports: Iterable<string>, source = "registry source"): void {
  for (const imported of imports) {
    const packageName = internalPackageName(imported);
    if (packageName && (!BROWSER_RUNTIME_PACKAGES.has(packageName) || imported !== packageName)) {
      throw new Error(
        `Registry source ${source} imports server-only or unapproved package specifier ${imported}. `
        + "Only @data-elements/schema, @data-elements/core, and @data-elements/runtime are browser-safe dependencies.",
      );
    }
  }
}

function assertReactSourcePath(path: string, importedFrom?: string): void {
  const absolute = resolve(root, path);
  const fromReactRoot = relative(reactSourceDirectory, absolute);
  if (fromReactRoot === "" || fromReactRoot.startsWith(`..${sep}`) || fromReactRoot === ".." || isAbsolute(fromReactRoot)) {
    const context = importedFrom ? ` imported from ${importedFrom}` : "";
    throw new Error(`Registry source ${path}${context} is outside packages/react/src.`);
  }
}

async function resolveLocalImport(source: string, imported: string) {
  const base = resolve(root, source, "..", imported);
  const candidates = extname(base)
    ? [base]
    : [
        base,
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
      ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      const resolved = portablePath(relative(root, candidate));
      assertReactSourcePath(resolved, source);
      return resolved;
    } catch (error) {
      if (error instanceof Error && error.message.includes("outside packages/react/src")) throw error;
      // Try the next supported source extension.
    }
  }
  throw new Error(`Could not resolve local import "${imported}" from ${source}.`);
}

export async function collectSourceClosure(entries: readonly string[]) {
  const discovered = new Set<string>();
  const queue = [...new Set(entries)];
  while (queue.length > 0) {
    const source = queue.shift()!;
    if (discovered.has(source)) continue;
    assertReactSourcePath(source);
    const input = await readFile(join(root, source), "utf8");
    const imports = scanSourceImports(input, source);
    assertBrowserSafeImports(imports, source);
    discovered.add(source);
    for (const imported of imports.filter((path) => path.startsWith("."))) {
      queue.push(await resolveLocalImport(source, imported));
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function registryFileType(target: string): "registry:component" | "registry:lib" | "registry:style" {
  if (target.endsWith(".css")) return "registry:style";
  if (target.endsWith(".tsx") || target.endsWith(".jsx")) return "registry:component";
  return "registry:lib";
}

function generatedTarget(source: string): string {
  const target = relative(reactSourceDirectory, resolve(root, source));
  return target.split(sep).join("/");
}

function addRegistryStyles(input: string, target: string): string {
  if (target !== "primitives.tsx") return input;
  const importStatement = 'import "./styles.css";';
  if (input.includes(importStatement)) return input;
  if (!input.startsWith('"use client";')) {
    throw new Error("Registry primitives must begin with a use client directive.");
  }
  return input.replace(/^"use client";\r?\n/, `"use client";\n\n${importStatement}\n`);
}

type RegistryFile = { path: string; type: string; target?: string };
type RegistryItem = Record<string, unknown> & {
  name: string;
  dependencies?: string[];
  files?: RegistryFile[];
  registryDependencies?: string[];
};

function packageNameFromDependency(dependency: string): string {
  if (dependency.startsWith("@")) return dependency.split("@").slice(0, 2).join("@");
  return dependency.split("@")[0]!;
}

function generatedFileTarget(file: RegistryFile): string | undefined {
  if (!file.path.startsWith("registry/generated/")) return undefined;
  const target = file.path.slice("registry/generated/".length);
  return target === "data-elements.lock.json" ? undefined : target;
}

function resolveGeneratedImport(source: string, imported: string, generatedFiles: Record<string, unknown>): string {
  const base = posix.normalize(posix.join(posix.dirname(source), imported));
  const candidates = posix.extname(base)
    ? [base]
    : [
        base,
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => posix.join(base, `index${extension}`)),
      ];
  const resolved = candidates.find((candidate) => Object.hasOwn(generatedFiles, candidate));
  if (!resolved) throw new Error(`Could not resolve generated import "${imported}" from ${source}.`);
  return resolved;
}

function assertRegistryItemClosures(
  items: RegistryItem[],
  generatedFiles: Record<string, unknown>,
  generatedImports: Record<string, string[]>,
): void {
  const byName = new Map(items.map((item) => [item.name, item]));
  const availableCache = new Map<string, Set<string>>();
  const availableFor = (name: string, visiting = new Set<string>()): Set<string> => {
    const cached = availableCache.get(name);
    if (cached) return cached;
    if (visiting.has(name)) throw new Error(`Registry dependency cycle detected at ${name}.`);
    const item = byName.get(name);
    if (!item) throw new Error(`Registry dependency ${name} does not exist.`);
    const nextVisiting = new Set(visiting).add(name);
    const available = new Set((item.files ?? []).map(generatedFileTarget).filter((target): target is string => Boolean(target)));
    for (const dependency of item.registryDependencies ?? []) {
      const url = new URL(dependency);
      if (url.origin !== "http://localhost:3000") continue;
      const dependencyName = posix.basename(url.pathname, ".json");
      for (const target of availableFor(dependencyName, nextVisiting)) available.add(target);
    }
    availableCache.set(name, available);
    return available;
  };

  for (const item of items) {
    const available = availableFor(item.name);
    for (const source of available) {
      for (const imported of (generatedImports[source] ?? []).filter((specifier) => specifier.startsWith("."))) {
        const target = resolveGeneratedImport(source, imported, generatedFiles);
        if (!available.has(target)) {
          throw new Error(`Registry item ${item.name} is missing ${target}, imported by ${source}.`);
        }
      }
    }
  }
}

export async function prepareRegistry(): Promise<void> {
  await Promise.all([
    rm(generatedDirectory, { force: true, recursive: true }),
    rm(registryOutputDirectory, { force: true, recursive: true }),
  ]);
  await mkdir(generatedDirectory, { recursive: true });

  const packageVersions = Object.fromEntries(await Promise.all(
    [...BROWSER_RUNTIME_PACKAGES].sort().map(async (packageName) => {
      const directoryName = packageName.slice("@data-elements/".length);
      const manifest = JSON.parse(await readFile(join(root, "packages", directoryName, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (manifest.name !== packageName || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
        throw new Error(`Package ${packageName} must expose an exact semver version for registry distribution.`);
      }
      return [packageName, manifest.version!] as const;
    }),
  ));

  const sourceClosure = await collectSourceClosure(entrySources);
  const generatedFiles: Record<string, { source: string; sha256: string }> = {};
  const generatedImports: Record<string, string[]> = {};

  for (const source of sourceClosure) {
    const target = generatedTarget(source);
    if (generatedFiles[target]) throw new Error(`Registry source target collision: ${target}.`);
    const input = await readFile(join(root, source), "utf8");
    const output = addRegistryStyles(input, target);
    const imports = scanSourceImports(output, source);
    assertBrowserSafeImports(imports, source);
    if (target === "primitives.tsx" && output.match(/import "\.\/styles\.css";/g)?.length !== 1) {
      throw new Error("Registry primitives must import ./styles.css exactly once.");
    }

    await mkdir(dirname(join(generatedDirectory, target)), { recursive: true });
    await Bun.write(join(generatedDirectory, target), output);
    generatedFiles[target] = { source: portablePath(source), sha256: `sha256:${sha256(output)}` };
    generatedImports[target] = imports;
  }

  const rendererBuildHash = `sha256:${sha256(canonicalJson({
    dependencies: packageVersions,
    files: generatedFiles,
  }))}`;
  const lockRecord = {
    formatVersion: 2,
    catalog: {
      id: "data-elements.standard",
      version: "0.1.0",
      contractFingerprint: ARTIFACT_CONTRACT_FINGERPRINT,
      nodeVersions: Object.fromEntries(artifactContracts.map((contract) => [contract.kind, contract.version])),
    },
    protocolRange: ">=1.0 <3",
    contractApiRange: ">=0.1 <1",
    runtimeApiRange: ">=0.1 <1",
    rendererApiRange: ">=0.1 <1",
    dependencies: packageVersions,
    rendererBuildHash,
    rendererConformance: "official",
    files: generatedFiles,
  };
  await Bun.write(join(generatedDirectory, "data-elements.lock.json"), `${JSON.stringify(lockRecord, null, 2)}\n`);

  const registryTemplate = JSON.parse(await readFile(join(root, "registry.json"), "utf8")) as {
    items: RegistryItem[];
    [key: string]: unknown;
  };
  const registryItemNames = new Set(registryTemplate.items.map((item) => item.name));
  for (const contract of artifactContracts) {
    if (!registryItemNames.has(contract.distribution.registryName)) {
      throw new Error(`Contract ${contract.kind} is missing registry item ${contract.distribution.registryName}.`);
    }
  }

  const allFiles: RegistryFile[] = [
    {
      path: "registry/generated/data-elements.lock.json",
      type: "registry:lib",
      target: "@components/data-elements/data-elements.lock.json",
    },
    ...Object.keys(generatedFiles).sort().map((target) => ({
      path: `registry/generated/${target}`,
      type: registryFileType(target),
      target: `@components/data-elements/${target}`,
    })),
  ];

  const generatedRegistry = {
    ...registryTemplate,
    items: registryTemplate.items.map((item) => {
      const contract = artifactContracts.find((candidate) => candidate.distribution.registryName === item.name);
      const files = item.name === "all" ? allFiles : (item.files ?? []);
      for (const file of files) {
        if (!file.path.startsWith("registry/generated/")) continue;
        const expectedTarget = `@components/data-elements/${file.path.slice("registry/generated/".length)}`;
        if (file.target !== expectedTarget) {
          throw new Error(`Registry item ${item.name} must target ${expectedTarget}.`);
        }
      }
      const targetFiles = files
        .map((file) => file.path.replace(/^registry\/generated\//, ""))
        .filter((target) => target !== "data-elements.lock.json");
      for (const target of targetFiles) {
        if (!generatedFiles[target]) {
          throw new Error(`Registry item ${item.name} references unavailable React source ${target}.`);
        }
      }

      const requiredInternalPackages = new Set(targetFiles.flatMap((target) => (
        generatedImports[target] ?? []
      )).map(internalPackageName).filter((name): name is string => Boolean(name)));
      const dependencies = (item.dependencies ?? [])
        .filter((dependency) => packageNameFromDependency(dependency) !== "zod")
        .filter((dependency) => !packageNameFromDependency(dependency).startsWith("@data-elements/"));
      dependencies.push(...[...requiredInternalPackages].sort().map(
        (packageName) => `${packageName}@${packageVersions[packageName]}`,
      ));

      return {
        ...item,
        ...(dependencies.length > 0 ? { dependencies: [...new Set(dependencies)] } : { dependencies: undefined }),
        files,
        ...(contract ? {
          meta: {
            contract: `${contract.kind}@${contract.version}`,
            contractFingerprint: ARTIFACT_CONTRACT_FINGERPRINT,
            protocolRange: lockRecord.protocolRange,
            contractApiRange: lockRecord.contractApiRange,
            runtimeApiRange: lockRecord.runtimeApiRange,
            rendererApiRange: lockRecord.rendererApiRange,
            rendererBuildHash,
            rendererConformance: lockRecord.rendererConformance,
          },
        } : {}),
      };
    }),
  };
  assertRegistryItemClosures(generatedRegistry.items, generatedFiles, generatedImports);
  await Bun.write(join(generatedDirectory, "registry.json"), `${JSON.stringify(generatedRegistry, null, 2)}\n`);
}

if (import.meta.main) await prepareRegistry();
