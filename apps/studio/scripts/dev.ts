import { resolve } from "node:path";

const studioRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(studioRoot, "../..");

const processes = [
  Bun.spawn(
    [
      "bun",
      "x",
      "turbo",
      "watch",
      "build",
      "--filter=@open-generative/mastra...",
      "--filter=@open-generative/ui...",
      "--output-logs=new-only",
    ],
    {
      cwd: workspaceRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  ),
  Bun.spawn(["bun", "run", "dev:vite"], {
    cwd: studioRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const process of processes) process.kill(signal);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const firstExit = await Promise.race(
  processes.map(async (process, index) => ({ index, code: await process.exited })),
);
if (!shuttingDown) {
  shuttingDown = true;
  for (const process of processes) process.kill("SIGTERM");
}

await Promise.all(processes.map((process) => process.exited));
process.exit(firstExit.code);
