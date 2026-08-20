#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } = require("node:fs");
const { dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { version } = require("./package.json");

const DEFAULT_REGISTRY_BASE_URL = "https://data-elements.dev/r/";
const SHADCN_PACKAGE = "shadcn@4.17.0";
const TESSERA_CONFIG_FILE = "tessera.config.ts";
const ITEM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ALLOWED_BROWSER_PACKAGES = new Set([
  "@data-elements/schema",
  "@data-elements/core",
  "@data-elements/runtime",
]);
const HELP = `Usage: data-elements [add <component...>] [--force]
       data-elements doctor
       tessera studio [database-url] [--config <path>] [--host <host>] [--port <port>]

Commands:
  data-elements                         Install artifact-ui (the complete catalog)
  data-elements add <component...>      Install one or more components
  data-elements doctor                  Verify the installed lock and source hashes
  tessera studio                           Start Tessera Studio with a configured database

Options:
  --force                               Overwrite local files; this is not a three-way merge
  -h, --help                            Show this help
  -v, --version                         Show the installed version`;

const STUDIO_HELP = `Usage: tessera studio [database-url] [--config <path>] [--host <host>] [--port <port>]

Starts Tessera Studio against a configured PostgreSQL or MySQL database.

Options:
  database-url                          One PostgreSQL or MySQL URL for this run
  --config <path>                       Path to a Tessera TypeScript config file
  --host <host>                         Host interface for the local server
  --port <port>                         TCP port from 1 through 65535

Provide a database URL or let Tessera search upward from the current directory
for ${TESSERA_CONFIG_FILE}. A trailing URL overrides database.url only for this
run; the config remains the default place for durable connection settings.
Model keys stay server-only in environment variables or ${TESSERA_CONFIG_FILE}.`;

function packageRunner(userAgent = "") {
  if (userAgent.includes("pnpm")) return { command: "pnpm", args: ["dlx"] };
  if (userAgent.includes("yarn")) return { command: "yarn", args: ["dlx"] };
  if (userAgent.includes("bun")) return { command: "bunx", args: ["--bun"] };
  return { command: "npx", args: ["-y"] };
}

function parseItems(args) {
  if (args.length === 0) return ["artifact-ui"];
  if (args[0] !== "add") {
    throw new Error('Expected "add <component...>", "doctor", "studio", or no arguments.');
  }

  const items = args.slice(1);
  if (items.length === 0) throw new Error("Pass at least one component name.");

  for (const item of items) {
    if (!ITEM_PATTERN.test(item)) {
      throw new Error(`Invalid component name: ${item}`);
    }
  }
  return [...new Set(items)];
}

function parseStudioValue(option, value) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${option} requires a non-empty value.`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${option} requires a value, not another option.`);
  }
  return value.trim();
}

function parseStudioPort(value) {
  const port = parseStudioValue("--port", value);
  if (!/^[1-9]\d{0,4}$/.test(port)) {
    throw new Error("--port must be an integer from 1 through 65535.");
  }
  const parsed = Number(port);
  if (parsed > 65535) {
    throw new Error("--port must be an integer from 1 through 65535.");
  }
  return parsed;
}

function parseStudioDatabaseUrl(value) {
  const raw = parseStudioValue("database-url", value);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("database-url must be a valid PostgreSQL or MySQL connection URL.");
  }
  if (!new Set(["postgres:", "postgresql:", "mysql:"]).has(url.protocol.toLowerCase())) {
    throw new Error("database-url must use a PostgreSQL or MySQL URL scheme.");
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error("database-url must include a host and database name.");
  }
  return raw;
}

