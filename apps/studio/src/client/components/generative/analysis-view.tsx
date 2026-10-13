"use client";

import { Renderer } from "@openuidev/react-lang";
import { memo } from "react";
import { tesseraAnalysisLibrary } from "./analysis-library";

export type AnalysisViewProps = Readonly<{
  /** openui-lang program produced by the Agent. */
  response: string;
  /** True while the answer is still streaming, so interactions stay disabled. */
  isStreaming: boolean;
}>;

/**
 * Renders one Tessera analysis view. The renderer keeps the last valid program
 * on screen while a new one streams in, so a partial answer never blanks out.
 */
const AnalysisViewImpl = ({ response, isStreaming }: AnalysisViewProps) => (
  <div className="tessera-analysis" data-streaming={isStreaming ? "true" : undefined}>
    <Renderer response={response} library={tesseraAnalysisLibrary} isStreaming={isStreaming} />
  </div>
);

export const AnalysisView = memo(AnalysisViewImpl);
