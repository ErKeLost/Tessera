import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const outputDirectory = await mkdtemp(join(tmpdir(), "open-generative-release-check-"));
const releaseManifestPath = join(outputDirectory, "release-manifest.json");

type PackedReleaseManifest = Readonly<{
  packages: readonly Readonly<{
    name: string;
    tarballPath: string;
  }>[];
}>;

async function run(arguments_: string[], cwd = root): Promise<void> {
  const subprocess = Bun.spawn(arguments_, {
    cwd,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`${arguments_.join(" ")} exited with code ${exitCode}.`);
}

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a Studio smoke-test port.");
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function installPackedRelease(manifestPath: string): Promise<string> {
  const release = JSON.parse(await readFile(manifestPath, "utf8")) as PackedReleaseManifest;
  if (!Array.isArray(release.packages) || release.packages.length === 0) {
    throw new Error("Packed release manifest contains no packages for the CLI smoke test.");
  }

  const smokeDirectory = join(outputDirectory, "studio-cli-smoke");
  const workspaceDirectory = join(smokeDirectory, "packages");
  await mkdir(workspaceDirectory, { recursive: true });
  for (const [index, releasePackage] of release.packages.entries()) {
    const packageDirectory = join(workspaceDirectory, String(index));
    await mkdir(packageDirectory);
    await run([
      "tar",
      "-xzf",
      resolve(outputDirectory, releasePackage.tarballPath),
      "--strip-components=1",
      "-C",
      packageDirectory,
    ], smokeDirectory);
  }
  await writeFile(join(smokeDirectory, "package.json"), `${JSON.stringify({
    name: "tessera-studio-cli-smoke",
    private: true,
    workspaces: ["packages/*"],
    dependencies: { "@open-tessera/studio": "workspace:*" },
  }, null, 2)}\n`, "utf8");
  await run(["bun", "install", "--ignore-scripts"], smokeDirectory);
  return smokeDirectory;
}

async function waitForStudio(port: number, subprocess: Bun.Subprocess): Promise<void> {
  const healthUrl = `http://127.0.0.1:${port}/health`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (subprocess.exitCode !== null) break;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = await response.json() as { status?: unknown; service?: unknown; readiness?: unknown };
        if (body.status === "ok" && body.service === "tessera-studio" && body.readiness === "ready") return;
      }
    } catch {
      // Installation and process startup are bounded by the loop deadline.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Packed Tessera Studio CLI did not become ready at ${healthUrl}.`);
}

async function stopStudio(subprocess: Bun.Subprocess): Promise<void> {
  if (subprocess.exitCode === null) subprocess.kill("SIGTERM");
  await subprocess.exited;
}

async function smokeTestStudioCli(smokeDirectory: string): Promise<void> {
  const port = await findAvailablePort();
  const executable = join(smokeDirectory, "node_modules", ".bin", "studio");
  const subprocess = Bun.spawn([executable, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: smokeDirectory,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();

  try {
    await waitForStudio(port, subprocess);
  } catch (error) {
    await stopStudio(subprocess);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    throw new Error([
      error instanceof Error ? error.message : String(error),
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join("\n"));
  }

  await stopStudio(subprocess);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (!stdout.includes("Tessera Studio is running")) {
    throw new Error(`Packed Studio CLI omitted its startup notice.\n${stdout.trim()}\n${stderr.trim()}`);
  }
  console.log("Started the packed Tessera Studio CLI and verified its health endpoint.");
}

try {
  await run([
    "bun",
    "scripts/release-stage.ts",
    "--version",
    rootManifest.version,
    "--output",
    outputDirectory,
  ]);
  await run([
    "bun",
    "scripts/release-publish.ts",
    "--manifest",
    releaseManifestPath,
    "--verify-only",
  ]);
  await smokeTestStudioCli(await installPackedRelease(releaseManifestPath));
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
