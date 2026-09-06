import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Mastra } from "@mastra/core/mastra";
import type { Memory } from "@mastra/memory";
import type {
  AnalysisDraft,
  DataAgent,
  SemanticCatalog,
} from "@open-tessera/data-agent";
import type { DatabaseCatalog, DatabaseDialect } from "@open-tessera/database";
import type {
  TesseraAgentIdentity,
  TesseraAgentLlmConfig,
  TesseraAgentMutationPort,
  TesseraAgentPermissionContext,
  TesseraAgentRunInput,
} from "./contracts";
import type { CompletedAnalysis } from "./evidence";
import { buildDataCopilotInstructions } from "./prompt";
import type { PlanningCatalogScope } from "./planning";
import {
  createCapabilityPromptState,
  createCatalogPromptState,
  createRequestContextProcessor,
} from "./request-context";
import type { DatabaseSchemaInventory } from "./schema-context";
import { createTesseraDataCopilotTools } from "./tools";

export type { PlanningCatalogScope } from "./planning";

export type TesseraPreparedAnalysis = Readonly<{
  draft: AnalysisDraft;
  planFingerprint: string;
  title: string;
}>;

/** Mutable state whose lifetime is exactly one Agent turn. */
export type TesseraCopilotRuntime = {
  analyses: CompletedAnalysis[];
  completedAnalysisPlans: Set<string>;
  preparedAnalyses: Map<string, TesseraPreparedAnalysis>;
  preparedAnalysisPlans: Set<string>;
  planningScopes: PlanningCatalogScope[];
  rejectedAnalysisPlans: Set<string>;
  rejectedInvalidAnalysisInputs: number;
  currentContextInspected: boolean;
  physicalCatalog?: DatabaseCatalog;
  schemaInventory?: DatabaseSchemaInventory;
  schemaSemanticCatalog?: SemanticCatalog;
  schemaRefreshAttempted: boolean;
};

export type TesseraDataCopilotAgentOptions = Readonly<{
  input: TesseraAgentRunInput;
  dataAgent: DataAgent;
  memory: Memory;
  model: MastraModelConfig;
  llm: TesseraAgentLlmConfig;
  mastra: Mastra;
  defaultIdentity: TesseraAgentIdentity;
  formatError?: (error: unknown) => string;
  runtime?: TesseraCopilotRuntime;
  permissionContext?: TesseraAgentPermissionContext;
  databaseActions?: TesseraAgentMutationPort;
  databaseDialect?: DatabaseDialect;
}>;

export function createTesseraCopilotRuntime(): TesseraCopilotRuntime {
  return {
    analyses: [],
    completedAnalysisPlans: new Set(),
    preparedAnalyses: new Map(),
    preparedAnalysisPlans: new Set(),
    planningScopes: [],
    rejectedAnalysisPlans: new Set(),
    rejectedInvalidAnalysisInputs: 0,
    currentContextInspected: false,
    schemaRefreshAttempted: false,
  };
}

/**
 * Creates one Mastra Agent for one request. Conversation persistence, request
 * serialization, transport streaming, and suspension routing remain Host-owned.
 */
export function createTesseraDataCopilotAgent(
  options: TesseraDataCopilotAgentOptions,
): Agent {
  const runtime = options.runtime ?? createTesseraCopilotRuntime();
  const tools = createTesseraDataCopilotTools({
    input: options.input,
    dataAgent: options.dataAgent,
    runtime,
    defaultIdentity: options.defaultIdentity,
    ...(options.permissionContext === undefined
      ? {}
      : { permissionContext: options.permissionContext }),
    ...(options.databaseActions === undefined
      ? {}
      : { databaseActions: options.databaseActions }),
    ...(options.databaseDialect === undefined
      ? {}
      : { databaseDialect: options.databaseDialect }),
    ...(options.formatError === undefined ? {} : { formatError: options.formatError }),
  });

  const catalogPromptState = createCatalogPromptState();
  const capabilityPromptState = createCapabilityPromptState();

  return new Agent({
    id: "tessera-data-copilot",
    name: "Tessera Data Copilot",
    model: options.model,
    mastra: options.mastra,
    memory: options.memory,
    maxRetries: options.llm.maxRetries,
    inputProcessors: [
      createRequestContextProcessor({
        dataAgent: options.dataAgent,
        permissionContext: options.permissionContext,
        catalogState: catalogPromptState,
        capabilityState: capabilityPromptState,
        capabilityReader: options.dataAgent,
        observeSchema: (catalog, inventory, semanticCatalog) => {
          runtime.physicalCatalog = catalog;
          runtime.schemaInventory = inventory;
          runtime.schemaSemanticCatalog = semanticCatalog;
        },
      }),
    ],
    instructions: buildDataCopilotInstructions(),
    tools,
  });
}
