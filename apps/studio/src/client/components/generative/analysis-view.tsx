"use client";

import { Renderer, createParser } from "@openuidev/react-lang";
import { Markdown } from "@lobehub/ui";
import { memo, useMemo } from "react";
import { tesseraAnalysisLibrary } from "./analysis-library";

export type AnalysisViewProps = Readonly<{
  /** The whole assistant response. In OpenUI mode this is an openui-lang program. */
  response: string;
  /** True while the answer is still streaming, so interactions stay disabled. */
  isStreaming: boolean;
}>;

/**
 * Module scope on purpose: the parser reads the library schema once instead of
 * on every chunk.
 */
const analysisParser = createParser(
  tesseraAnalysisLibrary.toJSONSchema(),
  tesseraAnalysisLibrary.root,
);

/**
 * Renders one Tessera analysis view.
 *
 * Whether the response can be rendered is decided here rather than in an
 * `onParseResult` callback: unmounting the Renderer to show a fallback would
 * stop the callbacks that could bring it back. A response with no root is
 * shown as prose instead, so the message is never blank.
 */
const AnalysisViewImpl = ({ response, isStreaming }: AnalysisViewProps) => {
  const rooted = useMemo(() => analysisParser.parse(response).root !== null, [response]);

  if (!rooted) {
    return response.trim().length === 0 ? null : (
      <div className="tessera-analysis">
        <Markdown
          animated={isStreaming}
          className="aui-md lobehub-markdown"
          enableStream
          fullFeaturedCodeBlock={false}
          variant="chat"
        >
          {response}
        </Markdown>
      </div>
    );
  }

  return (
    <div className="tessera-analysis" data-streaming={isStreaming ? "true" : undefined}>
      <Renderer
        isStreaming={isStreaming}
        library={tesseraAnalysisLibrary}
        response={response}
      />
    </div>
  );
};

export const AnalysisView = memo(AnalysisViewImpl);
