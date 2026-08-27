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
  TesseraUIData,
  TesseraUIMessage,
  TesseraUIMessageChunk,
  TesseraUITools,
} from "@open-tessera/agent";

export type { TesseraAgentToolName as TesseraToolName } from "@open-tessera/agent";
