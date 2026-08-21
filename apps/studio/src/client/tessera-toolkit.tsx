"use client";

import {
  defineToolkit,
  type Toolkit,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  DatabaseZapIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
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
      {approvalHandles !== undefined ? (
        <ApprovalCard
          args={args}
          state={approvalState}
          result={result}
          onApprove={() => void respondToApproval("approve")}
          onReject={() => void respondToApproval("reject")}
        />
      ) : null}
    </>
  );
}

function ApprovalCard({
  args,
  result,
  state,
  onApprove,
  onReject,
}: {
  args: Record<string, unknown>;
  result?: SafeToolResult;
  state: ApprovalState;
  onApprove(): void;
  onReject(): void;
}) {
  const busy = state === "working";
  const operation = mutationSummary(args);
  const diagnostic = typeof result?.message === "string" ? result.message : undefined;
  const reason = typeof result?.reason === "string" ? result.reason : undefined;
  const isApproved = state === "approved";
  const isRejected = state === "rejected";
  const isFailed = state === "failed";
  const tone = isApproved
    ? "border-emerald-500/30 bg-emerald-500/5"
    : isRejected
      ? "border-muted-foreground/20 bg-muted/30"
      : isFailed
        ? "border-destructive/35 bg-destructive/5"
        : "border-amber-500/35 bg-amber-500/5";
  return (
    <div className={`mt-3 ms-5 overflow-hidden rounded-lg border shadow-sm ${tone}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="mt-0.5 rounded-md bg-background/80 p-2 shadow-xs">
          {isApproved ? <CheckCircle2Icon className="size-4 text-emerald-600" />
            : isRejected ? <XCircleIcon className="size-4 text-muted-foreground" />
              : isFailed ? <AlertTriangleIcon className="size-4 text-destructive" />
                : <ShieldAlertIcon className="size-4 text-amber-600" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <DatabaseZapIcon className="size-4 text-foreground/70" />
            {isApproved ? "数据库变更已执行" : isRejected ? "数据库变更已拒绝" : isFailed ? "数据库变更执行失败" : "需要确认数据库变更"}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {isApproved ? "操作已通过审批并完成。" : isRejected ? "未执行任何数据库变更。" : isFailed ? "数据库没有完成这次变更。" : "这项操作会修改数据，请确认后再继续。"}
          </p>
          <div className="mt-2 flex items-center gap-2 rounded-md bg-background/60 px-2.5 py-2 text-xs">
            <span className="text-muted-foreground">操作</span>
            <span className="truncate font-medium">{operation}</span>
          </div>
          {isFailed && (diagnostic || reason) ? (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
              <span className="font-medium">{reason ? `${reason}: ` : ""}</span>{diagnostic ?? "请检查数据库连接和变更条件。"}
            </div>
          ) : null}
        </div>
      </div>
      {!isApproved && !isRejected && !isFailed ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-background/35 px-4 py-2.5">
          <Button disabled={busy} onClick={onReject} size="sm" type="button" variant="outline">
            <XIcon className="size-3.5" />
            拒绝
          </Button>
          <Button disabled={busy} onClick={onApprove} size="sm" type="button">
            {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
            {busy ? "处理中" : "批准执行"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function mutationSummary(args: Record<string, unknown>): string {
  const mutation = args.mutation;
  if (!mutation || typeof mutation !== "object") return "已请求的数据库变更";
  const value = mutation as Record<string, unknown>;
  const relation = value.relation;
  const table = relation && typeof relation === "object" && typeof (relation as Record<string, unknown>).table === "string"
    ? String((relation as Record<string, unknown>).table)
    : undefined;
  const kind = typeof value.kind === "string" ? value.kind.replace(/^data\./, "") : "变更";
  return table ? `${kind} · ${table}` : kind;
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
