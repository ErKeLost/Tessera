import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const generatedSource = /(?:\.d\.(?:ts|mts|cts)|\.(?:c|m)?js(?:\.map)?|\.(?:c|m)?ts\.map)$/;

async function find(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const values = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return find(path);
    return generatedSource.test(entry.name) ? [relative(root, path)] : [];
  }));
  return values.flat();
}

const packageEntries = await readdir(join(root, "packages"), { withFileTypes: true });
const violations = (await Promise.all(packageEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => find(join(root, "packages", entry.name, "src"))))).flat().sort();

if (violations.length > 0) throw new Error(["Generated build output found in source:", ...violations].join("\n"));
console.log("Verified package source directories contain no generated build output.");
