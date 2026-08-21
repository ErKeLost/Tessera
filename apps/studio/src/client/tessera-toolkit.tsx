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
import { ToolCall } from "./components/elements/tool-call";

type SafeToolResult = Record<string, unknown>;
type ApprovalState = "idle" | "working" | "approved" | "rejected" | "failed";
type NativeToolProps = ToolCallMessagePartProps<Record<string, unknown>, SafeToolResult>;

const NativeTesseraTool: ToolCallMessagePartComponent<Record<string, unknown>, SafeToolResult> = (props) => (
  <TesseraToolCall {...props} />
);

function TesseraToolCall({
  args,
  argsText,
  result,
  status,
  toolName,
}: NativeToolProps) {
  const running = status.type === "running";
  const [approvalState, setApprovalState] = useState<ApprovalState>("idle");
  const approvalHandles = sqlApprovalHandles(result);
  const needsApproval = (status.type === "requires-action" || approvalHandles !== undefined)
    && approvalState !== "approved"
    && approvalState !== "rejected";
  const shouldAutoOpen = running || needsApproval;
  const [open, setOpen] = useState(shouldAutoOpen);

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  const respondToApproval = async (decision: "approve" | "reject") => {
    if (approvalHandles === undefined || approvalState === "working") return;
    setApprovalState("working");
    try {
      const effect = decision === "approve"
        ? await approveStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId)
        : await rejectStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId);
      if (decision === "reject" || effect.summary.status === "cancelled") {
        setApprovalState("rejected");
      } else {
        setApprovalState(effect.summary.status === "succeeded" ? "approved" : "failed");
      }
    } catch {
      setApprovalState("failed");
    }
  };

  return (
    <>
      <ToolCall
        activeLabel={toolName}
        label={toolName}
        onOpenChange={setOpen}
        open={open}
        query={status.type}
        request={formatToolInput(args, argsText, running)}
        result={formatToolValue(result)}
        running={running}
      />
      {approvalHandles !== undefined && approvalState !== "approved" && approvalState !== "rejected" ? (
        <div className="mt-2 flex items-center gap-2 ps-5">
          <Button
            disabled={approvalState === "working"}
            onClick={() => void respondToApproval("approve")}
            size="sm"
            type="button"
          >
            {approvalState === "working"
              ? <LoaderCircleIcon className="size-3.5 animate-spin" />
              : <CheckIcon className="size-3.5" />}
            Approve
          </Button>
          <Button
            disabled={approvalState === "working"}
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

function formatToolInput(args: Record<string, unknown>, argsText: string, running: boolean): string {
  if (running && argsText.trim().length > 0) return argsText;
  return formatToolValue(args) ?? "";
}

function formatToolValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function sqlApprovalHandles(result: SafeToolResult | undefined): Readonly<{ requestId: string; checkpointId: string }> | undefined {
  return result?.status === "approval_required"
    && typeof result.requestId === "string"
    && typeof result.checkpointId === "string"
    ? { requestId: result.requestId, checkpointId: result.checkpointId }
    : undefined;
}

export const tesseraStudioToolkit: Toolkit = defineToolkit({
  list_database: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
  list_catalog: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
  execute_sql: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
  run_analysis: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
});
