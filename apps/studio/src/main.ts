import {
  withTesseraStudioOverrides,
} from "./config";
import { startTesseraStudioServer } from "./server";
import { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
import chalk from "chalk";

export { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
export type { StudioCommandLine } from "./studio-command";

async function main(): Promise<void> {
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
