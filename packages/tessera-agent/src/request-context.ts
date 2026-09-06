import type { InputProcessor, ProcessLLMRequestArgs } from "@mastra/core/processors";
import { RequestContext } from "@mastra/core/request-context";
import type { SemanticCatalog } from "@open-tessera/data-agent";
import type {
  DatabaseCapabilities,
  DatabaseCatalog,
  DatabasePermissionLevel,
} from "@open-tessera/database";
import type {
  TesseraAgentPermissionContext,
  TesseraAgentRunInput,
} from "./contracts";
import {
  buildDatabaseSchemaInventory,
  escapePromptDelimiters,
  formatDatabaseSchemaInventory,
  type DatabaseSchemaInventory,
} from "./schema-context";

export type SchemaCatalogReader = Readonly<{
  inspectCatalog(input?: { refresh?: boolean }, signal?: AbortSignal): Promise<Readonly<{
    catalog: DatabaseCatalog;
    semanticCatalog?: SemanticCatalog;
  }>>;
  inspectCapabilities?(signal?: AbortSignal): Promise<Readonly<{
    capabilities: DatabaseCapabilities;
    cacheStatus: "hit" | "loaded" | "unavailable";
  }>>;
}>;

export type CapabilityReader = Pick<SchemaCatalogReader, "inspectCapabilities">;

export type SchemaContextObserver = (
  catalog: DatabaseCatalog,
  inventory: DatabaseSchemaInventory,
  semanticCatalog?: SemanticCatalog,
) => void;

export type CatalogPromptSnapshot = Readonly<{
  catalog: DatabaseCatalog;
  semanticCatalog?: SemanticCatalog;
}>;

export type CapabilityPromptSnapshot = Readonly<{
  capabilities: DatabaseCapabilities;
}>;

export type TesseraRuntimeSignal = Readonly<{ text: string }>;

export type TesseraWorkspaceSignal = Readonly<{
  hasCurrentRelation: boolean;
  hasLocalFilter: boolean;
  view?: "data" | "definition";
}>;

export type TesseraCopilotRequestContext = {
  "tessera.workspace": TesseraWorkspaceSignal;
  "tessera.runtime-signals"?: readonly TesseraRuntimeSignal[];
};

export type RequestContextProcessorOptions = Readonly<{
  dataAgent: SchemaCatalogReader;
  capabilityReader?: CapabilityReader;
  permissionContext: TesseraAgentPermissionContext | undefined;
  catalogState?: CatalogPromptState;
  capabilityState?: CapabilityPromptState;
  observeSchema?: SchemaContextObserver;
}>;

export type CatalogPromptState = {
  status: "idle" | "loading" | "available" | "unavailable";
  snapshot?: CatalogPromptSnapshot;
  load?: Promise<CatalogPromptSnapshot | undefined>;
};

export type CapabilityPromptState = {
  status: "idle" | "loading" | "available" | "unavailable";
  snapshot?: CapabilityPromptSnapshot;
  load?: Promise<CapabilityPromptSnapshot | undefined>;
};

export function createCatalogPromptState(): CatalogPromptState {
  return { status: "idle" };
}

export function createCapabilityPromptState(): CapabilityPromptState {
  return { status: "idle" };
}

export function formatDatabaseConnectionContext(
  snapshot: CatalogPromptSnapshot | undefined,
): string {
  if (snapshot === undefined) {
    return [
      "<database_context>",
      "availability=unavailable",
      "dialect=unknown",
      "</database_context>",
    ].join("\n");
  }
  const dialect = databaseDialectLabel(snapshot.catalog.dialect);
  return [
    "<database_context>",
    "availability=available",
    `dialect=${dialect}`,
    "</database_context>",
  ].join("\n");
}

