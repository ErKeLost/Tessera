"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANSWER_DATABASE_ACTION_TOOL } from "../../../generative/openui-actions";
import {
  approveStudioDatabaseAction,
  rejectStudioDatabaseAction,
  submitStudioAnswerDatabaseAction,
  type StudioDatabaseActionEffect,
} from "../../api/studio-api";
import {
  completeAnswerMutation,
  describeAnswerActionEffect,
  type AnswerApprovalPrompt,
} from "./answer-approval";
import type { AnswerApprovalDecision } from "./answer-approval-dialog";

export type AnswerDatabaseActionController = Readonly<{
  /** The function-map entry OpenUI calls for `Mutation("database_action", ...)`. */
  toolProvider: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Set while the server is waiting for a human decision. */
  pending?: AnswerApprovalPrompt;
  decide: (decision: AnswerApprovalDecision) => void;
}>;

function readMutationArgs(raw: Record<string, unknown>): { mutation: unknown; purpose: string } {
  return {
    mutation: raw.mutation,
    purpose: typeof raw.purpose === "string" ? raw.purpose : "",
  };
}

/**
 * Runs one answer-triggered database mutation end to end.
 *
 * The promise settles only when the action reaches a terminal state, so the
 * OpenUI `Mutation()` result already reflects the permission outcome:
 * - the server refuses it (no checkpoint) → the program renders the failure;
 * - the server requires approval → the host shows the approval surface and the
 *   mutation stays `loading` until the reader decides;
 * - approved → the existing governed service executes it.
 *
 * Approval itself is never reimplemented here; it reuses the same
 * `/api/database-actions/:requestId/approval` endpoint as the Agent tool path.
 */
export function useAnswerDatabaseAction(): AnswerDatabaseActionController {
  const [pending, setPending] = useState<AnswerApprovalPrompt | undefined>();
  const resolver = useRef<((decision: AnswerApprovalDecision) => void) | undefined>(undefined);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; resolver.current?.("reject"); resolver.current = undefined; };
  }, []);

  const decide = useCallback((decision: AnswerApprovalDecision) => {
    const resolve = resolver.current;
    resolver.current = undefined;
    setPending(undefined);
    resolve?.(decision);
  }, []);

  const run = useCallback(async (raw: Record<string, unknown>): Promise<unknown> => {
    if (active.current) throw new Error("A database change is already in progress for this answer.");
    active.current = true;
    try {
    const submitted = await submitStudioAnswerDatabaseAction(readMutationArgs(raw));
    const outcome = describeAnswerActionEffect(submitted);
    if (outcome.status !== "awaiting_approval") {
      return completeAnswerMutation(outcome);
    }

    if (!mounted.current) throw new Error("The answer was closed before approval.");

    const decision = await new Promise<AnswerApprovalDecision>((resolve) => {
      resolver.current = resolve;
      setPending(outcome);
    });

    if (!mounted.current) throw new Error("The answer was closed before approval.");
    const decided: StudioDatabaseActionEffect = decision === "approve"
      ? await approveStudioDatabaseAction(outcome.requestId, outcome.checkpointId)
      : await rejectStudioDatabaseAction(outcome.requestId, outcome.checkpointId);
    return completeAnswerMutation(describeAnswerActionEffect(decided));
    } finally { active.current = false; }
  }, []);

  const toolProvider = useMemo(() => ({ [ANSWER_DATABASE_ACTION_TOOL]: run }), [run]);

  return {
    toolProvider,
    ...(pending === undefined ? {} : { pending }),
    decide,
  };
}
