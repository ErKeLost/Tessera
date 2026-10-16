"use client";

import {
  Renderer,
  createParser,
  type ActionEvent,
} from "@openuidev/react-lang";
import { memo, useMemo } from "react";
import { MarkdownRenderer } from "./shadcn-genui/components/markdown-renderer";
import { shadcnChatLibrary } from "./shadcn-genui";
import { AnswerApprovalDialog } from "./answer-approval-dialog";
import { useAnswerToolProvider } from "./use-answer-tool-provider";

export type AnalysisViewProps = Readonly<{
  /** The whole assistant response. In OpenUI mode this is an openui-lang program. */
  response: string;
  /** True while the answer is still streaming, so interactions stay disabled. */
  isStreaming: boolean;
  /**
   * Receives the actions interactive blocks emit. The message layer owns what
   * they mean, so this view stays free of the chat runtime.
   */
  onAction?: (event: ActionEvent) => void;
}>;

/**
 * Module scope on purpose: the parser reads the library schema once instead of
 * on every chunk.
 */
const analysisParser = createParser(
  shadcnChatLibrary.toJSONSchema(),
  shadcnChatLibrary.root,
);

/**
 * Renders one streamed answer with the shadcn/ui component library.
 *
 * While tokens arrive the Renderer owns the output, because a partial program is
 * expected to be incomplete. Only once the stream settles is the response
 * classified: a real program that the library cannot render (an unknown
 * component) is reported as a failure, a prose answer keeps rendering as prose,
 * and neither case dumps openui-lang source at the reader.
 *
 * The answer can also carry `Query()` / `Mutation("database_action", ...)`
 * calls. Reads and writes both go through the server, which stays authoritative
 * over the catalog, policy, and approval; this view only supplies the provider
 * and the permission-driven approval surface.
 */
const AnalysisViewImpl = ({ response, isStreaming, onAction }: AnalysisViewProps) => {
  const parsed = useMemo(() => analysisParser.parse(response), [response]);
  const actions = useAnswerToolProvider();
  // OpenUI 1.0 also accepts a runtime entry (`root = $flag ? A : B`), which
  // lands on `rootExpression` with `root` left null until it is evaluated.
  const renders = parsed.root !== null || parsed.rootExpression !== undefined;
  const empty = response.trim().length === 0;

  if (!isStreaming && !renders) {
    if (empty) return null;
    // The parser saw program statements but produced no renderable root, so the
    // answer is a program this library cannot draw — not prose.
    if (parsed.meta.statementCount > 0) {
      return (
        <div className="tessera-analysis" data-slot="openui-fallback">
          <p className="tessera-analysis-fallback" role="alert">
            This answer could not be rendered.
          </p>
        </div>
      );
    }
    return (
      <div className="tessera-analysis">
        <MarkdownRenderer text={response} />
      </div>
    );
  }

  if (empty) return null;

  return (
    <div className="tessera-analysis" data-streaming={isStreaming ? "true" : undefined}>
      <Renderer.Root
        isStreaming={isStreaming}
        library={shadcnChatLibrary}
        response={response}
        toolProvider={actions.toolProvider}
        {...(onAction !== undefined && { onAction })}
      >
        <div className="tessera-analysis-relative">
          <Renderer.Content />
          <Renderer.QueryError>
            <p className="tessera-analysis-fallback" role="alert">
              This answer could not load its live data.
            </p>
            <Renderer.Retry>Try again</Renderer.Retry>
          </Renderer.QueryError>
        </div>
      </Renderer.Root>
      {actions.pending !== undefined ? (
        <AnswerApprovalDialog onDecide={actions.decide} prompt={actions.pending} />
      ) : null}
    </div>
  );
};

export const AnalysisView = memo(AnalysisViewImpl);
