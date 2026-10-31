"use client";

import {
  Renderer,
  createParser,
  parseMessage,
  type OpenUIError,
  type ActionEvent,
} from "@openuidev/react-lang";
import { memo, useCallback, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import { MarkdownRenderer } from "./shadcn-genui/components/markdown-renderer";
import { heroChatLibrary } from "./heroui-genui";
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
  initialState?: Record<string, unknown>;
  onStateUpdate?: (state: Record<string, unknown>) => void;
}>;

/**
 * Module scope on purpose: the parser reads the library schema once instead of
 * on every chunk.
 */
const analysisParser = createParser(
  heroChatLibrary.toJSONSchema(),
  heroChatLibrary.root,
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
const AnalysisViewImpl = ({ response, isStreaming, onAction, initialState, onStateUpdate }: AnalysisViewProps) => {
  const message = useMemo(() => parseMessage(response, { streaming: isStreaming }), [response, isStreaming]);
  // The Renderer parses partial chunks itself. Avoid parsing the entire stream twice.
  const parsed = useMemo(() => isStreaming ? null : analysisParser.parse(message.content), [message.content, isStreaming]);
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const onError = useCallback((next: OpenUIError[]) => {
    const visible = next.filter((error) => error.severity !== "warning");
    const key = JSON.stringify(visible);
    setErrors((current) => JSON.stringify(current) === key ? current : visible);
  }, []);
  const actions = useAnswerToolProvider();
  // OpenUI 1.0 also accepts a runtime entry (`root = $flag ? A : B`), which
  // lands on `rootExpression` with `root` left null until it is evaluated.
  const renders = parsed !== null && (parsed.root !== null || parsed.rootExpression !== undefined);
  const empty = message.content.trim().length === 0;

  if (!isStreaming && !renders) {
    if (empty) return null;
    // The parser saw program statements but produced no renderable root, so the
    // answer is a program this library cannot draw — not prose.
    if (parsed && parsed.meta.statementCount > 0) {
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
        <MarkdownRenderer text={message.content} />
      </div>
    );
  }

  if (empty) return null;

  return (
    <div className="tessera-analysis tessera-heroui" data-ui-library="heroui" data-streaming={isStreaming ? "true" : undefined}>
      {/* Avoid OpenUI 1.0.2's synchronous devtools state updates per token
          (upstream issues/990 and pull/1290). onError still reports errors. */}
      <Renderer.Root
        publishObservability={false}
        isStreaming={isStreaming}
        library={heroChatLibrary}
        response={response}
        toolProvider={actions.toolProvider}
        onError={onError}
        {...(initialState === undefined ? {} : { initialState })}
        {...(onStateUpdate === undefined ? {} : { onStateUpdate })}
        {...(onAction !== undefined && { onAction })}
      >
        <div className="tessera-analysis-relative">
          <Renderer.Content />
          <Renderer.QueryLoading>
            <div className="tessera-answer-query-status" role="status"><Spinner size="sm" /><span>Updating data…</span></div>
          </Renderer.QueryLoading>
          <Renderer.QueryError>
            <p className="tessera-analysis-fallback" role="alert">
              This answer could not load its live data.
            </p>
            <Renderer.Retry>Try again</Renderer.Retry>
          </Renderer.QueryError>
          {!isStreaming && errors.some((error) => error.source === "parser" || error.source === "runtime") ? (
            <p className="tessera-analysis-fallback" role="alert">Part of this answer could not be rendered. You can ask the assistant to regenerate it.</p>
          ) : null}
        </div>
      </Renderer.Root>
      {actions.pending !== undefined ? (
        <AnswerApprovalDialog onDecide={actions.decide} prompt={actions.pending} />
      ) : null}
    </div>
  );
};

export const AnalysisView = memo(AnalysisViewImpl);
