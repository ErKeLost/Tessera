import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

function command(commandName: string, args: string[]) {
  try {
    return execFileSync(commandName, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function firstDefined(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim() ?? "unknown";
}

function outputPath() {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex === -1 ? ".artifacts/build-provenance.json" : process.argv[outputIndex + 1];
  if (!output || isAbsolute(output) || output.split(/[\\/]/).includes("..")) {
    throw new Error("--output must be a relative path inside the repository.");
  }
  return resolve(process.cwd(), output);
}

const lockfile = await readFile("bun.lock");
const provenance = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    revision: firstDefined(
      process.env.GITHUB_SHA,
      process.env.COMMIT_REF,
      process.env.VERCEL_GIT_COMMIT_SHA,
      command("git", ["rev-parse", "HEAD"]),
    ),
    ref: firstDefined(
      process.env.GITHUB_REF_NAME,
      process.env.BRANCH,
      command("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    ),
  },
  toolchain: {
    bun: firstDefined(command("bun", ["--version"])),
    node: process.version,
  },
  lockfile: {
    path: "bun.lock",
    sha256: createHash("sha256").update(lockfile).digest("hex"),
  },
  submodules: (command("git", ["submodule", "status", "--recursive"]) ?? "")
    .split("\n")
    .filter(Boolean),
};

const output = outputPath();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(provenance, null, 2)}\n`);
