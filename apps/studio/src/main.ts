import {
  createTesseraConfigFromDatabaseUrl,
  createUnconfiguredTesseraConfig,
  TesseraConfigError,
  loadTesseraConfig,
  withTesseraDatabaseUrl,
  withTesseraStudioOverrides,
  inferTesseraDatabaseDialect,
  type LoadTesseraConfigOptions,
  type TesseraConfig,
  type TesseraStudioOverrides,
} from "./config";
import { startTesseraStudioServer } from "./server";
import chalk from "chalk";

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

export type StudioCommandLine = Readonly<{
  config: LoadTesseraConfigOptions;
  overrides: TesseraStudioOverrides;
  databaseUrl?: string;
}>;

export function parseStudioCommandLine(args: readonly string[]): StudioCommandLine {
  let file: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let databaseUrl: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      if (databaseUrl !== undefined) {
        throw new TesseraConfigError("Tessera Studio accepts at most one database URL.");
      }
      // Validate the scheme here, so calling src/main.ts directly has the
      // same database contract as the published `tessera studio` CLI.
      inferTesseraDatabaseDialect(argument);
      databaseUrl = argument;
      continue;
    }
    if (argument !== "--config" && argument !== "--host" && argument !== "--port") {
      throw new TesseraConfigError("Tessera Studio received an unsupported command-line option.");
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new TesseraConfigError(`Tessera Studio requires a value for ${argument}.`);
    }
    index += 1;
    if (argument === "--config") file = value;
    if (argument === "--host") host = value;
    if (argument === "--port") {
      const parsedPort = Number(value);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
        throw new TesseraConfigError("Tessera Studio requires --port to be an integer from 1 to 65535.");
      }
      port = parsedPort;
    }
  }

  return {
    config: file ? { file } : {},
    overrides: {
      ...(host === undefined ? {} : { host }),
      ...(port === undefined ? {} : { port }),
    },
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
  };
}

/**
 * Resolves a durable project config when present, but lets the positional URL
 * start an isolated local Studio without requiring a file on disk.
 */
export async function resolveStudioConfig(arguments_: StudioCommandLine): Promise<TesseraConfig> {
  try {
    const { config } = await loadTesseraConfig(arguments_.config);
    return arguments_.databaseUrl === undefined
      ? config
      : withTesseraDatabaseUrl(config, arguments_.databaseUrl);
  } catch (error) {
    if (arguments_.databaseUrl !== undefined && arguments_.config.file === undefined && isMissingDefaultConfig(error)) {
      return createTesseraConfigFromDatabaseUrl(arguments_.databaseUrl);
    }
    if (arguments_.databaseUrl === undefined
      && arguments_.config.file === undefined
      && !process.env.DATABASE_URL?.trim()
      && isOptionalDefaultConfigFailure(error)) {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (databaseUrl) return createTesseraConfigFromDatabaseUrl(databaseUrl);
      return createUnconfiguredTesseraConfig();
    }
    throw error;
  }
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

function isMissingDefaultConfig(error: unknown): boolean {
  return isTesseraConfigError(error)
    && error.message.startsWith("Tessera configuration was not found at ");
}

/**
 * A conventional project config is optional for Studio. If it is absent or
 * only contains unresolved environment placeholders, keep the server alive so
 * the browser settings flow can provide the database and model values.
 */
function isOptionalDefaultConfigFailure(error: unknown): boolean {
  if (isMissingDefaultConfig(error)) return true;
  if (!isTesseraConfigError(error)) return false;
  return error.message.startsWith("Tessera configuration could not be loaded from ")
    || error.message.includes(" is invalid.")
    || error.message.includes("must export a default config");
}

function isTesseraConfigError(error: unknown): error is TesseraConfigError {
  // Bundled Studio can load the config chunk through a separate module
  // instance, so relying on instanceof would reject an otherwise valid empty
  // first-run configuration.
  return error instanceof TesseraConfigError
    || (typeof error === "object" && error !== null
      && "name" in error && (error as { name?: unknown }).name === "TesseraConfigError"
      && "message" in error && typeof (error as { message?: unknown }).message === "string");
}

if (import.meta.main) {
  void main().catch(() => {
    // Deliberately do not print startup errors: they may include a database URL.
    console.error("Tessera Studio could not start. Check tessera.config.ts and the local database configuration.");
    process.exitCode = 1;
  });
}
