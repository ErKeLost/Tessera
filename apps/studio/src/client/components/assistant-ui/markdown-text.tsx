"use client";

import { useMessagePartText } from "@assistant-ui/react";
import { Markdown } from "@lobehub/ui";
import { memo } from "react";

/** Render text and reasoning parts through the shared LobeHub markdown surface. */
const MarkdownTextImpl = () => {
  const { text, status } = useMessagePartText();

  return (
    <Markdown
      animated={status.type === "running"}
      className="aui-md lobehub-markdown"
      enableStream
      fullFeaturedCodeBlock
      variant="chat"
    >
      {text}
    </Markdown>
  );
};

export const MarkdownText = memo(MarkdownTextImpl);
