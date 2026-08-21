import type { UIMessage, UIMessageChunk } from "ai";

/** Stable, server-executed tool ids exposed to the Studio UI. */
export type TesseraToolName = "list_database" | "list_catalog" | "execute_sql" | "run_analysis";
export type TesseraToolState = "started" | "completed" | "blocked" | "failed";
/**
 * Public lifecycle only. Details such as SQL, catalog identifiers, probe
 * arguments, and query output remain on the server.
 */
export type TesseraDataAgentStage =
  | "catalog"
  | "retrieval"
  | "planning"
  | "probing"
  | "compiling"
  | "executing"
  | "verifying"
  | "publishing"
  | "narrating";
export type TesseraDataAgentStageStatus = "started" | "completed" | "failed";

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
}>;

export type TesseraRunAnalysisToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  rowCount?: number;
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
};

export type TesseraToolData = Readonly<{
  runId: string;
  tool: TesseraToolName;
  state: TesseraToolState;
}>;

/**
 * A scrubbed Data Agent lifecycle event. Do not add `detail` here: its source
 * event can contain catalog-derived identifiers and execution metadata.
 */
export type TesseraStageData = Readonly<{
  runId: string;
  stage: TesseraDataAgentStage;
  status: TesseraDataAgentStageStatus;
  /** Terminal timing is allowlisted; SQL and stage detail remain server-only. */
  durationMs?: number;
}>;

/**
 * A stable, redacted view of the fixed Data Agent workflow. It is updated by
 * id as the run advances so Assistant UI can render one timeline instead of
 * five disconnected status rows.
 */
export type TesseraExecutionTraceData = Readonly<{
  runId: string;
  status: "running" | "completed" | "failed";
  stages: readonly Readonly<{
    stage: TesseraDataAgentStage;
    status: TesseraDataAgentStageStatus;
    durationMs?: number;
  }>[];
}>;

export type TesseraEvidence = Readonly<{
  queryId: string;
  label: string;
}>;

export type TesseraRunData = Readonly<{
  runId: string;
  threadId: string;
  status: "completed" | "needs_input";
  evidence: readonly TesseraEvidence[];
}>;

export type TesseraUIData = {
  "tessera-execution": TesseraExecutionTraceData;
  "tessera-run": TesseraRunData;
  "tessera-stage": TesseraStageData;
  "tessera-tool": TesseraToolData;
};

export type TesseraUIMessage = UIMessage<unknown, TesseraUIData, TesseraUITools>;
export type TesseraUIMessageChunk = UIMessageChunk<unknown, TesseraUIData>;