function parseStudioCommand(args) {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    return { command: "studio", help: true };
  }

  const command = { command: "studio" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let option;
    let value;

    if (["--config", "--host", "--port"].includes(argument)) {
      option = argument;
      value = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--config=")) {
      option = "--config";
      value = argument.slice("--config=".length);
    } else if (argument.startsWith("--host=")) {
      option = "--host";
      value = argument.slice("--host=".length);
    } else if (argument.startsWith("--port=")) {
      option = "--port";
      value = argument.slice("--port=".length);
    } else if (argument.startsWith("--")) {
      throw new Error("studio only accepts a database-url positional argument plus --config, --host, and --port.");
    } else {
      if (command.databaseUrl !== undefined) {
        throw new Error("studio accepts at most one database-url positional argument.");
      }
      command.databaseUrl = parseStudioDatabaseUrl(argument);
      continue;
    }

    if (option === "--config") {
      if (command.configPath !== undefined) throw new Error("--config can only be passed once.");
      command.configPath = parseStudioValue(option, value);
    } else if (option === "--host") {
      if (command.host !== undefined) throw new Error("--host can only be passed once.");
      command.host = parseStudioValue(option, value);
    } else {
      if (command.port !== undefined) throw new Error("--port can only be passed once.");
      command.port = parseStudioPort(value);
    }
  }
  return command;
}

function parseCommand(args) {
  if (args[0] === "studio") return parseStudioCommand(args.slice(1));

  const force = args.includes("--force");
  const positional = args.filter((arg) => arg !== "--force");
  const unknownOption = positional.find((arg) => arg.startsWith("-"));
  if (unknownOption) throw new Error(`Unknown option: ${unknownOption}`);

  if (positional[0] === "doctor") {
    if (positional.length !== 1 || force) throw new Error("doctor does not accept arguments or --force.");
    return { command: "doctor" };
  }
  return { command: "install", force, items: parseItems(positional) };
}

