import { resolve } from "node:path";

const studioRoot = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const apiPort = readPort(args) ?? 4317;
const bun = Bun.which("bun") ?? process.execPath;

const api = Bun.spawn({
  cmd: [bun, "--watch", "src/main.ts", ...args],
  cwd: studioRoot,
  env: process.env,
  stderr: "inherit",
  stdout: "inherit",
});

const client = Bun.spawn({
  // `bun x` is not a valid Bun subcommand. Running the local package binary
  // through `bun run` keeps Vite pinned to this workspace and avoids a stale
  // globally downloaded Vite process claiming the dev port without serving.
  cmd: [bun, "run", "vite", "--", "--host", "127.0.0.1", "--port", "4318"],
  cwd: studioRoot,
  env: {
    ...process.env,
    TESSERA_STUDIO_API_PORT: String(apiPort),
  },
  stderr: "inherit",
  stdout: "inherit",
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  api.kill();
  client.kill();
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

const [{ exitCode }] = await Promise.race([
  api.exited.then((exitCode) => [{ exitCode }]),
  client.exited.then((exitCode) => [{ exitCode }]),
]);

stop();
process.exitCode = exitCode;

function readPort(arguments_: readonly string[]): number | undefined {
  const index = arguments_.indexOf("--port");
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}
