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
  RotateCcwIcon,
  ShieldAlertIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  approveStudioDatabaseAction,
  fetchStudioDatabaseAction,
  rejectStudioDatabaseAction,
  retryStudioDatabaseAction,
  type StudioDatabaseActionEffect,
} from "./api/studio-api";
import { ToolCall } from "./components/elements/tool-call";

type SafeToolResult = Record<string, unknown>;
type ApprovalState = "loading" | "idle" | "working" | "approved" | "rejected" | "failed";
type NativeToolProps = ToolCallMessagePartProps<Record<string, unknown>, unknown>;

export const TesseraToolFallback: ToolCallMessagePartComponent<Record<string, unknown>, unknown> = (props) => (
  <TesseraToolCall {...props} />
);

const NativeTesseraTool = TesseraToolFallback;

function TesseraToolCall({
  args,
  argsText,
  result,
  status,
  toolName,
}: NativeToolProps) {
  const safeResult = asSafeToolResult(result);
  const running = status.type === "running";
  const failedResult = safeResult?.error === true
    || typeof safeResult?.error === "string"
    || safeResult?.status === "failed"
    || safeResult?.status === "blocked"
    || safeResult?.status === "rejected"
    || safeResult?.status === "unavailable";
  const failed = status.type === "incomplete" || failedResult;
  const initialApprovalHandles = sqlApprovalHandles(safeResult);
  const [approvalState, setApprovalState] = useState<ApprovalState>(
    initialApprovalHandles === undefined ? "idle" : "loading",
  );
  const [effect, setEffect] = useState<StudioDatabaseActionEffect>();
  const [clientError, setClientError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const approvalHandles = effect === undefined
    ? initialApprovalHandles
    : effectApprovalHandles(effect);
  // The approval surface is the review UI. Keep the implementation payload
  // collapsed while waiting so users see the action summary first, not a raw
  // JSON envelope.
  const shouldAutoOpen = running || failed;
  const [open, setOpen] = useState(shouldAutoOpen);

  useEffect(() => {
    setOpen(shouldAutoOpen);
  }, [shouldAutoOpen]);

  useEffect(() => {
    if (initialApprovalHandles === undefined) return;
    const controller = new AbortController();
    setApprovalState("loading");
    setClientError(undefined);
    void fetchStudioDatabaseAction(initialApprovalHandles.requestId, controller.signal)
      .then((nextEffect) => {
        setEffect(nextEffect);
        setApprovalState(approvalStateFromEffect(nextEffect));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setClientError(errorMessage(error));
        setApprovalState("failed");
      });
    return () => controller.abort();
  }, [initialApprovalHandles?.requestId]);

  const respondToApproval = async (decision: "approve" | "reject") => {
    if (approvalHandles === undefined || approvalState === "working") return;
    setApprovalState("working");
    setClientError(undefined);
    try {
      const nextEffect = decision === "approve"
        ? await approveStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId)
        : await rejectStudioDatabaseAction(approvalHandles.requestId, approvalHandles.checkpointId);
      setEffect(nextEffect);
      setApprovalState(decision === "reject" ? "rejected" : approvalStateFromEffect(nextEffect));
    } catch (error) {
      setClientError(errorMessage(error));
      setApprovalState("failed");
    }
  };

  const retryApproval = async () => {
    if (effect?.review === undefined || retrying) return;
    setRetrying(true);
    setClientError(undefined);
    try {
      const nextEffect = await retryStudioDatabaseAction(effect.summary.requestId);
      setEffect(nextEffect);
      setApprovalState(approvalStateFromEffect(nextEffect));
    } catch (error) {
      setClientError(errorMessage(error));
      setApprovalState("failed");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <ToolCall
        activeLabel={toolName}
        failed={failed}
        label={toolName}
        onOpenChange={setOpen}
        open={open}
        query={failed ? "failed" : status.type}
        request={formatToolInput(args, argsText, running)}
        result={formatToolValue(result)}
        running={running}
      />
      {initialApprovalHandles !== undefined ? (
        <ApprovalCard
          args={args}
          clientError={clientError}
          effect={effect}
          retrying={retrying}
          state={approvalState}
          result={safeResult}
          onApprove={() => void respondToApproval("approve")}
          onReject={() => void respondToApproval("reject")}
          onRetry={() => void retryApproval()}
        />
      ) : null}
    </>
  );
}

function ApprovalCard({
  args,
  clientError,
  effect,
  result,
  retrying,
  state,
  onApprove,
  onReject,
  onRetry,
}: {
  args: Record<string, unknown>;
  clientError?: string;
  effect?: StudioDatabaseActionEffect;
  result?: SafeToolResult;
  retrying: boolean;
  state: ApprovalState;
  onApprove(): void;
  onReject(): void;
  onRetry(): void;
}) {
  const busy = state === "loading" || state === "working" || retrying;
  const { operation, target } = mutationDetails(effect?.review?.action ?? args.mutation);
  const diagnostic = effect?.receipt?.diagnostic?.message
    ?? (typeof result?.message === "string" ? result.message : undefined)
    ?? clientError;
  const reason = effect?.receipt?.diagnostic?.code
    ?? (typeof result?.reason === "string" ? result.reason : undefined);
  const compiled = effect?.review?.compiled;
  const executionResult = effect?.result;
  const isApproved = state === "approved";
  const isRejected = state === "rejected";
  const isFailed = state === "failed";
  const stateLabel = isApproved
    ? "Completed"
    : isRejected
      ? "Declined"
      : isFailed
        ? "Execution failed"
        : state === "working"
          ? "Executing"
          : state === "loading"
            ? "Loading"
          : "Awaiting approval";
  const title = isApproved
    ? "Database change completed"
    : isRejected
      ? "Database change declined"
      : isFailed
        ? "Database change failed"
        : "Review database change";
  const description = isApproved
    ? "The approved operation was applied successfully."
    : isRejected
      ? "No database changes were applied."
      : isFailed
        ? "The database did not complete this operation."
        : "This action can change data. Review the scope before continuing.";
  return (
    <section className="tessera-approval-card" data-state={state} aria-live="polite">
      <div className="tessera-approval-card-accent" aria-hidden="true" />
      <div className="tessera-approval-card-main">
        <header className="tessera-approval-card-header">
          <div className="tessera-approval-card-icon" aria-hidden="true">
            {isApproved ? <CheckCircle2Icon />
              : isRejected ? <XCircleIcon />
                : isFailed ? <AlertTriangleIcon />
                  : <ShieldAlertIcon />}
          </div>
          <div className="tessera-approval-card-heading">
            <div className="tessera-approval-card-kicker">
              <span>Database action</span>
              <span className="tessera-approval-card-status">{stateLabel}</span>
            </div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
        </header>

        <div className="tessera-approval-card-details" aria-label="Change details">
          <div>
            <span>Operation</span>
            <strong>{operation}</strong>
          </div>
          <div>
            <span>Target</span>
            <strong>{target}</strong>
          </div>
        </div>

        {compiled !== undefined ? (
          <div className="tessera-approval-card-query">
            <span className="tessera-approval-card-section-label">SQL</span>
            <pre><code>{compiled.sql}</code></pre>
            {compiled.parameters.length > 0 ? (
              <details>
                <summary>Parameters ({compiled.parameters.length})</summary>
                <pre><code>{JSON.stringify(compiled.parameters, null, 2)}</code></pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {!isApproved && !isRejected && !isFailed ? (
          <div className="tessera-approval-card-warning">
            <DatabaseZapIcon aria-hidden="true" />
            <span>Nothing has changed yet. Approval is required before execution.</span>
          </div>
        ) : null}

        {isFailed && (diagnostic || reason) ? (
          <div className="tessera-approval-card-error" role="alert">
            <span className="tessera-approval-card-error-label">Execution error</span>
            <span><strong>{reason ? `${reason}: ` : ""}</strong>{diagnostic ?? "Check the database connection and change conditions."}</span>
          </div>
        ) : null}

        {isApproved && executionResult !== undefined ? (
          <div className="tessera-approval-card-result" aria-label="Execution result">
            <div className="tessera-approval-card-result-summary">
              <div><span>Affected rows</span><strong>{executionResult.affectedRows}</strong></div>
              <div><span>Duration</span><strong>{formatDuration(executionResult.durationMs)}</strong></div>
            </div>
            {executionResult.rows.length > 0 ? (
              <details open>
                <summary>Returned rows ({executionResult.rows.length})</summary>
                <pre><code>{JSON.stringify(executionResult.rows, null, 2)}</code></pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {!isApproved && !isRejected && !isFailed ? (
          <footer className="tessera-approval-card-actions">
            <span className="tessera-approval-card-footnote">You can review the request details above.</span>
            <div>
              <Button className="tessera-approval-card-reject" disabled={busy} onClick={onReject} type="button" variant="ghost">
                <XIcon />
                Decline
              </Button>
              <Button className="tessera-approval-card-approve" disabled={busy} onClick={onApprove} type="button">
                {busy ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}
                {busy ? "Working" : "Approve & run"}
              </Button>
            </div>
          </footer>
        ) : null}

        {isFailed ? (
          <footer className="tessera-approval-card-actions">
            <span className="tessera-approval-card-footnote">Retrying creates a new approval request.</span>
            <div>
              <Button
                className="tessera-approval-card-retry"
                disabled={busy || effect?.review === undefined}
                onClick={onRetry}
                type="button"
                variant="outline"
              >
                {retrying ? <LoaderCircleIcon className="animate-spin" /> : <RotateCcwIcon />}
                {retrying ? "Working" : "Try again"}
              </Button>
            </div>
          </footer>
        ) : null}
      </div>
    </section>
  );
}

function mutationDetails(mutation: unknown): { operation: string; target: string } {
  if (!mutation || typeof mutation !== "object") return { operation: "Database change", target: "Unknown target" };
  const value = mutation as Record<string, unknown>;
  const relation = value.relation;
  const relationValue = relation && typeof relation === "object" ? relation as Record<string, unknown> : undefined;
  const table = typeof relationValue?.table === "string" ? relationValue.table : undefined;
  const schema = typeof relationValue?.schema === "string" ? relationValue.schema : undefined;
  const kind = typeof value.kind === "string" ? value.kind.replace(/^data\./, "") : "change";
  return {
    operation: kind.charAt(0).toUpperCase() + kind.slice(1),
    target: table ? (schema ? `${schema}.${table}` : table) : "Unknown target",
  };
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

function asSafeToolResult(value: unknown): SafeToolResult | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as SafeToolResult
    : undefined;
}

function sqlApprovalHandles(result: SafeToolResult | undefined): Readonly<{ requestId: string; checkpointId: string }> | undefined {
  return result?.status === "approval_required"
    && typeof result.requestId === "string"
    && typeof result.checkpointId === "string"
    ? { requestId: result.requestId, checkpointId: result.checkpointId }
    : undefined;
}

function effectApprovalHandles(effect: StudioDatabaseActionEffect): Readonly<{ requestId: string; checkpointId: string }> | undefined {
  return effect.summary.status === "awaiting-approval"
    && effect.approval?.status === "pending"
    ? { requestId: effect.summary.requestId, checkpointId: effect.approval.checkpointId }
    : undefined;
}

function approvalStateFromEffect(effect: StudioDatabaseActionEffect): ApprovalState {
  if (effect.summary.status === "succeeded") return "approved";
  if (effect.summary.status === "awaiting-approval") return "idle";
  if (effect.approval?.status === "rejected" || effect.summary.status === "cancelled") return "rejected";
  if (effect.summary.status === "pending" || effect.summary.status === "approved" || effect.summary.status === "running" || effect.summary.status === "cancel-requested") {
    return "working";
  }
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Tessera could not load this database action.";
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1_000).toFixed(2)} s`;
}

export const tesseraStudioToolkit: Toolkit = defineToolkit({
  list_database: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
  list_extensions: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
  list_rls_policies: {
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
  present_ui: {
    type: "backend" as const,
    render: NativeTesseraTool,
  },
});