export function formatDatabaseCapabilitiesContext(
  snapshot: CapabilityPromptSnapshot | undefined,
): string {
  if (snapshot === undefined) {
    return [
      "<database_capabilities>",
      "availability=unavailable",
      "</database_capabilities>",
    ].join("\n");
  }
  const { capabilities } = snapshot;
  const components = capabilities.components
    .filter((component) => component.kind !== "extension" && component.kind !== "module")
    .slice(0, 64)
    .map((component) => ({
      id: component.id,
      kind: component.kind,
      status: component.status,
      ...(component.version ? { version: component.version } : {}),
      ...(component.defaultVersion ? { defaultVersion: component.defaultVersion } : {}),
      ...(component.schema ? { schema: component.schema } : {}),
    }));
  return [
    "<database_capabilities>",
    escapePromptDelimiters(JSON.stringify({
      dialect: capabilities.dialect,
      availability: capabilities.availability,
      ...(capabilities.serverVersion ? { serverVersion: capabilities.serverVersion } : {}),
      components,
      truncated: capabilities.truncated || capabilities.components.length > components.length,
    })),
    "</database_capabilities>",
  ].join("\n");
}

export function formatDatabasePermissionContext(
  context: TesseraAgentPermissionContext | undefined,
  snapshot: CatalogPromptSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined) {
    return [
      "<authorization_context>",
      "availability=unavailable",
      "</authorization_context>",
    ].join("\n");
  }

  if (context === undefined) {
    return [
      "<authorization_context>",
      "availability=unavailable",
      "SQL permissions: read=denied, write=denied, destructive=denied, unknown=denied.",
      "</authorization_context>",
    ].join("\n");
  }

  const mutationAvailable = context.accessMode === "read-write"
    && context.databaseActionsAvailable;
  const effective = mutationAvailable
    ? context.sqlStatements
    : {
        ...context.sqlStatements,
        write: "deny" as const,
        destructive: "deny" as const,
        unknown: "deny" as const,
      };
  const permissionLabel = (value: DatabasePermissionLevel): string => value === "allow"
    ? "allowed"
    : value === "ask"
      ? "approval required"
      : "denied";
  return [
    "<authorization_context>",
    `Database access mode: ${context.accessMode}.`,
    `Database mutation actions are ${mutationAvailable ? "available" : "unavailable"}.`,
    `SQL permissions: read=${permissionLabel(effective.read)}, write=${permissionLabel(effective.write)}, destructive=${permissionLabel(effective.destructive)}, unknown=${permissionLabel(effective.unknown)}.`,
    "</authorization_context>",
  ].join("\n");
}

export function formatRuntimeSignalContext(
  signals: readonly TesseraRuntimeSignal[],
): string | undefined {
  if (signals.length === 0) return undefined;
  return [
    "<runtime_context>",
    "source=server; scope=turn; kind=runtime_signal",
    ...signals.map(
      (signal) => `<system-reminder>\n${escapeRuntimeSignalText(signal.text)}\n</system-reminder>`,
    ),
    "</runtime_context>",
  ].join("\n");
}

export function formatWorkspaceContext(workspace: TesseraWorkspaceSignal | undefined): string {
  return [
    "<workspace_context>",
    "source=host; scope=turn; kind=workspace_metadata",
    workspaceInstruction(workspace),
    "</workspace_context>",
  ].join("\n");
}

export function formatRequestContext(args: Readonly<{
  snapshot: CatalogPromptSnapshot | undefined;
  capabilities?: CapabilityPromptSnapshot;
  permissionContext: TesseraAgentPermissionContext | undefined;
  inventory?: DatabaseSchemaInventory;
  workspace?: TesseraWorkspaceSignal;
  runtimeSignals?: readonly TesseraRuntimeSignal[];
}>): string {
  const sections = [
    formatDatabaseConnectionContext(args.snapshot),
    formatDatabaseCapabilitiesContext(args.capabilities),
    formatDatabasePermissionContext(args.permissionContext, args.snapshot),
    ...(args.inventory === undefined ? [] : [formatDatabaseSchemaInventory(args.inventory)]),
    ...(args.workspace === undefined ? [] : [formatWorkspaceContext(args.workspace)]),
    ...(args.runtimeSignals === undefined ? [] : [formatRuntimeSignalContext(args.runtimeSignals)]),
  ].filter((section): section is string => section !== undefined);
  return [
    "<request_context>",
    "source=server; scope=request; bounded=true",
    ...sections,
    "</request_context>",
  ].join("\n");
}

