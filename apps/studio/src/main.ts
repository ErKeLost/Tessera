import {
  withTesseraStudioOverrides,
} from "./config";
import { startTesseraStudioServer } from "./server";
import { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
import chalk from "chalk";

export { parseStudioCommandLine, resolveStudioConfig } from "./studio-command";
export type { StudioCommandLine } from "./studio-command";

export async function runTesseraStudioCli(): Promise<void> {
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
