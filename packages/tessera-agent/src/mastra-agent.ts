import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Mastra } from "@mastra/core/mastra";
import type { Memory } from "@mastra/memory";
import {
  createOpenGenerativeIntegration,
  OPEN_GENERATIVE_MASTRA_PROCESSOR_RETRIES,
  type OpenGenerativeHost,
  type OpenGenerativeMastraTerminalStep,
} from "@open-generative/mastra";
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
import type { CompletedAnalysis, CompletedQuery } from "./evidence";
import { tesseraAgentResourceId } from "./identity";
import { modelReasoningOptions } from "./model-config";
import {
  createTesseraPresentationResourceSidecar,
  isTesseraChartPresentationRequest,
  isTesseraPresentationFollowUp,
  type TesseraPresentationResourceSidecar,
} from "./presentation-resource-sidecar";
import {
  createTesseraDataResources,
  createTesseraPresentationAuthority,
  createTesseraPresentationIntent,
} from "./presentation";
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

const TESSERA_PRESENTATION_MAX_OUTPUT_TOKENS = 4_096;

export type TesseraPreparedAnalysis = Readonly<{
  draft: AnalysisDraft;
  planFingerprint: string;
  title: string;
}>;

/** Mutable state whose lifetime is exactly one Agent turn. */
export type TesseraCopilotRuntime = {
  analyses: CompletedAnalysis[];
  queries: CompletedQuery[];
  presentationDataAttempted: boolean;
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
  resourceIdForIdentity?: (identity: TesseraAgentIdentity) => string;
  formatError?: (error: unknown) => string;
  runtime?: TesseraCopilotRuntime;
  presentationResources?: TesseraPresentationResourceSidecar;
  permissionContext?: TesseraAgentPermissionContext;
  databaseActions?: TesseraAgentMutationPort;
  databaseDialect?: DatabaseDialect;
  openGenerativeHost?: OpenGenerativeHost | Promise<OpenGenerativeHost>;
}>;

export function createTesseraCopilotRuntime(): TesseraCopilotRuntime {
  return {
    analyses: [],
    queries: [],
    presentationDataAttempted: false,
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
  const presentationResources = options.presentationResources
    ?? createTesseraPresentationResourceSidecar();
  const identity = options.input.identity ?? options.defaultIdentity;
  const resourceId = options.resourceIdForIdentity?.(identity)
    ?? tesseraAgentResourceId(identity);
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
  const presentationFollowUp = isTesseraPresentationFollowUp(options.input.message);
  const openGenerative = createOpenGenerativeIntegration({
    ...(options.openGenerativeHost === undefined
      ? {}
      : { host: options.openGenerativeHost }),
    resources: async () => {
      const current = createTesseraDataResources({
        analyses: runtime.analyses,
        queries: runtime.queries,
      });
      return presentationResources.resourcesFor({
        resourceId,
        threadId: options.input.threadId,
        current,
        dataAttempted: runtime.presentationDataAttempted,
        allowCached: presentationFollowUp,
      });
    },
    authority: async () => createTesseraPresentationAuthority(identity),
    intent: ({ resources }) => createTesseraPresentationIntent(resources),
    terminalStep: createTesseraOpenGenerativeTerminalStep(options.llm),
    rejectionPolicy: "discard",
    turn: {
      presentationPolicy: isTesseraChartPresentationRequest(options.input.message)
        ? "required"
        : "auto",
      title: "Tessera analysis",
    },
  }).createProcessor();

  return new Agent({
    id: "tessera-data-copilot",
    name: "Tessera Data Copilot",
    model: options.model,
    mastra: options.mastra,
    memory: options.memory,
    maxRetries: options.llm.maxRetries,
    maxProcessorRetries: OPEN_GENERATIVE_MASTRA_PROCESSOR_RETRIES,
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
      openGenerative,
    ],
    outputProcessors: [openGenerative],
    instructions: buildDataCopilotInstructions(),
    tools,
  });
}

export function createTesseraOpenGenerativeTerminalStep(
  llm: TesseraAgentLlmConfig,
): OpenGenerativeMastraTerminalStep {
  return {
    modelSettings: {
      maxOutputTokens: Math.min(
        llm.maxOutputTokens,
        TESSERA_PRESENTATION_MAX_OUTPUT_TOKENS,
      ),
      temperature: 0,
    },
    ...modelReasoningOptions(llm),
  };
}