/** Injects one complete request context into each transient provider prompt. */
export function createRequestContextProcessor(
  options: RequestContextProcessorOptions,
): InputProcessor {
  const catalogState = options.catalogState ?? createCatalogPromptState();
  const capabilityState = options.capabilityState ?? createCapabilityPromptState();
  return {
    id: "tessera-request-context",
    name: "Request context",
    description: "Injects bounded request-scoped database, authorization, workspace, and runtime context.",
    async processLLMRequest(args: ProcessLLMRequestArgs) {
      const snapshot = await loadCatalogPromptSnapshot(
        options.dataAgent,
        catalogState,
        args.abortSignal,
      );
      const capabilities = await loadCapabilityPromptSnapshot(
        options.capabilityReader ?? options.dataAgent,
        capabilityState,
        args.abortSignal,
      );

      let inventory: DatabaseSchemaInventory | undefined;
      if (snapshot !== undefined) {
        inventory = buildDatabaseSchemaInventory(snapshot.catalog, snapshot.semanticCatalog);
        options.observeSchema?.(snapshot.catalog, inventory, snapshot.semanticCatalog);
      }
      const workspace = workspaceSignalFromRequestContext(args.requestContext);
      const runtimeSignals = runtimeSignalsFromRequestContext(
        args.requestContext?.get("tessera.runtime-signals"),
      );
      const contextMessage = {
        role: "assistant" as const,
        content: [{
          type: "text" as const,
          text: formatRequestContext({
            snapshot,
            ...(capabilities === undefined ? {} : { capabilities }),
            permissionContext: options.permissionContext,
            inventory,
            ...(workspace === undefined ? {} : { workspace }),
            ...(runtimeSignals.length === 0 ? {} : { runtimeSignals }),
          }),
        }],
      };
      const firstUserIndex = args.prompt.findIndex((message) => message.role === "user");
      const insertAt = firstUserIndex < 0 ? args.prompt.length : firstUserIndex;
      return {
        prompt: [
          ...args.prompt.slice(0, insertAt),
          contextMessage,
          ...args.prompt.slice(insertAt),
        ],
      };
    },
  };
}

/** Creates the typed Mastra context from server-owned turn input. */
export function createTesseraRequestContext(
  input: Pick<TesseraAgentRunInput, "turnContext" | "runtimeSignals">,
): RequestContext<TesseraCopilotRequestContext> {
  const context = new RequestContext<TesseraCopilotRequestContext>();
  context.set("tessera.workspace", workspaceSignalFromInput(input));
  if (input.runtimeSignals !== undefined && input.runtimeSignals.length > 0) {
    context.set(
      "tessera.runtime-signals",
      input.runtimeSignals.map((text) => ({ text })),
    );
  }
  return context;
}

export function workspaceSignalFromInput(
  input: Pick<TesseraAgentRunInput, "turnContext">,
): TesseraWorkspaceSignal {
  return {
    hasCurrentRelation: input.turnContext?.currentRelation !== undefined,
    hasLocalFilter: input.turnContext?.workspace.hasLocalFilter === true,
    ...(input.turnContext?.workspace.view === undefined
      ? {}
      : { view: input.turnContext.workspace.view }),
  };
}

const MAX_RUNTIME_SIGNALS_PER_TURN = 8;
const MAX_RUNTIME_SIGNAL_LENGTH = 4_000;
const MAX_RUNTIME_SIGNAL_TOTAL_LENGTH = 12_000;

