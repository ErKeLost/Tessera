"use client";

import { useMessagePartText } from "@assistant-ui/react";
import { memo } from "react";
import { AnalysisView } from "../generative/analysis-view";

/**
 * Renders an assistant text part as an OpenUI program.
 *
 * This follows the OpenUI assistant-ui integration: the Markdown renderer is
 * replaced entirely, because the whole response is openui-lang rather than
 * prose with a fenced block in it.
 */
const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();

  return <AnalysisView isStreaming={status.type === "running"} response={text} />;
};

export const MarkdownText = memo(MarkdownTextImpl);
