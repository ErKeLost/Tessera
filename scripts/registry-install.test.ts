import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { rewriteRegistryDependencies } from "../apps/docs/src/app/r/[name]/route";

const root = join(import.meta.dir, "..");
const registryDirectory = join(root, "apps", "docs", ".registry");
const cliPath = join(root, "packages", "cli", "index.js");
const shadcnPath = join(root, "node_modules", "shadcn", "dist", "index.js");
const temporaryDirectories: string[] = [];
const requests: string[] = [];

let server: ReturnType<typeof Bun.serve>;
let registryBaseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      if (!/^\/r\/[a-z0-9-]+\.json$/.test(url.pathname)) {
        return new Response("Not found", { status: 404 });
      }

      try {
        const content = await readFile(join(registryDirectory, basename(url.pathname)), "utf8");
        const payload = rewriteRegistryDependencies(JSON.parse(content), url.origin);
        return Response.json(payload);
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  });
  registryBaseUrl = `http://127.0.0.1:${server.port}/r/`;
});

afterAll(async () => {
  server.stop(true);
  await Promise.all(temporaryDirectories.map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

async function createHostProject() {
  const directory = await mkdtemp(join(tmpdir(), "data-elements-install-"));
  temporaryDirectories.push(directory);

  await Promise.all([
    mkdir(join(directory, "bin"), { recursive: true }),
    mkdir(join(directory, "src"), { recursive: true }),
    mkdir(join(directory, "node_modules", "@data-elements"), { recursive: true }),
    mkdir(join(directory, "node_modules", "@radix-ui"), { recursive: true }),
    mkdir(join(directory, "node_modules", "@types"), { recursive: true }),
  ]);
  const dependencyLinks = [
    [join(root, "packages", "react", "node_modules", "react"), join(directory, "node_modules", "react")],
    [join(root, "packages", "react", "node_modules", "react-dom"), join(directory, "node_modules", "react-dom")],
    [join(root, "packages", "react", "node_modules", "recharts"), join(directory, "node_modules", "recharts")],
    [join(root, "packages", "react", "node_modules", "lucide-react"), join(directory, "node_modules", "lucide-react")],
    [join(root, "packages", "react", "node_modules", "@radix-ui", "react-tabs"), join(directory, "node_modules", "@radix-ui", "react-tabs")],
    [join(root, "packages", "schema", "node_modules", "zod"), join(directory, "node_modules", "zod")],
    [join(root, "packages", "react", "node_modules", "@types", "react"), join(directory, "node_modules", "@types", "react")],
    [join(root, "packages", "react", "node_modules", "@types", "react-dom"), join(directory, "node_modules", "@types", "react-dom")],
  ] as const;
  await Promise.all(dependencyLinks.map(async ([source, target]) => symlink(await realpath(source), target)));
  await Promise.all([
    mkdir(join(directory, "node_modules", "@data-elements", "core"), { recursive: true }),
    mkdir(join(directory, "node_modules", "@data-elements", "runtime"), { recursive: true }),
    mkdir(join(directory, "node_modules", "@data-elements", "schema"), { recursive: true }),
  ]);
  await Promise.all([
    cp(
      join(root, "packages", "core", "dist"),
      join(directory, "node_modules", "@data-elements", "core", "dist"),
      { recursive: true },
    ),
    cp(
      join(root, "packages", "core", "package.json"),
      join(directory, "node_modules", "@data-elements", "core", "package.json"),
    ),
    cp(
      join(root, "packages", "runtime", "dist"),
      join(directory, "node_modules", "@data-elements", "runtime", "dist"),
      { recursive: true },
    ),
    cp(
      join(root, "packages", "runtime", "package.json"),
      join(directory, "node_modules", "@data-elements", "runtime", "package.json"),
    ),
    cp(
      join(root, "packages", "schema", "dist"),
      join(directory, "node_modules", "@data-elements", "schema", "dist"),
      { recursive: true },
    ),
    cp(
      join(root, "packages", "schema", "package.json"),
      join(directory, "node_modules", "@data-elements", "schema", "package.json"),
    ),
  ]);
  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify({
      name: "data-elements-install-host",
      private: true,
      dependencies: {
        "@radix-ui/react-tabs": "1.1.21",
        "@data-elements/core": "0.1.0",
        "@data-elements/runtime": "0.1.0",
        "@data-elements/schema": "0.1.0",
        "lucide-react": "1.31.0",
        react: "19.2.8",
        "react-dom": "19.2.8",
        recharts: "3.10.1",
        zod: "4.4.3",
      },
      devDependencies: { tailwindcss: "4.3.3" },
    }, null, 2)),
    writeFile(join(directory, "package-lock.json"), "{}\n"),
    writeFile(join(directory, "vite.config.ts"), "export default {}\n"),
    writeFile(join(directory, "src", "index.css"), '@import "tailwindcss";\n'),
    writeFile(join(directory, "src", "global.d.ts"), 'declare module "*.css";\n'),
    writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: { "~/*": ["./src/*"] },
        target: "ES2022",
      },
      include: ["src"],
    }, null, 2)),
    writeFile(join(directory, "components.json"), JSON.stringify({
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      rsc: false,
      tsx: true,
      tailwind: {
        config: "",
        css: "src/index.css",
        baseColor: "",
        cssVariables: true,
        prefix: "",
      },
      aliases: {
        components: "~/vendor-components",
        hooks: "~/shared/hooks",
        lib: "~/shared/lib",
        ui: "~/shared/ui",
        utils: "~/shared/lib/utils",
      },
      iconLibrary: "lucide",
    }, null, 2)),
  ]);

  const invocationLog = join(directory, "invocation.json");
  const npmLog = join(directory, "npm.json");
  const npxShim = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(process.env.INVOCATION_LOG, JSON.stringify(args));