function registryBaseUrl(value = process.env.DATA_ELEMENTS_REGISTRY_URL || DEFAULT_REGISTRY_BASE_URL) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Registry URL must use HTTP or HTTPS.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("Registry URL must use HTTPS unless it points to localhost.");
  }
  if (url.username || url.password) {
    throw new Error("Registry URL must not contain credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("Registry URL must not contain a query or fragment.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function registryUrl(item, baseUrl) {
  if (!ITEM_PATTERN.test(item)) throw new Error(`Invalid component name: ${item}`);
  return new URL(`${item}.json`, registryBaseUrl(baseUrl)).toString();
}

function createInvocation(items, userAgent = "", baseUrl, options = {}) {
  const runner = packageRunner(userAgent);
  return {
    command: runner.command,
    args: [
      ...runner.args,
      SHADCN_PACKAGE,
      "add",
      ...items.map((item) => registryUrl(item, baseUrl)),
      ...(options.overwrite ? ["--overwrite"] : []),
    ],
  };
}

function canonicalJson(value) {
  const stack = new WeakSet();
  const serialize = (current) => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Canonical JSON cannot encode non-finite numbers.");
      return Object.is(current, -0) ? "0" : JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (stack.has(current)) throw new TypeError("Canonical JSON cannot encode cyclic arrays.");
      stack.add(current);
      const result = `[${current.map((item) => serialize(item)).join(",")}]`;
      stack.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (stack.has(current)) throw new TypeError("Canonical JSON cannot encode cyclic objects.");
      stack.add(current);
      const entries = Object.keys(current).sort().map((key) => {
        if (current[key] === undefined) throw new TypeError(`Canonical JSON cannot encode undefined at "${key}".`);
        return `${JSON.stringify(key)}:${serialize(current[key])}`;
      });
      stack.delete(current);
      return `{${entries.join(",")}}`;
    }
    throw new TypeError(`Canonical JSON cannot encode ${typeof current}.`);
  };
  return serialize(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function findTesseraConfig(startDirectory = process.cwd()) {
  let directory = resolve(startDirectory);
  if (existsSync(directory) && statSync(directory).isFile()) directory = dirname(directory);

  while (true) {
    const candidate = join(directory, TESSERA_CONFIG_FILE);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find ${TESSERA_CONFIG_FILE} in this directory or any parent directory.`);
}

function resolveStudioConfig(configPath, startDirectory = process.cwd()) {
  if (configPath === undefined) return findTesseraConfig(startDirectory);
  const candidate = isAbsolute(configPath)
    ? resolve(configPath)
    : resolve(startDirectory, configPath);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(`Could not find the Tessera config file at ${candidate}.`);
  }
  return candidate;
}

function findOptionalTesseraConfig(startDirectory = process.cwd()) {
  try {
    return findTesseraConfig(startDirectory);
  } catch {
    return undefined;
  }
}

function studioEntryCandidates(cliDirectory = __dirname) {
  return [
    resolve(cliDirectory, "../../apps/studio/src/main.ts"),
    resolve(cliDirectory, "../../apps/studio/src/server.ts"),
    join(cliDirectory, "studio", "main.mjs"),
    join(cliDirectory, "studio", "main.js"),
    join(cliDirectory, "studio", "server.mjs"),
    join(cliDirectory, "studio", "server.js"),
    join(cliDirectory, "dist", "main.mjs"),
    join(cliDirectory, "dist", "main.js"),
    join(cliDirectory, "dist", "studio", "server.mjs"),
    join(cliDirectory, "dist", "studio", "server.js"),
  ];
}

function resolveStudioEntry(options = {}) {
  const cliDirectory = options.cliDirectory ?? __dirname;
  const fileExists = options.existsSync ?? existsSync;
  for (const candidate of options.candidates ?? studioEntryCandidates(cliDirectory)) {
    if (fileExists(candidate)) return candidate;
  }

  const resolvePackage = options.resolvePackage ?? ((specifier) => require.resolve(specifier, {
    paths: [cliDirectory],
  }));
  for (const specifier of [
    "@data-elements/studio/main",
    "@data-elements/studio/server",
  ]) {
    try {
      return resolvePackage(specifier);
    } catch {}
  }
  throw new Error("Could not find the Tessera Studio server. Reinstall data-elements so its @data-elements/studio dependency is present, or run this command from a Tessera source checkout.");
}

function resolveBunExecutable(processLike = process) {
  if (processLike.versions?.bun && typeof processLike.execPath === "string" && processLike.execPath.length > 0) {
    return processLike.execPath;
  }
  const configured = processLike.env?.BUN_EXECUTABLE;
  if (typeof configured === "string" && configured.trim() !== "" && !configured.includes("\0")) {
    return configured;
  }
  return "bun";
}

function createStudioInvocation(command, options = {}) {
  if (!command || command.command !== "studio") {
    throw new Error("Expected a parsed studio command.");
  }
  const cwd = options.cwd ?? process.cwd();
  const configPath = command.configPath === undefined && command.databaseUrl !== undefined
    ? findOptionalTesseraConfig(cwd)
    : resolveStudioConfig(command.configPath, cwd);
  const entry = options.entry ?? resolveStudioEntry(options);
  const runtime = options.runtime ?? resolveBunExecutable(options.processLike ?? process);
  const args = [entry];
  if (command.databaseUrl !== undefined) args.push(command.databaseUrl);
  if (configPath !== undefined) args.push("--config", configPath);
  if (command.host !== undefined) args.push("--host", command.host);
  if (command.port !== undefined) args.push("--port", String(command.port));
  return {
    command: runtime,
    args,
    options: {
      cwd,
      shell: false,
      stdio: "inherit",
    },
  };
}

function spawnStudio(command, options = {}) {
  const invocation = createStudioInvocation(command, options);
  const runner = options.runner ?? spawnSync;
  return {
    invocation,
    result: runner(invocation.command, invocation.args, invocation.options),
  };
}

function runStudio(command, options = {}) {
  let spawned;
  try {
    spawned = spawnStudio(command, options);
  } catch (error) {
    console.error(`tessera: ${error.message}`);
    return 1;
  }

  if (spawned.result.error) {
    const message = spawned.result.error.code === "ENOENT"
      ? "Bun is required to run Tessera Studio. Install Bun from https://bun.sh, then retry."
      : spawned.result.error.message;
    console.error(`tessera: ${message}`);
    return 1;
  }
  if (spawned.result.signal) {
    console.error(`tessera: Studio was terminated by ${spawned.result.signal}`);
    return 1;
  }
  return spawned.result.status ?? 1;
}

function findProjectConfig(startDirectory = process.cwd()) {
  let directory = resolve(startDirectory);
  while (true) {
    const candidate = join(directory, "components.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not find components.json in this directory or any parent directory.");
}

function resolveComponentsDirectory(projectRoot, alias) {
  if (typeof alias !== "string" || alias.trim() === "") {
    throw new Error("components.json must define aliases.components.");
  }
  if (isAbsolute(alias)) return resolve(alias);
  if (alias.startsWith("@/") || alias.startsWith("~/")) {
    return resolve(projectRoot, "src", alias.slice(2));
  }
  return resolve(projectRoot, alias);
}

function readProject(startDirectory = process.cwd()) {
  const configPath = findProjectConfig(startDirectory);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error.message}`);
  }
  const projectRoot = dirname(configPath);
  const componentsDirectory = resolveComponentsDirectory(projectRoot, config?.aliases?.components);
  const installRoot = join(componentsDirectory, "data-elements");
  return {
    componentsDirectory,
    configPath,
    installRoot,
    lockPath: join(installRoot, "data-elements.lock.json"),
    projectRoot,
  };
}

function resolveLockedFile(installRoot, name) {
  if (typeof name !== "string" || name.length === 0 || isAbsolute(name)) return undefined;
  const target = resolve(installRoot, name);
  const fromRoot = relative(installRoot, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return target;
}

function inspectInstallation(startDirectory = process.cwd()) {
  const project = readProject(startDirectory);
  const base = {
    ...project,
    conformance: "not-installed",
    lockConformance: "not-installed",
    catalogFiles: 0,
    dependencies: {},
    filesChecked: 0,
    modifiedFiles: [],
    ranges: {},
    reasons: [],
  };
  if (!existsSync(project.installRoot)) return { ...base, status: "fresh" };

  let entries;
  try {
    entries = readdirSync(project.installRoot);
  } catch (error) {
    return { ...base, status: "custom/unverified", reasons: [`Cannot read install directory: ${error.message}`] };
  }
  if (!existsSync(project.lockPath)) {
    if (entries.length === 0) return { ...base, status: "fresh" };
    return {
      ...base,
      status: "custom/unverified",
      reasons: ["Installed files exist but data-elements.lock.json is missing."],
    };
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(project.lockPath, "utf8"));
  } catch (error) {
    return {
      ...base,
      status: "custom/unverified",
      reasons: [`Lock file is invalid: ${error.message}`],
    };
  }

  const reasons = [];
  const modifiedFiles = [];
  const files = lock && typeof lock.files === "object" && lock.files !== null && !Array.isArray(lock.files)
    ? lock.files
    : undefined;
  const dependencies = lock && typeof lock.dependencies === "object" && lock.dependencies !== null && !Array.isArray(lock.dependencies)
    ? lock.dependencies
    : undefined;
  const installedFiles = Array.isArray(lock?.installedFiles) ? lock.installedFiles : undefined;
  if (![1, 2].includes(lock?.formatVersion)) reasons.push("Lock formatVersion is unsupported.");
  if (!files || Object.keys(files).length === 0) reasons.push("Lock does not contain source hashes.");
  if (!dependencies) reasons.push("Lock does not contain exact runtime dependencies.");
  if (lock?.rendererConformance !== "official") reasons.push("Lock does not claim official renderer conformance.");
  if (!installedFiles) reasons.push("Lock source selection is not sealed by the Data Elements CLI.");

  const ranges = {
    contract: lock?.contractApiRange,
    protocol: lock?.protocolRange,
    renderer: lock?.rendererApiRange,
    runtime: lock?.runtimeApiRange,
  };
  for (const [name, value] of Object.entries(ranges)) {
    if (typeof value !== "string" || value.length === 0) reasons.push(`Lock ${name} range is missing.`);
  }

  if (dependencies) {
    for (const packageName of ALLOWED_BROWSER_PACKAGES) {
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(dependencies[packageName] ?? "")) {
        reasons.push(`Lock dependency ${packageName} is not an exact version.`);
      }
    }
    for (const packageName of Object.keys(dependencies)) {
      if (packageName.startsWith("@data-elements/") && !ALLOWED_BROWSER_PACKAGES.has(packageName)) {
        reasons.push(`Lock contains server-only or unapproved dependency ${packageName}.`);
      }
    }
  }

  const validInstalledFiles = [];
  if (installedFiles && files) {
    const seen = new Set();
    for (const name of installedFiles) {
      if (typeof name !== "string" || seen.has(name) || !Object.hasOwn(files, name)) {
        reasons.push(`Lock contains an invalid installed source selection: ${String(name)}.`);
        continue;
      }
      seen.add(name);
      validInstalledFiles.push(name);
    }
  }

  const invalidEntries = new Set();
  if (files) {
    for (const [name, record] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
      const target = resolveLockedFile(project.installRoot, name);
      if (!target || !record || typeof record !== "object" || !HASH_PATTERN.test(record.sha256 ?? "")) {
        invalidEntries.add(name);
        reasons.push(`Invalid lock entry for ${name}.`);
        continue;
      }
      if (typeof record.source !== "string" || !record.source.startsWith("packages/react/src/")) {
        invalidEntries.add(name);
        reasons.push(`Locked source ${name} is not owned by packages/react/src.`);
      }
    }

    const selected = new Set(validInstalledFiles);
    for (const name of validInstalledFiles.sort()) {
      if (invalidEntries.has(name)) {
        modifiedFiles.push(name);
        continue;
      }
      const record = files[name];
      const target = resolveLockedFile(project.installRoot, name);
      if (!target || !existsSync(target) || !statSync(target).isFile()) {
        modifiedFiles.push(name);
        continue;
      }
      const content = readFileSync(target);
      if (sha256(content) !== record.sha256) modifiedFiles.push(name);
      const internalSpecifiers = content.toString("utf8").match(/@data-elements\/[a-z0-9-]+(?:\/[a-zA-Z0-9._-]+)*/g) ?? [];
      for (const specifier of internalSpecifiers) {
        const packageName = specifier.split("/").slice(0, 2).join("/");
        if (!ALLOWED_BROWSER_PACKAGES.has(packageName) || specifier !== packageName) {
          reasons.push(`${name} imports server-only or unapproved package specifier ${specifier}.`);
        }
      }
    }

    if (installedFiles) {
      for (const name of Object.keys(files)) {
        const target = resolveLockedFile(project.installRoot, name);
        if (target && existsSync(target) && statSync(target).isFile() && !selected.has(name)) {
          modifiedFiles.push(name);
          reasons.push(`Installed source ${name} is not recorded in the lock selection.`);
        }
      }
    }
  }
  if (modifiedFiles.length > 0) reasons.push(`${modifiedFiles.length} locked source file(s) were changed or removed.`);

  if (files && dependencies && HASH_PATTERN.test(lock?.rendererBuildHash ?? "")) {
    const expectedBuildHash = sha256(canonicalJson({ dependencies, files }));
    if (expectedBuildHash !== lock.rendererBuildHash) reasons.push("Renderer build hash does not match the lock contents.");
  } else {
    reasons.push("Renderer build hash is missing or invalid.");
  }

  const status = reasons.length === 0 ? "official" : "custom/unverified";
  return {
    ...base,
    catalogFiles: files ? Object.keys(files).length : 0,
    conformance: status === "official" ? "official" : "custom/unverified",
    dependencies: dependencies ?? {},
    filesChecked: validInstalledFiles.length,
    lockConformance: lock?.rendererConformance ?? "unknown",
    modifiedFiles: [...new Set(modifiedFiles)].sort(),
    ranges,
    reasons: [...new Set(reasons)],
    status,
  };
}

