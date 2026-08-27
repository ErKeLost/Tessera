import type { UIMessage, UIMessageChunk } from "ai";
import type {
  OpenGenerativeFallback,
  OpenGenerativeSurfaceStream,
} from "@open-generative/protocol";
import type { TesseraAgentToolName, TesseraSuspendedToolPayload } from "./contracts";

export type { TesseraSuspendedToolPayload } from "./contracts";

export type TesseraListDatabaseToolInput = Readonly<{ action: "list_database" }>;
export type TesseraSearchDataContextToolInput = Readonly<{ action: "search_data_context" }>;
export type TesseraExecuteSqlToolInput = Readonly<{ action: "execute_sql" }>;
export type TesseraPrepareAnalysisToolInput = Readonly<{ action: "prepare_analysis" }>;

export type TesseraListDatabaseToolOutput = Readonly<{
  status: "completed" | "not_found" | "unavailable" | "blocked" | "failed";
  operation?: "list_relations" | "describe_schema" | "describe_relation" | "current_relation" | "capabilities" | "extensions" | "rls_policies";
  entityCount?: number;
  tableCount?: number;
  schemaCount?: number;
  relationCount?: number;
  columnCount?: number;
  foreignKeyCount?: number;
  indexCount?: number;
  catalogCoverage?: "complete" | "partial" | "unknown";
  dialect?: string;
  componentCount?: number;
  extensionCount?: number;
  installedCount?: number;
  policyCount?: number;
  truncated?: boolean;
  reason?: string;
  message?: string;
}>;

export type TesseraSearchDataContextToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  mode?: "search" | "describe";
  entityCount?: number;
  truncated?: boolean;
  reason?: string;
  message?: string;
}>;

export type TesseraExecuteSqlToolOutput = Readonly<{
  status: "completed" | "approval_required" | "blocked" | "failed";
  mode?: "read" | "analysis" | "mutation";
  rowCount?: number;
  affectedRows?: number;
  truncated?: boolean;
  requestId?: string;
  checkpointId?: string;
  reason?: string;
  message?: string;
  nextAction?: string;
}>;

export type TesseraPrepareAnalysisToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  reason?: string;
  message?: string;
}>;

export type TesseraUITools = {
  list_database: { input: TesseraListDatabaseToolInput; output: TesseraListDatabaseToolOutput };
  search_data_context: { input: TesseraSearchDataContextToolInput; output: TesseraSearchDataContextToolOutput };
  execute_sql: { input: TesseraExecuteSqlToolInput; output: TesseraExecuteSqlToolOutput };
  prepare_analysis: { input: TesseraPrepareAnalysisToolInput; output: TesseraPrepareAnalysisToolOutput };
};

export type TesseraUIData = {
  openGenerativeFallback: OpenGenerativeFallback;
  openGenerativeSurface: OpenGenerativeSurfaceStream;
  "tool-call-suspended": Readonly<{
    state: "data-tool-call-suspended";
    runId: string;
    toolCallId: string;
    toolName: TesseraAgentToolName | string;
    suspendPayload: TesseraSuspendedToolPayload;
    resumeSchema?: unknown;
  }>;
};

export type TesseraUIMessage = UIMessage<unknown, TesseraUIData, TesseraUITools>;
export type TesseraUIMessageChunk = UIMessageChunk<unknown, TesseraUIData>;