if (args[0] !== "-y" || args[1] !== "shadcn@4.17.0") process.exit(91);
const result = spawnSync(process.execPath, [process.env.SHADCN_PATH, ...args.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;
  const npmShim = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.NPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`;
  await Promise.all([
    writeFile(join(directory, "bin", "npx"), npxShim),
    writeFile(join(directory, "bin", "npm"), npmShim),
  ]);
  await Promise.all([
    chmod(join(directory, "bin", "npx"), 0o755),
    chmod(join(directory, "bin", "npm"), 0o755),
  ]);

  return { directory, invocationLog, npmLog };
}

async function executeCli(
  host: Awaited<ReturnType<typeof createHostProject>>,
  args: string[] = [],
  expectedExitCode = 0,
) {
  const processHandle = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: host.directory,
    env: {
      ...process.env,
      ALL_PROXY: "",
      CI: "1",
      DATA_ELEMENTS_REGISTRY_URL: registryBaseUrl,
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      INVOCATION_LOG: host.invocationLog,
      NO_PROXY: "127.0.0.1,localhost",
      NPM_LOG: host.npmLog,
      PATH: `${join(host.directory, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      SHADCN_PATH: shadcnPath,
      npm_config_user_agent: "npm/11.0.0 node/v24.0.0",
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [exitCode, stderr, stdout] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
    new Response(processHandle.stdout).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(expectedExitCode);
  return { stderr, stdout };
}

async function runCli(args: string[] = []) {
  const host = await createHostProject();
  await executeCli(host, args);
  return host;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return (await listFiles(path)).map((name) => join(entry.name, name));
    }
    return [entry.name];
  }));
  return nested.flat().sort();
}

async function resolveRelativeImports(installRoot: string, files: string[]) {
  const sourceFiles = files.filter((file) => [".ts", ".tsx"].includes(extname(file)));
  const resolvedRoot = await realpath(installRoot);

  for (const file of sourceFiles) {
    const path = join(installRoot, file);
    const content = await readFile(path, "utf8");
    const transpiler = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" });
    const imports = transpiler.scanImports(content)
      .map(({ path: importedPath }) => importedPath)
      .filter((importedPath) => importedPath.startsWith("."));

    for (const imported of imports) {
      const base = resolve(dirname(path), imported);
      const candidates = extname(base)
        ? [base]
        : [base, ...[".ts", ".tsx", ".js", ".jsx", ".css"].map((extension) => `${base}${extension}`),
          ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => join(base, `index${extension}`))];
      let resolvedImport: string | undefined;
      for (const candidate of candidates) {
        try {
          resolvedImport = await realpath(candidate);
          break;
        } catch {
          // Try the next supported source extension.
        }
      }
      expect(resolvedImport, `${file}: ${imported}`).toBeDefined();
      expect(relative(resolvedRoot, resolvedImport!).startsWith(".."), `${file}: ${imported}`).toBe(false);
    }
  }
}

