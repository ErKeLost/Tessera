import type { UIMessage, UIMessageChunk } from "ai";

/** Stable, server-executed tool ids exposed to the Studio UI. */
export type TesseraToolName = "inspect_current_context" | "inspect_catalog" | "inspect_schema" | "inspect_database_capabilities" | "describe_data" | "probe_data" | "run_analysis";
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
export type TesseraInspectCatalogToolInput = Readonly<{
  action: "inspect_governed_catalog";
}>;

/** A redacted UI input for a server-bound physical schema inspection. */
export type TesseraInspectSchemaToolInput = Readonly<{
  action: "inspect_governed_schema";
}>;

export type TesseraInspectDatabaseCapabilitiesToolInput = Readonly<{
  action: "inspect_database_capabilities";
}>;

/** A server-bound current-page context. It has no browser-provided payload. */
export type TesseraInspectCurrentContextToolInput = Readonly<{
  action: "inspect_current_context";
}>;

export type TesseraProbeDataToolInput = Readonly<{
  action: "probe_governed_data";
}>;

export type TesseraDescribeDataToolInput = Readonly<{
  action: "describe_governed_catalog";
}>;

export type TesseraRunAnalysisToolInput = Readonly<{
  action: "run_governed_analysis";
}>;

export type TesseraInspectCatalogToolOutput = Readonly<{
  status: "completed" | "failed";
  tableCount?: number;
  truncated?: boolean;
}>;

/**
 * Only bounded counts cross the Studio UI boundary. The model receives the
 * bounded schema projection directly; physical names are intentionally not
 * retained in browser transcript data.
 */
export type TesseraInspectSchemaToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  tableCount?: number;
  columnCount?: number;
  foreignKeyCount?: number;
  truncated?: boolean;
}>;

export type TesseraInspectDatabaseCapabilitiesToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  dialect?: string;
  componentCount?: number;
  truncated?: boolean;
}>;

export type TesseraInspectCurrentContextToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  entityCount?: number;
  truncated?: boolean;
}>;

export type TesseraProbeDataToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
}>;

export type TesseraDescribeDataToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  entityCount?: number;
  truncated?: boolean;
}>;

export type TesseraRunAnalysisToolOutput = Readonly<{
  status: "completed" | "blocked" | "failed";
  rowCount?: number;
  truncated?: boolean;
}>;

/** The native AI SDK tool parts expected by assistant-ui renderers. */
export type TesseraUITools = {
  inspect_current_context: {
    input: TesseraInspectCurrentContextToolInput;
    output: TesseraInspectCurrentContextToolOutput;
  };
  inspect_catalog: {
    input: TesseraInspectCatalogToolInput;
    output: TesseraInspectCatalogToolOutput;
  };
  inspect_schema: {
    input: TesseraInspectSchemaToolInput;
    output: TesseraInspectSchemaToolOutput;
  };
  inspect_database_capabilities: {
    input: TesseraInspectDatabaseCapabilitiesToolInput;
    output: TesseraInspectDatabaseCapabilitiesToolOutput;
  };
  describe_data: {
    input: TesseraDescribeDataToolInput;
    output: TesseraDescribeDataToolOutput;
  };
  probe_data: {
    input: TesseraProbeDataToolInput;
    output: TesseraProbeDataToolOutput;
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
