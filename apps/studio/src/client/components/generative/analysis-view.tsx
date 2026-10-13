"use client";

import { Renderer, type ParseResult } from "@openuidev/react-lang";
import { Markdown } from "@lobehub/ui";
import { memo, useCallback, useState } from "react";
import { tesseraAnalysisLibrary } from "./analysis-library";

export type AnalysisViewProps = Readonly<{
  /** The whole assistant response. In OpenUI mode this is an openui-lang program. */
  response: string;
  /** True while the answer is still streaming, so interactions stay disabled. */
  isStreaming: boolean;
}>;

/**
 * Fallback shown when a finished response never produced a root statement, for
 * example because the model answered in prose instead of OpenUI Lang. Rendering
 * nothing would leave a blank message, so the raw text stays visible in a
 * subdued block and the failure is obvious rather than silent.
 */
const AnalysisFallback = memo(({ text }: { text: string }) => (
  <div className="tessera-analysis-fallback" role="status">
    <p className="tessera-analysis-fallback-note">This answer did not arrive as a view.</p>
    <Markdown
      className="aui-md lobehub-markdown"
      fullFeaturedCodeBlock={false}
      variant="chat"
    >
      {text}
    </Markdown>
  </div>
));

/**
 * Renders one Tessera analysis view. The renderer keeps the last valid program
 * on screen while a new one streams in, so a partial answer never blanks out.
 */
const AnalysisViewImpl = ({ response, isStreaming }: AnalysisViewProps) => {
  // "unknown" until the first parse result arrives, so a restored message never
  // flashes the fallback before its program has been read.
  const [parseState, setParseState] = useState<"unknown" | "rooted" | "rootless">("unknown");

  const handleParseResult = useCallback((result: ParseResult | null) => {
    const next = result?.root === null || result?.root === undefined ? "rootless" : "rooted";
    setParseState((current) => (current === next ? current : next));
  }, []);

  const failed = !isStreaming && parseState === "rootless";

  return (
    <div className="tessera-analysis" data-streaming={isStreaming ? "true" : undefined}>
      {failed ? (
        <AnalysisFallback text={response} />
      ) : (
        <Renderer
          isStreaming={isStreaming}
          library={tesseraAnalysisLibrary}
          onParseResult={handleParseResult}
          response={response}
        />
      )}
    </div>
  );
};

export const AnalysisView = memo(AnalysisViewImpl);
