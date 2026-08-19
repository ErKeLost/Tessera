import {
  createTesseraConfigFromDatabaseUrl,
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

async function main(): Promise<void> {
  const arguments_ = parseStudioCommandLine(process.argv.slice(2));
  const studio = await startTesseraStudioServer(withTesseraStudioOverrides(await resolveStudioConfig(arguments_), arguments_.overrides));

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
      && isMissingDefaultConfig(error)) {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (databaseUrl) return createTesseraConfigFromDatabaseUrl(databaseUrl);
    }
    throw error;
  }
}

function isMissingDefaultConfig(error: unknown): boolean {
  return error instanceof TesseraConfigError && error.message.startsWith("Tessera configuration was not found at ");
}

if (import.meta.main) {
  void main().catch(() => {
    // Deliberately do not print startup errors: they may include a database URL.
    console.error("Tessera Studio could not start. Check tessera.config.ts and the local database configuration.");
    process.exitCode = 1;
  });
}
