import type { MastraModelConfig } from "@mastra/core/llm";
import { Mastra } from "@mastra/core/mastra";
import type { Memory } from "@mastra/memory";
import type { OpenGenerativeHost } from "@open-generative/mastra";
import {
  createTesseraAgent,
  toMastraModelConfig as toAgentMastraModelConfig,
  type TesseraAgent,
  type TesseraAgentPermissionContext,
} from "@open-tessera/agent";
import type { DataAgent } from "@open-tessera/data-agent";
import type { DatabaseDialect } from "@open-tessera/database";
import {
  resolveTesseraLlmApiKey,
  resolveTesseraLlmConfig,
  type TesseraLlmConfig,
} from "./config";
import type { TesseraContinualHarness } from "./continual-harness";
import type { TesseraDatabaseActionService } from "./database-actions";
import {
  LOCAL_STUDIO_IDENTITY,
  tesseraSessionResourceId,
} from "./session-memory";
import {
  publicStudioStreamError,
  safeStudioErrorDetails,
} from "./studio-logger";

export type TesseraStudioAgentOptions = Readonly<{
  dataAgent: DataAgent;
  databaseDialect?: DatabaseDialect;
  memory: Memory;
  llm?: TesseraLlmConfig;
  permissionContext?: TesseraAgentPermissionContext;
  databaseActions?: TesseraDatabaseActionService;
  /**
   * A host may supply its shared runtime. Otherwise Studio binds Mastra's
   * suspension store to the same durable storage as conversation memory.
   */
  mastra?: Mastra;
  continualHarness?: TesseraContinualHarness;
  openGenerativeHost?: OpenGenerativeHost | Promise<OpenGenerativeHost>;
}>;

export type TesseraStudioAgent = TesseraAgent & Readonly<{
  catalogLoading: "data-agent";
  continualHarness?: TesseraContinualHarness;
}>;

/**
 * Connects the reusable Agent runtime to Studio-owned infrastructure. Studio
 * remains responsible for environment lookup, persistence, identity, policy,
 * and public error wording; no browser or HTTP concern enters the Agent package.
 */
export function createTesseraStudioAgent(
  options: TesseraStudioAgentOptions,
): TesseraStudioAgent {
  const llm = resolveTesseraLlmConfig({ llm: options.llm });
  const mastra = options.mastra ?? new Mastra({
    logger: false,
    storage: options.memory.storage,
  });
  const agent = createTesseraAgent({
    dataAgent: options.dataAgent,
    databaseDialect: options.databaseDialect ?? options.dataAgent.dialect,
    memory: options.memory,
    llm,
    model: toMastraModelConfig(llm),
    mastra,
    defaultIdentity: LOCAL_STUDIO_IDENTITY,
    resourceIdForIdentity: tesseraSessionResourceId,
    formatError: (error) => safeStudioErrorDetails(error).errorMessage.slice(0, 2_000),
    mapPublicError: ({ error, model }) => publicStudioStreamError(error, model),
    ...(options.permissionContext === undefined
      ? {}
      : { permissionContext: options.permissionContext }),
    ...(options.databaseActions === undefined
      ? {}
      : { databaseActions: options.databaseActions }),
    ...(options.continualHarness === undefined
      ? {}
      : { continualHarness: options.continualHarness }),
    ...(options.openGenerativeHost === undefined
      ? {}
      : { openGenerativeHost: options.openGenerativeHost }),
  });

  return {
    ...agent,
    catalogLoading: "data-agent",
    ...(options.continualHarness === undefined
      ? {}
      : { continualHarness: options.continualHarness }),
  };
}

/** Resolves host environment credentials before entering the Agent package. */
export function toMastraModelConfig(llm: TesseraLlmConfig): MastraModelConfig {
  if (llm.apiKey === undefined
    && llm.baseUrl === undefined
    && Object.keys(llm.headers).length === 0) {
    return toAgentMastraModelConfig(llm);
  }
  const apiKey = resolveTesseraLlmApiKey(llm);
  return toAgentMastraModelConfig({
    ...llm,
    ...(apiKey === undefined ? {} : { apiKey }),
  });
}