async function assertCompleteInstallation(host: Awaited<ReturnType<typeof createHostProject>>) {
  const installRoot = join(host.directory, "src", "vendor-components", "data-elements");
  const files = await listFiles(installRoot);
  const published = JSON.parse(await readFile(join(registryDirectory, "all.json"), "utf8"));
  const expectedFiles = published.files.map((file: { target: string }) => (
    file.target.replace(/^@components\/data-elements\//, "")
  )).sort();
  expect(files).toEqual(expectedFiles);
  expect(files).toContain("data-elements.lock.json");
  expect(files).toContain("styles.css");
  expect(files).toContain("primitives.tsx");
  expect(files).not.toContain("schema.ts");
  expect(files).not.toContain("core.ts");
  expect(files).not.toContain("runtime.ts");
  expect(await readdir(join(host.directory, "src"))).not.toContain("components");

  const contents = await Promise.all(files.map((file) => readFile(join(installRoot, file), "utf8")));
  const internalImports = [...contents.join("\n").matchAll(/(?:from\s+["']|import\s*["'])(@data-elements\/[^"']+)/g)]
    .map((match) => match[1]);
  expect(new Set(internalImports)).toEqual(new Set([
    "@data-elements/core",
    "@data-elements/runtime",
    "@data-elements/schema",
  ]));
  expect(contents.join("\n")).not.toMatch(/@data-elements\/(?:capability-broker|compiler|resources)/);
  const lock = JSON.parse(await readFile(join(installRoot, "data-elements.lock.json"), "utf8"));
  expect(lock.installedFiles).toEqual(Object.keys(lock.files).sort());
  expect(Object.values(lock.files).every((file: any) => file.source.startsWith("packages/react/src/"))).toBe(true);
  await writeFile(join(host.directory, "src", "golden-path.ts"), `
import {
  ArtifactRenderer,
  ArtifactUIProvider,
  type ArtifactDocument,
  type ArtifactPart,
  type ArtifactRendererProps,
  type ArtifactUIProviderProps,
} from "~/vendor-components/data-elements/artifact-ui";

export const artifactUi = { ArtifactRenderer, ArtifactUIProvider };
export type ArtifactUIValue = ArtifactPart | ArtifactDocument;
export type ArtifactUIProps = ArtifactRendererProps<ArtifactUIValue> | ArtifactUIProviderProps;
`);
  const primitives = await readFile(join(installRoot, "primitives.tsx"), "utf8");
  expect(primitives.match(/import "\.\/styles\.css";/g)?.length).toBe(1);
  await resolveRelativeImports(installRoot, files);

  const typecheck = Bun.spawn([join(root, "node_modules", ".bin", "tsc"), "--noEmit", "-p", host.directory], {
    cwd: host.directory,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [typecheckExit, typecheckStderr, typecheckStdout] = await Promise.all([
    typecheck.exited,
    new Response(typecheck.stderr).text(),
    new Response(typecheck.stdout).text(),
  ]);
  expect(typecheckExit, `${typecheckStdout}\n${typecheckStderr}`).toBe(0);

  const build = await Bun.build({
    entrypoints: [join(installRoot, "artifact-ui.tsx")],
    outdir: join(host.directory, "dist"),
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    minify: true,
    naming: "artifact-ui.[ext]",
    target: "browser",
  });
  expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true);
  const browserOutput = build.outputs.find((output) => output.path.endsWith("artifact-ui.js"));
  expect(browserOutput).toBeDefined();
  const browserBundle = await browserOutput!.text();
  expect(browserBundle).not.toMatch(/@data-elements\/(?:capability-broker|compiler|resources)/);
  expect(browserBundle).not.toMatch(/node:(?:fs|child_process|worker_threads)/);

  expect(JSON.parse(await readFile(host.invocationLog, "utf8")).slice(0, 4)).toEqual([
    "-y", "shadcn@4.17.0", "add", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/r\//),
  ]);
  return files;
}

describe("published registry installation", () => {
  test("the CLI installs all source into a custom components alias", async () => {
    const host = await runCli();
    await assertCompleteInstallation(host);
  }, 30_000);

  test("the compatibility item resolves recursively to the same installation", async () => {
    const requestOffset = requests.length;
    const host = await runCli(["add", "data-elements"]);
    await assertCompleteInstallation(host);
    expect(requests.slice(requestOffset)).toContain("/r/data-elements.json");
    expect(requests.slice(requestOffset)).toContain("/r/all.json");
  }, 30_000);

  test("artifact-renderer installs the v2 form and surface renderer closure", async () => {
    const host = await runCli(["add", "artifact-renderer"]);
    const installRoot = join(host.directory, "src", "vendor-components", "data-elements");
    const files = await listFiles(installRoot);
    expect(files).toContain("renderer.tsx");
    expect(files).toContain("node-types.ts");
    expect(files).toContain("surface-nodes.tsx");
    expect(files).toContain("form-nodes.tsx");
    expect(files).toContain("primitives.tsx");
    expect(files).toContain("styles.css");
    await resolveRelativeImports(installRoot, files);
    const doctor = await executeCli(host, ["doctor"]);
    expect(doctor.stdout).toContain("Status: official");
  }, 30_000);

  test("single-component installs keep a sealed union lock across updates", async () => {
    const host = await runCli(["add", "query-artifact"]);
    const installRoot = join(host.directory, "src", "vendor-components", "data-elements");
    let lock = JSON.parse(await readFile(join(installRoot, "data-elements.lock.json"), "utf8"));
    expect(lock.installedFiles).toContain("query-artifact.tsx");
    expect(lock.installedFiles).not.toContain("metric-artifact.tsx");
    expect(lock.installedFiles).not.toContain("artifact-ui.tsx");
    expect((await executeCli(host, ["doctor"])).stdout).toContain("Status: official");

    await executeCli(host, ["add", "metric-artifact"]);
    lock = JSON.parse(await readFile(join(installRoot, "data-elements.lock.json"), "utf8"));
    expect(lock.installedFiles).toContain("query-artifact.tsx");
    expect(lock.installedFiles).toContain("metric-artifact.tsx");
    expect((await executeCli(host, ["doctor"])).stdout).toContain("Status: official");

    const queryPath = join(installRoot, "query-artifact.tsx");
    await writeFile(queryPath, `${await readFile(queryPath, "utf8")}\n// customized query\n`);
    await rm(host.invocationLog, { force: true });
    expect((await executeCli(host, ["add", "query-artifact"], 1)).stderr).toContain("custom/unverified");
    expect(existsSync(host.invocationLog)).toBe(false);

    await executeCli(host, ["add", "query-artifact", "--force"]);
    expect(await readFile(queryPath, "utf8")).not.toContain("customized query");
    expect((await executeCli(host, ["doctor"])).stdout).toContain("Status: official");
  }, 60_000);

  test("blocks customized files, reports them with doctor, and only force-overwrites explicitly", async () => {
    const host = await runCli();
    await executeCli(host);
    expect(JSON.parse(await readFile(host.invocationLog, "utf8"))).toContain("--overwrite");

    const rendererPath = join(host.directory, "src", "vendor-components", "data-elements", "renderer.tsx");
    await writeFile(rendererPath, `${await readFile(rendererPath, "utf8")}\n// local customization\n`);

    const doctor = await executeCli(host, ["doctor"], 1);
    expect(doctor.stdout).toContain("Status: custom/unverified");
    expect(doctor.stdout).toContain("Modified: renderer.tsx");

    await rm(host.invocationLog, { force: true });
    const blocked = await executeCli(host, [], 1);
    expect(blocked.stderr).toContain("custom/unverified");
    expect(blocked.stderr).toContain("not a three-way merge");
    expect(existsSync(host.invocationLog)).toBe(false);

    const forced = await executeCli(host, ["--force"]);
    expect(forced.stderr).toContain("not a three-way merge");
    expect(JSON.parse(await readFile(host.invocationLog, "utf8"))).toContain("--overwrite");
    expect(await readFile(rendererPath, "utf8")).not.toContain("local customization");

    const repaired = await executeCli(host, ["doctor"]);
    expect(repaired.stdout).toContain("Status: official");
  }, 60_000);
});
