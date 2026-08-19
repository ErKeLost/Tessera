import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const generatedDirectory = join(root, "registry", "generated");

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[relative(directory, path)] = await readFile(path, "utf8");
    }
  };
  await visit(directory);
  return result;
}

async function generate() {
  const child = Bun.spawn([process.execPath, join(root, "scripts", "prepare-registry.ts")], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Registry preparation failed with exit code ${exitCode}.`);
  return snapshot(generatedDirectory);
}

const first = await generate();
const second = await generate();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  const names = [...new Set([...Object.keys(first), ...Object.keys(second)])];
  const changed = names.filter((name) => first[name] !== second[name]);
  throw new Error(`Registry generation is not deterministic: ${changed.join(", ")}.`);
}

console.log(`Verified deterministic registry generation for ${Object.keys(second).length} files.`);