function formatDoctor(report) {
  const lines = [
    "Data Elements doctor",
    `Status: ${report.status}`,
    `Install: ${report.installRoot}`,
    `Lock: ${existsSync(report.lockPath) ? report.lockPath : "not installed"}`,
    `Conformance: ${report.conformance}`,
    `Lock conformance: ${report.lockConformance}`,
    `Protocol range: ${report.ranges.protocol ?? "unknown"}`,
    `Contract range: ${report.ranges.contract ?? "unknown"}`,
    `Runtime range: ${report.ranges.runtime ?? "unknown"}`,
    `Renderer range: ${report.ranges.renderer ?? "unknown"}`,
    `Files: ${report.filesChecked} installed of ${report.catalogFiles} catalog files, ${report.modifiedFiles.length} modified or missing`,
  ];
  if (Object.keys(report.dependencies).length > 0) {
    lines.push(`Dependencies: ${Object.entries(report.dependencies).sort().map(([name, value]) => `${name}@${value}`).join(", ")}`);
  }
  for (const file of report.modifiedFiles) lines.push(`Modified: ${file}`);
  for (const reason of report.reasons) lines.push(`Issue: ${reason}`);
  return lines.join("\n");
}

function sealInstallation(startDirectory = process.cwd()) {
  const project = readProject(startDirectory);
  if (!existsSync(project.lockPath)) {
    throw new Error("The registry did not install data-elements.lock.json.");
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(project.lockPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not seal the installed lock: ${error.message}`);
  }
  if (!lock || typeof lock.files !== "object" || lock.files === null || Array.isArray(lock.files)) {
    throw new Error("Could not seal the installed lock because its source catalog is invalid.");
  }

  const installedFiles = [];
  for (const name of Object.keys(lock.files).sort()) {
    const target = resolveLockedFile(project.installRoot, name);
    if (!target) throw new Error(`Could not seal invalid lock path ${name}.`);
    if (existsSync(target) && statSync(target).isFile()) installedFiles.push(name);
  }
  const sealed = { ...lock, installedFiles };
  const temporaryPath = `${project.lockPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(sealed, null, 2)}\n`);
    renameSync(temporaryPath, project.lockPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return inspectInstallation(startDirectory);
}

function run(args = process.argv.slice(2), options = {}) {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log(HELP);
    return 0;
  }
  if (args.length === 1 && ["-v", "--version"].includes(args[0])) {
    console.log(version);
    return 0;
  }

  let command;
  try {
    command = parseCommand(args);
  } catch (error) {
    const isStudio = args[0] === "studio";
    console.error(`${isStudio ? "tessera" : "data-elements"}: ${error.message}`);
    console.error(isStudio ? STUDIO_HELP : HELP);
    return 1;
  }

  if (command.command === "studio") {
    if (command.help) {
      console.log(STUDIO_HELP);
      return 0;
    }
    return runStudio(command, {
      ...options,
      cwd: options.cwd ?? process.cwd(),
    });
  }

  let inspection;
  try {
    inspection = inspectInstallation(process.cwd());
  } catch (error) {
    console.error(`data-elements: ${error.message}`);
    return 1;
  }

  if (command.command === "doctor") {
    console.log(formatDoctor(inspection));
    return inspection.status === "custom/unverified" ? 1 : 0;
  }

  if (inspection.status === "custom/unverified" && !command.force) {
    console.error("data-elements: installation is custom/unverified; locked files will not be overwritten.");
    console.error(formatDoctor(inspection));
    console.error("Run data-elements doctor for details, or rerun with --force to overwrite. --force is not a three-way merge.");
    return 1;
  }
  if (command.force) {
    console.warn("data-elements: --force will overwrite local Data Elements files; this is not a three-way merge.");
  }

  let invocation;
  try {
    invocation = createInvocation(
      command.items,
      process.env.npm_config_user_agent || "",
      process.env.DATA_ELEMENTS_REGISTRY_URL,
      { overwrite: command.force || inspection.status === "official" },
    );
  } catch (error) {
    console.error(`data-elements: ${error.message}`);
    return 1;
  }

  const result = spawnSync(
    invocation.command,
    invocation.args,
    { shell: false, stdio: "inherit" },
  );

  if (result.error) {
    console.error(`data-elements: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`data-elements: shadcn was terminated by ${result.signal}`);
    return 1;
  }
  const exitCode = result.status ?? 1;
  if (exitCode !== 0) return exitCode;

  let sealed;
  try {
    sealed = sealInstallation(process.cwd());
  } catch (error) {
    console.error(`data-elements: ${error.message}`);
    return 1;
  }
  if (sealed.status !== "official") {
    console.error("data-elements: installation completed, but its source lock is custom/unverified.");
    console.error(formatDoctor(sealed));
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = run();

module.exports = {
  canonicalJson,
  createInvocation,
  createStudioInvocation,
  findProjectConfig,
  findOptionalTesseraConfig,
  findTesseraConfig,
  formatDoctor,
  inspectInstallation,
  packageRunner,
  parseCommand,
  parseItems,
  parseStudioCommand,
  parseStudioDatabaseUrl,
  readProject,
  registryBaseUrl,
  registryUrl,
  resolveBunExecutable,
  resolveComponentsDirectory,
  resolveStudioConfig,
  resolveStudioEntry,
  run,
  runStudio,
  sealInstallation,
  sha256,
  spawnStudio,
  studioEntryCandidates,
  TESSERA_CONFIG_FILE,
};
