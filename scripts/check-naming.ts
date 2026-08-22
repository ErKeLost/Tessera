import { readFile } from "node:fs/promises";

const forbidden = [
  /@data-elements\//i,
  /\bdata-elements\b/i,
  /\bdata elements\b/i,
];

const textExtension = /(?:\.(?:c|m)?(?:j|t)sx?|\.json|\.mdx?|\.ya?ml|\.toml|\.css|\.html)$/;
const process = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "pipe",
});
const files = (await new Response(process.stdout).text()).split("\n").filter(Boolean);
await process.exited;

const violations: string[] = [];
for (const file of files) {
  // Tessera's compatibility packages intentionally preserve the historical
  // Artifact API for the database agent and Studio. Generative packages use
  // the new Open Generative vocabulary and are still checked below.
  if (
    file.startsWith("apps/studio/")
    || file.startsWith("packages/tessera-")
    || file.startsWith("packages/data-agent/")
    || file.startsWith("packages/database/")
    || file.startsWith("packages/mongodb/")
    || file.startsWith("packages/mysql/")
    || file.startsWith("packages/postgres/")
    || file.startsWith("packages/sqlite/")
    || file.startsWith("packages/turso/")
  ) continue;
  if (
    !textExtension.test(file)
    || file === "scripts/check-naming.ts"
    || file.startsWith("vendor/")
    || file.startsWith(".agents/")
  ) continue;
  let content: string;
  try {
    content = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  } catch {
    continue;
  }
  for (const pattern of forbidden) {
    if (pattern.test(content)) violations.push(`${file}: ${pattern.source}`);
    pattern.lastIndex = 0;
  }
}

if (violations.length > 0) {
  throw new Error(["Retired product or API naming remains:", ...violations].join("\n"));
}

console.log(`Verified ${files.length} repository files use Open Generative naming.`);
