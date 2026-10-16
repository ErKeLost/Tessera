"use client";

import { useCallback, useMemo } from "react";
import { ANSWER_RELATION_METRICS_TOOL, ANSWER_RELATION_PREVIEW_TOOL } from "../../../generative/openui-actions";
import { fetchStudioAnswerQuery } from "../../api/studio-api";
import type { AnswerApprovalPrompt } from "./answer-approval";
import type { AnswerApprovalDecision } from "./answer-approval-dialog";
import { useAnswerDatabaseAction } from "./use-answer-database-action";

export type AnswerToolProviderController = Readonly<{
  /** The function map OpenUI calls for `Query()` and `Mutation()`. */
  toolProvider: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  /** Set while a mutation is waiting for a human decision. */
  pending?: AnswerApprovalPrompt;
  decide: (decision: AnswerApprovalDecision) => void;
}>;

/**
 * The answer's data tools in one place.
 *
 * Reads go straight to the server, which derives everything from the catalog.
 * Writes reuse the governed mutation lifecycle, including the approval prompt.
 * Both are ordinary functions, so OpenUI's own error, loading, and retry
 * surfaces handle every failure without a second mechanism here.
 */
export function useAnswerToolProvider(): AnswerToolProviderController {
  const mutations = useAnswerDatabaseAction();

  const runPreview = useCallback(
    (args: Record<string, unknown>): Promise<unknown> =>
      fetchStudioAnswerQuery(ANSWER_RELATION_PREVIEW_TOOL, args),
    [],
  );

  const runMetrics = useCallback(
    (args: Record<string, unknown>): Promise<unknown> =>
      fetchStudioAnswerQuery(ANSWER_RELATION_METRICS_TOOL, args),
    [],
  );

  const toolProvider = useMemo(
    () => ({
      ...mutations.toolProvider,
      [ANSWER_RELATION_PREVIEW_TOOL]: runPreview,
      [ANSWER_RELATION_METRICS_TOOL]: runMetrics,
    }),
    [mutations.toolProvider, runPreview, runMetrics],
  );

  return {
    toolProvider,
    ...(mutations.pending === undefined ? {} : { pending: mutations.pending }),
    decide: mutations.decide,
  };
}
