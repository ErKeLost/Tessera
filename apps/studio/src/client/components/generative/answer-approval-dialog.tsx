"use client";

import { Button } from "@heroui/react";
import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import type { AnswerApprovalPrompt } from "./answer-approval";

export type AnswerApprovalDecision = "approve" | "reject";

/**
 * The permission-driven approval surface for an action an answer wants to run.
 *
 * It renders only from browser-safe metadata: the server decides whether a
 * checkpoint exists, what the risk is, and what SQL was compiled. The approve
 * button is the destructive path, so it is the primary action only because the
 * server already classified the operation as requiring a human decision.
 */
export function AnswerApprovalDialog({
  prompt,
  onDecide,
}: {
  prompt: AnswerApprovalPrompt;
  onDecide: (decision: AnswerApprovalDecision) => void;
}) {
  return (
    <section
      className="tessera-approval-card"
      data-state="idle"
      role="alertdialog"
      aria-live="polite"
      aria-label="Approve database change"
    >
      <div className="tessera-approval-card-accent" aria-hidden="true" />
      <div className="tessera-approval-card-main">
        <header className="tessera-approval-card-header">
          <div className="tessera-approval-card-icon" aria-hidden="true">
            <ShieldAlertIcon />
          </div>
          <div className="tessera-approval-card-heading">
            <div className="tessera-approval-card-kicker">
              <span>Database action</span>
              {prompt.risk ? <span className="tessera-approval-card-status">{prompt.risk}</span> : null}
            </div>
            <h3>{prompt.title ?? "Review database change"}</h3>
            <p>{prompt.summary ?? "This action can change data. Review the scope before continuing."}</p>
          </div>
        </header>

        <div className="tessera-approval-card-details" aria-label="Change details">
          <div>
            <span>Operation</span>
            <strong>{prompt.operation}</strong>
          </div>
          <div>
            <span>Target</span>
            <strong>{prompt.target}</strong>
          </div>
        </div>

        {prompt.compiledSql !== undefined ? (
          <div className="tessera-approval-card-query">
            <span className="tessera-approval-card-section-label">SQL</span>
            <pre><code>{prompt.compiledSql}</code></pre>
            {prompt.parameters !== undefined && prompt.parameters.length > 0 ? (
              <details>
                <summary>Parameters ({prompt.parameters.length})</summary>
                <pre><code>{JSON.stringify(prompt.parameters, null, 2)}</code></pre>
              </details>
            ) : null}
          </div>
        ) : null}

        <footer className="tessera-approval-card-actions">
          <span className="tessera-approval-card-footnote">Nothing changes until you approve.</span>
          <div>
            <Button onPress={() => onDecide("reject")} type="button" variant="ghost">
              <XIcon />
              Decline
            </Button>
            <Button onPress={() => onDecide("approve")} type="button" variant="danger">
              <CheckIcon />
              Approve &amp; run
            </Button>
          </div>
        </footer>
      </div>
    </section>
  );
}
