import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const packagesDirectory = join(root, "packages");
const declarationPattern = /\.d\.(?:ts|mts|cts)$/;

async function findGeneratedDeclarations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findGeneratedDeclarations(path);
    return declarationPattern.test(entry.name) ? [relative(root, path)] : [];
  }));
  return nested.flat();
}

const packageEntries = await readdir(packagesDirectory, { withFileTypes: true });
const sourceDirectories = packageEntries
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDirectory, entry.name, "src"));
const violations = (await Promise.all(sourceDirectories.map(async (directory) => {
  try {
    return await findGeneratedDeclarations(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}))).flat().sort();

if (violations.length > 0) {
  throw new Error([
    "Generated declaration files must never be written into package source directories.",
    ...violations.map((path) => `- ${path}`),
  ].join("\n"));
}

console.log("Verified package source directories contain no generated declarations.");
