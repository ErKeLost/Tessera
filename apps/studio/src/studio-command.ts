import {
  createTesseraConfigFromDatabaseUrl,
  createUnconfiguredTesseraConfig,
  inferTesseraDatabaseDialect,
  loadTesseraConfig,
  TesseraConfigError,
  withTesseraDatabaseUrl,
  type LoadTesseraConfigOptions,
  type TesseraConfig,
  type TesseraStudioOverrides,
} from "./config";

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

/** Resolves project config while preserving Studio's settings-first startup. */
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
      && isOptionalDefaultConfigFailure(error)) {
      const databaseUrl = process.env.DATABASE_URL?.trim();
      if (databaseUrl) return createTesseraConfigFromDatabaseUrl(databaseUrl);
      return createUnconfiguredTesseraConfig();
    }
    throw error;
  }
}

function isMissingDefaultConfig(error: unknown): boolean {
  return isTesseraConfigError(error)
    && error.message.startsWith("Tessera configuration was not found at ");
}

function isOptionalDefaultConfigFailure(error: unknown): boolean {
  if (isMissingDefaultConfig(error)) return true;
  if (!isTesseraConfigError(error)) return false;
  return error.message.startsWith("Tessera configuration could not be loaded from ")
    || error.message.includes(" is invalid.")
    || error.message.includes("must export a default config");
}

function isTesseraConfigError(error: unknown): error is TesseraConfigError {
  return error instanceof TesseraConfigError
    || (typeof error === "object" && error !== null
      && "name" in error && (error as { name?: unknown }).name === "TesseraConfigError"
      && "message" in error && typeof (error as { message?: unknown }).message === "string");
}
