import type { UIMessage, UIMessageChunk } from "ai";
/**
 * Browser-facing aliases for the Agent package protocol. Keeping this module
 * type-only prevents Mastra's server runtime from entering the Studio client.
 */
export type {
  TesseraExecuteSqlToolInput,
  TesseraExecuteSqlToolOutput,
  TesseraListDatabaseToolInput,
  TesseraListDatabaseToolOutput,
  TesseraPrepareAnalysisToolInput,
  TesseraPrepareAnalysisToolOutput,
  TesseraSearchDataContextToolInput,
  TesseraSearchDataContextToolOutput,
  TesseraSuspendedToolPayload,
  TesseraUITools,
} from "@open-tessera/agent";

import type {
  TesseraUIData as AgentTesseraUIData,
  TesseraUITools,
} from "@open-tessera/agent";

export type TesseraUIData = AgentTesseraUIData;

export type TesseraUIMessage = UIMessage<unknown, TesseraUIData, TesseraUITools>;
export type TesseraUIMessageChunk = UIMessageChunk<unknown, TesseraUIData>;

export type { TesseraAgentToolName as TesseraToolName } from "@open-tessera/agent";
