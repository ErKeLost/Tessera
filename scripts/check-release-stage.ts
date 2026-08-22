import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const outputDirectory = await mkdtemp(join(tmpdir(), "open-generative-release-check-"));

async function run(arguments_: string[]): Promise<void> {
  const subprocess = Bun.spawn(arguments_, {
    cwd: root,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(`${arguments_.join(" ")} exited with code ${exitCode}.`);
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
    join(outputDirectory, "release-manifest.json"),
    "--verify-only",
  ]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
