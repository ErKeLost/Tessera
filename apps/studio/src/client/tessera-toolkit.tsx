"use client";

import {
  defineToolkit,
  type Toolkit,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { AgentActivity } from "./components/agent-activity";
import { ToolCall } from "./components/elements/tool-call";

type SafeToolResult = Record<string, unknown>;
type TesseraToolKind = "context" | "catalog" | "schema" | "probe" | "analysis";

const CurrentContextTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="context"
    label="Reading selected data context"
    completeLabel="Read selected data context"
    detail={currentContextDetail(props.result)}
  />
);

const CatalogSearchTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="catalog"
    label="Inspecting permitted data"
    completeLabel="Inspected permitted data"
    detail={catalogDetail(props.result)}
  />
);

const CatalogDescriptionTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="catalog"
    label="Reviewing data definitions"
    completeLabel="Reviewed data definitions"
    detail={catalogDescriptionDetail(props.result)}
  />
);

const SchemaInspectionTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="schema"
    label="Inspecting database schema"
    completeLabel="Inspected database schema"
    detail={schemaDetail(props.result)}
  />
);

const DatabaseCapabilitiesTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="schema"
    label="Inspecting database capabilities"
    completeLabel="Inspected database capabilities"
    detail={capabilitiesDetail(props.result)}
  />
);

const DataProbeTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="probe"
    label="Checking data signals"
    completeLabel="Checked data signals"
    detail={probeDetail(props.result)}
  />
);

const GovernedAnalysisTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="analysis"
    label="Running governed analysis"
    completeLabel="Verified data analysis"
    detail={analysisDetail(props.result)}
  />
);

function TesseraToolCall({
  completeLabel,
  detail,
  kind,
  label,
  result,
  status,
}: ToolCallMessagePartProps<Record<string, unknown>, SafeToolResult> & {
  completeLabel: string;
  detail: string;
  kind: TesseraToolKind;
  label: string;
}) {
  const running = status.type === "running";
  const failed = status.type === "incomplete" || result?.status === "blocked" || result?.status === "failed";
  const needsApproval = status.type === "requires-action";
  const title = running ? label : needsApproval ? `${label} needs approval` : completeLabel;
  const [open, setOpen] = useState(running || failed || needsApproval);

  useEffect(() => {
    if (running || failed || needsApproval) setOpen(true);
  }, [running, failed, needsApproval]);

  const request = toolRequest(kind);
  const chip = toolChip(kind);

  if (failed) {
    return <AgentActivity detail={chip} label={`${label} stopped`} state="failed" />;
  }

  return (
    <>
      {(running || needsApproval) ? (
        <AgentActivity
          detail={chip}
          label={needsApproval ? "Awaiting local approval" : label}
          state={needsApproval ? "thinking" : "tool-running"}
        />
      ) : null}
      <ToolCall
        activeLabel={label}
        label={title}
        onOpenChange={setOpen}
        open={open}
        query={chip}
        request={request}
        result={`${detail}${result?.truncated === true ? " Result limit reached." : ""}`}
        running={running}
      />
    </>
  );
}

function toolChip(kind: TesseraToolKind): string {
  return kind;
}

function toolRequest(kind: TesseraToolKind): string {
  if (kind === "context") return "Read server-bound selected data context";
  if (kind === "catalog") return "Read governed catalog metadata";
  if (kind === "schema") return "Read bounded physical schema metadata";
  if (kind === "probe") return "Check bounded data signals";
  return "Run a governed read-only analysis";
}

function currentContextDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Preparing the selected data context";
  if (result.status === "blocked") return "The selected data context is no longer available";
  const count = safePositiveInteger(result.entityCount);
  return count === undefined
    ? "Selected data context is ready"
    : `${count} selected ${count === 1 ? "entity is" : "entities are"} ready`;
}

function catalogDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Reviewing the governed schema";
  if (result.status === "blocked") return "No permitted catalog path was available";
  const count = safePositiveInteger(result.tableCount);
  return count === undefined
    ? "Catalog review completed"
    : `${count} permitted ${count === 1 ? "table is" : "tables are"} available`;
}

function catalogDescriptionDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Reviewing permitted fields and relationships";
  if (result.status === "blocked") return "No permitted data definition was available";
  const count = safePositiveInteger(result.entityCount);
  return count === undefined
    ? "Data definition review completed"
    : `${count} ${count === 1 ? "entity was" : "entities were"} reviewed`;
}

function schemaDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Reviewing bounded database structure";
  if (result.status === "blocked") return "The requested schema is not available";
  const tables = safePositiveInteger(result.tableCount);
  const columns = safePositiveInteger(result.columnCount);
  const foreignKeys = safePositiveInteger(result.foreignKeyCount);
  if (tables === undefined) return "Database schema review completed";
  const detail = `${tables} ${tables === 1 ? "table" : "tables"}`;
  const columnDetail = columns === undefined ? "" : `, ${columns} ${columns === 1 ? "column" : "columns"}`;
  const relationDetail = foreignKeys === undefined ? "" : `, ${foreignKeys} ${foreignKeys === 1 ? "relationship" : "relationships"}`;
  return `${detail}${columnDetail}${relationDetail} reviewed`;
}

function capabilitiesDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Checking database version and extensions";
  if (result.status === "blocked") return "Database capabilities are unavailable";
  const count = safePositiveInteger(result.componentCount);
  return count === undefined ? "Database capability check completed" : `${count} database capabilities checked`;
}

function probeDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Checking bounded values and ranges";
  if (result.status === "blocked") return "No governed probe was available for this analysis";
  return "Governed data check completed";
}

function analysisDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Applying read-only limits and result checks";
  if (result.status === "blocked") return "The query did not pass the governed read-only policy";
  const rows = safePositiveInteger(result.rowCount);
  if (rows === undefined) return "Read-only result checks completed";
  const suffix = result.truncated === true ? " shown within the result limit" : " verified";
  return `${rows} ${rows === 1 ? "row" : "rows"}${suffix}`;
}

function safePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * These are presentation-only backend toolkit entries. Mastra owns execution
 * and the stream adapter only exposes a deliberately small, redacted view of
 * its arguments and outputs to the browser.
 */
export const tesseraStudioToolkit: Toolkit = defineToolkit({
  inspect_current_context: {
    type: "backend" as const,
    render: CurrentContextTool,
  },
  inspect_catalog: {
    type: "backend" as const,
    render: CatalogSearchTool,
  },
  inspect_schema: {
    type: "backend" as const,
    render: SchemaInspectionTool,
  },
  inspect_database_capabilities: {
    type: "backend" as const,
    render: DatabaseCapabilitiesTool,
  },
  describe_data: {
    type: "backend" as const,
    render: CatalogDescriptionTool,
  },
  probe_data: {
    type: "backend" as const,
    render: DataProbeTool,
  },
  run_analysis: {
    type: "backend" as const,
    render: GovernedAnalysisTool,
  },
});
