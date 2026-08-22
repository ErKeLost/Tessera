import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  createInvocation,
  createStudioInvocation,
  findTesseraConfig,
  formatDoctor,
  inspectInstallation,
  packageRunner,
  parseCommand,
  parseItems,
  parseStudioCommand,
  registryBaseUrl,
  registryUrl,
  resolveBunExecutable,
  resolveStudioExecutable,
  resolveComponentsDirectory,
  resolveStudioConfig,
  resolveStudioEntry,
  run,
  sealInstallation,
  sha256,
  spawnStudio,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

async function createProject() {
  const directory = await mkdtemp(join(tmpdir(), "data-elements-cli-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "src", "vendor-components", "data-elements"), { recursive: true });
  await writeFile(join(directory, "components.json"), JSON.stringify({
    aliases: { components: "~/vendor-components" },
  }));
  return {
    directory,
    installRoot: join(directory, "src", "vendor-components", "data-elements"),
  };
}

async function createTesseraProject() {
  const directory = await mkdtemp(join(tmpdir(), "tessera-cli-"));
  temporaryDirectories.push(directory);
  const nestedDirectory = join(directory, "packages", "analytics", "scripts");
  const configPath = join(directory, "tessera.config.ts");
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(configPath, "export default {};\n");
  return { configPath, directory, nestedDirectory };
}

async function writeOfficialInstallation(
  project: Awaited<ReturnType<typeof createProject>>,
  options: { sealed?: boolean } = {},
) {
  const content = "export const renderer = true;\n";
  const files = {
    "renderer.tsx": {
      source: "packages/react/src/renderer.tsx",
      sha256: sha256(content),
    },
  };
  const dependencies = {
    "@data-elements/core": "0.1.0",
    "@data-elements/runtime": "0.1.0",
    "@data-elements/schema": "0.1.0",
  };
  const lock = {
    formatVersion: 2,
    protocolRange: ">=1.0 <3",
    contractApiRange: ">=0.1 <1",
    runtimeApiRange: ">=0.1 <1",
    rendererApiRange: ">=0.1 <1",
    dependencies,
    rendererBuildHash: sha256(canonicalJson({ dependencies, files })),
    rendererConformance: "official",
    files,
    ...(options.sealed === false ? {} : { installedFiles: ["renderer.tsx"] }),
  };
  await Promise.all([
    writeFile(join(project.installRoot, "renderer.tsx"), content),
    writeFile(join(project.installRoot, "data-elements.lock.json"), `${JSON.stringify(lock, null, 2)}\n`),
  ]);
}

describe("data-elements CLI", () => {
  test("installs artifact-ui by default", () => {
    expect(parseItems([])).toEqual(["artifact-ui"]);
    expect(parseCommand([])).toEqual({ command: "install", force: false, items: ["artifact-ui"] });
  });

  test("accepts components and an explicit force overwrite", () => {
    expect(parseItems(["add", "query-artifact", "metric-artifact", "query-artifact"]))
      .toEqual(["query-artifact", "metric-artifact"]);
    expect(parseCommand(["add", "query-artifact", "--force"])).toEqual({
      command: "install",
      force: true,
      items: ["query-artifact"],
    });
    expect(parseCommand(["doctor"])).toEqual({ command: "doctor" });
  });

  test("rejects commands, unsafe names, and force on doctor", () => {
    expect(() => parseItems(["remove", "query-artifact"])).toThrow();
    expect(() => parseItems(["add", "query-artifact;echo"])).toThrow();
    expect(() => parseItems(["add", "../query-artifact"])).toThrow();
    expect(() => parseCommand(["doctor", "--force"])).toThrow();
    expect(() => parseCommand(["--unknown"])).toThrow();
  });

  test("parses the Tessera Studio command with any supported database URL", () => {
    expect(parseCommand([
      "studio",
      "--config",
      "config/tessera.config.ts",
      "--host=127.0.0.1",
      "--port",
      "4310",
    ])).toEqual({
      command: "studio",
      configPath: "config/tessera.config.ts",
      host: "127.0.0.1",
      port: 4310,
    });
    expect(parseStudioCommand([])).toEqual({ command: "studio" });
    expect(parseStudioCommand(["--help"])).toEqual({ command: "studio", help: true });
    expect(parseStudioCommand(["postgresql://readonly:secret@localhost/warehouse", "--port", "4311"])).toEqual({
      command: "studio",
      databaseUrl: "postgresql://readonly:secret@localhost/warehouse",
      port: 4311,
    });
    expect(parseStudioCommand(["mysql://readonly:secret@localhost/warehouse"])).toEqual({
      command: "studio",
      databaseUrl: "mysql://readonly:secret@localhost/warehouse",
    });
    expect(parseStudioCommand(["mongodb://readonly:secret@localhost/warehouse"])).toEqual({
      command: "studio",
      databaseUrl: "mongodb://readonly:secret@localhost/warehouse",
    });
    expect(() => parseStudioCommand(["--database-url", "postgres://private"]))
      .toThrow("database-url positional");
    expect(parseStudioCommand(["sqlite:///tmp/warehouse.db"])).toEqual({
      command: "studio",
      databaseUrl: "sqlite:///tmp/warehouse.db",
    });
    expect(parseStudioCommand(["libsql://warehouse-example.turso.io"])).toEqual({
      command: "studio",
      databaseUrl: "libsql://warehouse-example.turso.io",
    });
    expect(() => parseStudioCommand(["postgresql://localhost/warehouse", "mysql://localhost/warehouse"]))
      .toThrow("at most one");
    expect(() => parseStudioCommand(["--port", "0"])).toThrow("1 through 65535");
    expect(() => parseStudioCommand(["--port", "65536"])).toThrow("1 through 65535");
    expect(() => parseStudioCommand(["--host", "127.0.0.1", "--host", "localhost"])).toThrow("only be passed once");
  });

  test("discovers tessera.config.ts upward and supports an explicit config path", async () => {
    const project = await createTesseraProject();
    expect(findTesseraConfig(project.nestedDirectory)).toBe(project.configPath);
    expect(resolveStudioConfig("./tessera.config.ts", project.directory)).toBe(project.configPath);
    expect(() => resolveStudioConfig("./missing.config.ts", project.directory)).toThrow("Could not find");
  });

  test("uses a source checkout first and an installed Studio package as a fallback", () => {
    const sourceEntry = "/repo/apps/studio/src/server.ts";
    expect(resolveStudioEntry({
      cliDirectory: "/repo/packages/cli",
      existsSync: (candidate: string) => candidate === sourceEntry,
    })).toBe(sourceEntry);

    const lookups: string[] = [];
    expect(resolveStudioEntry({
      cliDirectory: "/opt/tessera/cli",
      existsSync: () => false,
      resolvePackage: (specifier: string) => {
        lookups.push(specifier);
        if (specifier === "@tesserae/studio/main") return "/opt/tessera/studio/dist/main.mjs";
        throw new Error("not installed");
      },
    })).toBe("/opt/tessera/studio/dist/main.mjs");
    expect(lookups).toEqual(["@tesserae/studio/main"]);
  });

  test("spawns Studio through Bun without a shell and before components.json lookup", async () => {
    const project = await createTesseraProject();
    const calls: Array<[string, string[], Record<string, unknown>]> = [];
    const runner = (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push([command, args, options]);
      return { status: 0 };
    };
    const studioCommand = parseStudioCommand(["--host", "127.0.0.1", "--port", "4310"]);
    const spawned = spawnStudio(studioCommand, {
      cwd: project.directory,
      entry: "/workspace/apps/studio/src/server.ts",
      runner,
      runtime: "bun",
    });

    expect(spawned.invocation).toEqual({
      command: "bun",
      args: [
        "/workspace/apps/studio/src/server.ts",
        "--config",
        project.configPath,
        "--host",
        "127.0.0.1",
        "--port",
        "4310",
      ],
      options: { cwd: project.directory, shell: false, stdio: "inherit" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2].shell).toBe(false);

    expect(run(["studio"], {
      cwd: project.directory,
      entry: "/workspace/apps/studio/src/server.ts",
      runner,
      runtime: "bun",
    })).toBe(0);
    expect(calls).toHaveLength(2);
  });

  test("starts directly from a database URL when no config file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tessera-direct-url-"));
    temporaryDirectories.push(directory);
    const command = parseStudioCommand(["mysql://readonly:secret@localhost/warehouse"]);
    const invocation = createStudioInvocation(command, {
      cwd: directory,
      entry: "/workspace/apps/studio/src/main.ts",
      runtime: "bun",
    });

    expect(invocation.args).toEqual([
      "/workspace/apps/studio/src/main.ts",
      "mysql://readonly:secret@localhost/warehouse",
    ]);
  });

  test("uses Bun itself when invoked from Bun", () => {
    expect(resolveBunExecutable({
      env: {},
      execPath: "/Applications/Bun.app/Contents/MacOS/bun",
      versions: { bun: "1.3.14" },
    })).toBe("/Applications/Bun.app/Contents/MacOS/bun");
    expect(resolveBunExecutable({ env: {}, execPath: "/usr/bin/node", versions: {} })).toBe("bun");
    expect(resolveStudioExecutable({
      env: {},
      execPath: "/usr/local/bin/node",
      versions: { node: "24.16.0" },
    })).toBe("/usr/local/bin/node");
    expect(resolveStudioExecutable({
      env: {},
      execPath: "/usr/local/bin/node",
      versions: { node: "22.22.0" },
    })).toBe("bun");
  });

  test("selects the invoking package manager", () => {
    expect(packageRunner("bun/1.3.14 npm/? node/v24")).toEqual({
      command: "bunx",
      args: ["--bun"],
    });
    expect(packageRunner("pnpm/10.0.0 npm/? node/v24").command).toBe("pnpm");
    expect(packageRunner("").command).toBe("npx");
  });

  test("builds the public registry URL", () => {
    expect(registryUrl("query-artifact"))
      .toBe("https://data-elements.dev/r/query-artifact.json");
  });

  test("only accepts credential-free HTTPS or loopback registry URLs", () => {
    expect(registryBaseUrl("http://localhost:3000/r").toString())
      .toBe("http://localhost:3000/r/");
    expect(registryBaseUrl("http://127.0.0.1:3000/r").toString())
      .toBe("http://127.0.0.1:3000/r/");
    expect(registryBaseUrl("http://[::1]:3000/r").toString())
      .toBe("http://[::1]:3000/r/");
    expect(() => registryBaseUrl("file:///tmp/registry")).toThrow("HTTP or HTTPS");
    expect(() => registryBaseUrl("http://registry.example.com/r")).toThrow("HTTPS");
    expect(() => registryBaseUrl("https://user:secret@example.com/r")).toThrow("credentials");
    expect(() => registryBaseUrl("https://example.com/r?channel=next")).toThrow("query or fragment");
  });

  test("passes registry URLs without a shell and maps force to shadcn overwrite", () => {
    expect(createInvocation(["query-artifact"], "pnpm/10.0.0", undefined, { overwrite: true })).toEqual({
      command: "pnpm",
      args: [
        "dlx",
        "shadcn@4.17.0",
        "add",
        "https://data-elements.dev/r/query-artifact.json",
        "--overwrite",
      ],
    });
  });

  test("resolves standard shadcn aliases", () => {
    expect(resolveComponentsDirectory("/workspace/app", "~/vendor-components"))
      .toBe("/workspace/app/src/vendor-components");
    expect(resolveComponentsDirectory("/workspace/app", "@/ui"))
      .toBe("/workspace/app/src/ui");
    expect(resolveComponentsDirectory("/workspace/app", "components"))
      .toBe("/workspace/app/components");
  });

  test("recognizes an unchanged official installation", async () => {
    const project = await createProject();
    await writeOfficialInstallation(project);
    const report = inspectInstallation(project.directory);
    expect(report.status).toBe("official");
    expect(report.conformance).toBe("official");
    expect(report.filesChecked).toBe(1);
    expect(report.modifiedFiles).toEqual([]);
    expect(formatDoctor(report)).toContain("Status: official");
  });

  test("seals the exact installed source selection", async () => {
    const project = await createProject();
    await writeOfficialInstallation(project, { sealed: false });
    expect(inspectInstallation(project.directory).status).toBe("custom/unverified");
    const report = sealInstallation(project.directory);
    expect(report.status).toBe("official");
    expect(report.filesChecked).toBe(1);
  });

  test("marks changed locked files custom/unverified", async () => {
    const project = await createProject();
    await writeOfficialInstallation(project);
    await writeFile(join(project.installRoot, "renderer.tsx"), "export const renderer = 'custom';\n");
    const report = inspectInstallation(project.directory);
    expect(report.status).toBe("custom/unverified");
    expect(report.conformance).toBe("custom/unverified");
    expect(report.modifiedFiles).toEqual(["renderer.tsx"]);
    expect(formatDoctor(report)).toContain("Modified: renderer.tsx");
  });

  test("treats existing source without a lock as custom/unverified", async () => {
    const project = await createProject();
    await writeFile(join(project.installRoot, "renderer.tsx"), "export {};\n");
    const report = inspectInstallation(project.directory);
    expect(report.status).toBe("custom/unverified");
    expect(report.reasons[0]).toContain("lock.json is missing");
  });
});
