"use client";

import {
  defineToolkit,
  type Toolkit,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { approveStudioDatabaseAction, rejectStudioDatabaseAction } from "./api/studio-api";
import { AgentActivity } from "./components/agent-activity";
import { ToolCall } from "./components/elements/tool-call";

type SafeToolResult = Record<string, unknown>;
type TesseraToolKind = "database" | "catalog" | "sql" | "analysis";
type ApprovalResolution = Readonly<{
  state: "idle" | "working" | "approved" | "rejected" | "failed";
  affectedRows?: number;
}>;

const ListDatabaseTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="database"
    label="Listing database context"
    completeLabel="Listed database context"
    detail={databaseDetail(props.result)}
  />
);

const ListCatalogTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="catalog"
    label="Listing permitted data"
    completeLabel="Listed permitted data"
    detail={catalogDetail(props.result)}
  />
);

const ExecuteSqlTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall
    {...props}
    kind="sql"
    label="Executing SQL"
    completeLabel="Executed SQL"
    detail={sqlDetail(props.result)}
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
  const [approval, setApproval] = useState<ApprovalResolution>({ state: "idle" });
  const approvalHandles = sqlApprovalHandles(result);
  const needsApproval = (status.type === "requires-action" || approvalHandles !== undefined)
    && approval.state !== "approved"
    && approval.state !== "rejected";
  const title = running ? label : needsApproval ? `${label} needs approval` : completeLabel;
  const [open, setOpen] = useState(running || failed || needsApproval);

  useEffect(() => {
    if (running || failed || needsApproval) setOpen(true);
  }, [running, failed, needsApproval]);

  const request = toolRequest(kind);
  const chip = toolChip(kind);
  const resolvedDetail = approvalDetail(approval) ?? detail;

  const respondToApproval = async (decision: "approve" | "reject") => {
    if (approvalHandles === undefined || approval.state === "working") return;
    setApproval({ state: "working" });
    try {
      const effect = decision === "approve"
        ? await approveStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId)
        : await rejectStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId);
      if (decision === "reject" || effect.summary.status === "cancelled") {
        setApproval({ state: "rejected" });
      } else if (effect.summary.status === "succeeded") {
        setApproval({
          state: "approved",
          ...(effect.result?.affectedRows === undefined ? {} : { affectedRows: effect.result.affectedRows }),
        });
      } else {
        setApproval({ state: "failed" });
      }
    } catch {
      setApproval({ state: "failed" });
    }
  };

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
        result={`${resolvedDetail}${result?.truncated === true ? " Result limit reached." : ""}`}
        running={running}
      />
      {approvalHandles !== undefined && approval.state !== "approved" && approval.state !== "rejected" ? (
        <div className="mt-2 flex items-center gap-2 ps-5">
          <Button
            disabled={approval.state === "working"}
            onClick={() => void respondToApproval("approve")}
            size="sm"
            type="button"
          >
            {approval.state === "working"
              ? <LoaderCircleIcon className="size-3.5 animate-spin" />
              : <CheckIcon className="size-3.5" />}
            Approve
          </Button>
          <Button
            disabled={approval.state === "working"}
            onClick={() => void respondToApproval("reject")}
            size="sm"
            type="button"
            variant="outline"
          >
            <XIcon className="size-3.5" />
            Reject
          </Button>
        </div>
      ) : null}
    </>
  );
}

function toolChip(kind: TesseraToolKind): string {
  return kind;
}

function toolRequest(kind: TesseraToolKind): string {
  if (kind === "catalog") return "Read governed catalog metadata";
  if (kind === "database") return "Read bounded database metadata";
  if (kind === "sql") return "Execute a governed database operation";
  return "Run a governed read-only analysis";
}

function databaseDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Reading connected database metadata";
  if (result.status === "blocked") return "The requested database context is unavailable";
  if (result.scope === "current") {
    const count = safePositiveInteger(result.entityCount);
    return count === undefined ? "Selected data context is ready" : `${count} selected ${count === 1 ? "entity is" : "entities are"} ready`;
  }
  if (result.scope === "schema") return schemaDetail(result);
  if (result.scope === "capabilities") {
    const count = safePositiveInteger(result.componentCount);
    return count === undefined ? "Database capabilities are ready" : `${count} database capabilities listed`;
  }
  return "Database context is ready";
}

function catalogDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Reviewing the governed schema";
  if (result.status === "blocked") return "No permitted catalog path was available";
  const count = safePositiveInteger(result.entityCount);
  return count === undefined
    ? "Catalog listing completed"
    : `${count} permitted ${count === 1 ? "entity is" : "entities are"} available`;
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

function sqlDetail(result: SafeToolResult | undefined): string {
  if (!result) return "Applying database safeguards";
  if (result.status === "approval_required") return "A database change is waiting for your approval";
  if (result.status === "blocked") return "The database operation was blocked";
  if (result.mode === "mutation") {
    const rows = safePositiveInteger(result.affectedRows);
    return rows === undefined ? "Database change completed" : `${rows} ${rows === 1 ? "row was" : "rows were"} changed`;
  }
  const rows = safePositiveInteger(result.rowCount);
  return rows === undefined ? "Read query completed" : `${rows} ${rows === 1 ? "row was" : "rows were"} returned`;
}

function sqlApprovalHandles(result: SafeToolResult | undefined): Readonly<{ requestId: string; checkpointId: string }> | undefined {
  return result?.status === "approval_required"
    && typeof result.requestId === "string"
    && typeof result.checkpointId === "string"
    ? { requestId: result.requestId, checkpointId: result.checkpointId }
    : undefined;
}

function approvalDetail(approval: ApprovalResolution): string | undefined {
  if (approval.state === "working") return "Applying your approval decision";
  if (approval.state === "rejected") return "Database change rejected; no change was applied";
  if (approval.state === "failed") return "The approval decision could not be completed";
  if (approval.state !== "approved") return undefined;
  return approval.affectedRows === undefined
    ? "Approved database change completed"
    : `Approved database change completed for ${approval.affectedRows} ${approval.affectedRows === 1 ? "row" : "rows"}`;
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
  list_database: {
    type: "backend" as const,
    render: ListDatabaseTool,
  },
  list_catalog: {
    type: "backend" as const,
    render: ListCatalogTool,
  },
  execute_sql: {
    type: "backend" as const,
    render: ExecuteSqlTool,
  },
  run_analysis: {
    type: "backend" as const,
    render: GovernedAnalysisTool,
  },
});
