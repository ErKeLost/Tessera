"use client";

import { useAuiState, useMessagePartText } from "@assistant-ui/react";
import { memo } from "react";
import { AnalysisView } from "../generative/analysis-view";
import { useAnswerAction } from "../generative/use-answer-action";
import { useAnswerThreadId } from "../generative/answer-state-context";
import { useAnswerState } from "../generative/use-answer-state";

/**
 * Renders an assistant text part as an OpenUI program.
 *
 * This follows the OpenUI assistant-ui integration: the Markdown renderer is
 * replaced entirely, because the whole response is openui-lang rather than
 * prose with a fenced block in it.
 */
const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();
  const onAction = useAnswerAction();
  const messageId = useAuiState((state) => state.message.id);
  const threadId = useAnswerThreadId();
  const state = useAnswerState(threadId, messageId, text, status.type === "running");

  if (!state.ready) return <div className="tessera-answer-query-status" role="status">Restoring view…</div>;

  return (
    <AnalysisView
      isStreaming={status.type === "running"}
      onAction={onAction}
      response={text}
      initialState={state.initialState}
      onStateUpdate={state.update}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
