import type { UIMessage, UIMessageChunk } from "ai";
import type {
  OpenGenerativeFallback,
  OpenGenerativeSurfaceStream,
} from "@open-generative/protocol";

/** Stable, server-executed tool ids exposed to the Studio UI. */
export type TesseraToolName = "list_database" | "search_data_context" | "prepare_analysis" | "execute_sql";

/**
 * These are intentionally summaries, rather than the model's raw tool args.
 * Tool UIs can communicate what is happening without disclosing catalog
 * identifiers, SQL, query output, or user-supplied search terms.
 */
export type TesseraListDatabaseToolInput = Readonly<{
  action: "list_database";
}>;

export type TesseraSearchDataContextToolInput = Readonly<{
  action: "search_data_context";
}>;

export type TesseraExecuteSqlToolInput = Readonly<{
  action: "execute_sql";
}>;

export type TesseraPrepareAnalysisToolInput = Readonly<{
  action: "prepare_analysis";
}>;

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

/** The native AI SDK tool parts expected by assistant-ui renderers. */
export type TesseraUITools = {
  list_database: {
    input: TesseraListDatabaseToolInput;
    output: TesseraListDatabaseToolOutput;
  };
  search_data_context: {
    input: TesseraSearchDataContextToolInput;
    output: TesseraSearchDataContextToolOutput;
  };
  execute_sql: {
    input: TesseraExecuteSqlToolInput;
    output: TesseraExecuteSqlToolOutput;
  };
  prepare_analysis: {
    input: TesseraPrepareAnalysisToolInput;
    output: TesseraPrepareAnalysisToolOutput;
  };
};

/** Studio uses native reasoning, text, and tool parts only. */
export type TesseraSuspendedToolPayload = Readonly<{
  requestId: string;
  checkpointId: string;
  operation: string;
  target: string;
  purpose: string;
  compiled?: Readonly<{
    sql: string;
    parameters: unknown[];
  }>;
}>;

export type TesseraUIData = {
  openGenerativeFallback: OpenGenerativeFallback;
  openGenerativeSurface: OpenGenerativeSurfaceStream;
  "tool-call-suspended": Readonly<{
    state: "data-tool-call-suspended";
    runId: string;
    toolCallId: string;
    toolName: string;
    suspendPayload: TesseraSuspendedToolPayload;
    resumeSchema?: unknown;
  }>;
};

export type TesseraUIMessage = UIMessage<unknown, TesseraUIData, TesseraUITools>;
export type TesseraUIMessageChunk = UIMessageChunk<unknown, TesseraUIData>;
