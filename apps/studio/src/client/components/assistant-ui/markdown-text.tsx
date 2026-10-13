"use client";

import { useMessagePartText } from "@assistant-ui/react";
import { Markdown } from "@lobehub/ui";
import { memo, useMemo } from "react";
import { AnalysisView } from "../generative/analysis-view";
import { splitAnalysisFence } from "../generative/analysis-fence";

/**
 * Renders the Markdown answer plus, when the Agent emitted one, the structured
 * analysis view for the same verified results. The `openui-lang` fence is
 * pulled out of the prose so the program is never shown as a code block.
 */
const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();
  const isStreaming = status.type === "running";
  const { prose, code } = useMemo(() => splitAnalysisFence(text), [text]);

  return (
    <div className="aui-md-stack">
      {prose.length === 0 ? null : (
        <Markdown
          animated={isStreaming}
          className="aui-md lobehub-markdown"
          enableStream
          fullFeaturedCodeBlock={false}
          variant="chat"
        >
          {prose}
        </Markdown>
      )}
      {code.length === 0 ? null : <AnalysisView isStreaming={isStreaming} response={code} />}
    </div>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