async function loadCatalogPromptSnapshot(
  dataAgent: SchemaCatalogReader,
  state: CatalogPromptState,
  signal?: AbortSignal,
): Promise<CatalogPromptSnapshot | undefined> {
  if (state.status === "available") return state.snapshot;
  if (state.status === "unavailable") return undefined;
  if (state.load !== undefined) return state.load;

  state.status = "loading";
  state.load = (async () => {
    try {
      const snapshot = await dataAgent.inspectCatalog({}, signal);
      state.snapshot = snapshot;
      state.status = "available";
      return snapshot;
    } catch (error) {
      if (isAbortError(error)) {
        state.status = "idle";
        throw error;
      }
      state.status = "unavailable";
      return undefined;
    } finally {
      state.load = undefined;
    }
  })();
  return state.load;
}

async function loadCapabilityPromptSnapshot(
  reader: CapabilityReader | undefined,
  state: CapabilityPromptState,
  signal?: AbortSignal,
): Promise<CapabilityPromptSnapshot | undefined> {
  if (state.status === "available") return state.snapshot;
  if (state.status === "unavailable") return undefined;
  if (state.load !== undefined) return state.load;
  state.status = "loading";
  state.load = (async () => {
    try {
      if (!reader?.inspectCapabilities) {
        state.status = "unavailable";
        return undefined;
      }
      const result = await reader.inspectCapabilities(signal);
      state.snapshot = { capabilities: result.capabilities };
      state.status = result.capabilities.availability === "unavailable"
        ? "unavailable"
        : "available";
      return state.snapshot;
    } catch (error) {
      if (isAbortError(error)) {
        state.status = "idle";
        throw error;
      }
      state.status = "unavailable";
      return undefined;
    } finally {
      state.load = undefined;
    }
  })();
  return state.load;
}

function databaseDialectLabel(dialect: DatabaseCatalog["dialect"]): string {
  switch (dialect) {
    case "postgres": return "PostgreSQL";
    case "mysql": return "MySQL";
    case "sqlite": return "SQLite";
    case "turso": return "Turso (SQLite-compatible)";
    case "mongodb": return "MongoDB";
  }
}

function runtimeSignalsFromRequestContext(value: unknown): TesseraRuntimeSignal[] {
  if (!Array.isArray(value)) return [];
  const signals: TesseraRuntimeSignal[] = [];
  const seen = new Set<string>();
  let totalLength = 0;
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (text.length === 0 || text.length > MAX_RUNTIME_SIGNAL_LENGTH) continue;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) continue;
    if (seen.has(text)) continue;
    if (totalLength + text.length > MAX_RUNTIME_SIGNAL_TOTAL_LENGTH) break;
    signals.push({ text });
    seen.add(text);
    totalLength += text.length;
    if (signals.length >= MAX_RUNTIME_SIGNALS_PER_TURN) break;
  }
  return signals;
}

function workspaceSignalFromRequestContext(
  requestContext: RequestContext | undefined,
): TesseraWorkspaceSignal | undefined {
  const value = requestContext?.get("tessera.workspace");
  if (!isRecord(value)
    || typeof value.hasCurrentRelation !== "boolean"
    || typeof value.hasLocalFilter !== "boolean") {
    return undefined;
  }
  return {
    hasCurrentRelation: value.hasCurrentRelation,
    hasLocalFilter: value.hasLocalFilter,
    ...(value.view === "data" || value.view === "definition" ? { view: value.view } : {}),
  };
}

function workspaceInstruction(workspace: TesseraWorkspaceSignal | undefined): string {
  if (!workspace) {
    return "has_current_relation=false\nhas_local_filter=false\nview=unknown";
  }
  return [
    `has_current_relation=${workspace.hasCurrentRelation}`,
    `has_local_filter=${workspace.hasLocalFilter}`,
    `view=${workspace.view ?? "unknown"}`,
    "relation_identity=hidden",
  ].join("\n");
}

function escapeRuntimeSignalText(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
