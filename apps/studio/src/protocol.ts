import type { UIMessage, UIMessageChunk } from "ai";

/** Stable, server-executed tool ids exposed to the Studio UI. */
export type TesseraToolName = "list_database" | "list_catalog" | "execute_sql" | "run_analysis" | "list_rls_policies" | "list_extensions";

/**
 * These are intentionally summaries, rather than the model's raw tool args.
 * Tool UIs can communicate what is happening without disclosing catalog
 * identifiers, SQL, query output, or user-supplied search terms.
 */
export type TesseraListDatabaseToolInput = Readonly<{
  action: "list_database";
}>;

export type TesseraListCatalogToolInput = Readonly<{
  action: "list_catalog";
}>;

export type TesseraExecuteSqlToolInput = Readonly<{
  action: "execute_sql";
}>;

export type TesseraRunAnalysisToolInput = Readonly<{
  action: "run_governed_analysis";
}>;

export type TesseraListDatabaseToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  scope?: "current" | "schema" | "capabilities";
  entityCount?: number;
  tableCount?: number;
  columnCount?: number;
  foreignKeyCount?: number;
  dialect?: string;
  componentCount?: number;
  truncated?: boolean;
}>;

export type TesseraListCatalogToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  mode?: "search" | "describe";
  entityCount?: number;
  truncated?: boolean;
}>;

export type TesseraExecuteSqlToolOutput = Readonly<{
  status: "completed" | "approval_required" | "blocked" | "failed";
  mode?: "read" | "mutation";
  rowCount?: number;
  affectedRows?: number;
  truncated?: boolean;
  requestId?: string;
  checkpointId?: string;
  reason?: string;
  message?: string;
  nextAction?: string;
}>;

export type TesseraRunAnalysisToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  rowCount?: number;
  truncated?: boolean;
}>;

export type TesseraListRlsPoliciesToolInput = Readonly<{
  action: "list_rls_policies";
}>;

export type TesseraListRlsPoliciesToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  dialect?: string;
  relationCount?: number;
  policyCount?: number;
  truncated?: boolean;
}>;

export type TesseraListExtensionsToolInput = Readonly<{
  action: "list_extensions";
}>;

export type TesseraListExtensionsToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  dialect?: string;
  extensionCount?: number;
  installedCount?: number;
  truncated?: boolean;
}>;

/** The native AI SDK tool parts expected by assistant-ui renderers. */
export type TesseraUITools = {
  list_database: {
    input: TesseraListDatabaseToolInput;
    output: TesseraListDatabaseToolOutput;
  };
  list_catalog: {
    input: TesseraListCatalogToolInput;
    output: TesseraListCatalogToolOutput;
  };
  execute_sql: {
    input: TesseraExecuteSqlToolInput;
    output: TesseraExecuteSqlToolOutput;
  };
  run_analysis: {
    input: TesseraRunAnalysisToolInput;
    output: TesseraRunAnalysisToolOutput;
  };
  list_rls_policies: {
    input: TesseraListRlsPoliciesToolInput;
    output: TesseraListRlsPoliciesToolOutput;
  };
  list_extensions: {
    input: TesseraListExtensionsToolInput;
    output: TesseraListExtensionsToolOutput;
  };
};

/** Studio uses native reasoning, text, and tool parts only. */
export type TesseraUIData = Record<never, never>;

export type TesseraUIMessage = UIMessage<unknown, TesseraUIData, TesseraUITools>;
export type TesseraUIMessageChunk = UIMessageChunk<unknown, TesseraUIData>;
