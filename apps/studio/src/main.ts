import {
  withTesseraStudioOverrides,
} from "./config";
import { startTesseraStudioServer } from "./server";
import { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
import chalk from "chalk";

export { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
export type { StudioCommandLine } from "./studio-command";

const STUDIO_HELP = `Usage: npx @open-tessera/studio [database-url] [--config <path>] [--host <host>] [--port <port>]

Starts Tessera Studio against PostgreSQL, MySQL, SQLite, Turso/libSQL, or MongoDB.

Options:
  database-url                          One supported database URL for this run
  --config <path>                       Path to a Tessera TypeScript config file
  --host <host>                         Host interface for the local server
  --port <port>                         TCP port from 1 through 65535
  -h, --help                            Show this help`;

export async function main(): Promise<void> {
  if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    console.log(STUDIO_HELP);
    return;
  }
  const arguments_ = parseStudioCommandLine(process.argv.slice(2));
  const studio = await startTesseraStudioServer(withTesseraStudioOverrides(await resolveStudioConfig(arguments_), arguments_.overrides));
  console.log(formatStudioStartupNotice(studio.url));

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await studio.close();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

/** A compact local terminal surface, separate from structured operational logs. */
export function formatStudioStartupNotice(url: string): string {
  const line = chalk.gray("\u2500".repeat(54));
  return [
    "",
    chalk.cyanBright.bold("  Tessera Studio is running"),
    line,
    `  ${chalk.greenBright("Local")}  ${chalk.underline.cyanBright(url)}`,
    `  ${chalk.gray("Open the URL above to configure and use this workspace.")}`,
    `  ${chalk.gray("Press Ctrl+C to stop the local server.")}`,
    line,
  ].join("\n");
}

if (import.meta.main) {
  void main().catch(() => {
    // Deliberately do not print startup errors: they may include a database URL.
    console.error("Tessera Studio could not start. Check tessera.config.ts and the local database configuration.");
    process.exitCode = 1;
  });
}
