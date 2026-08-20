import { useChat } from "@ai-sdk/react";
import {
  ActionBarPrimitive,
  AuiConfig,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  groupPartByType,
  makeAssistantDataUI,
  MessagePrimitive,
  ThreadPrimitive,
  Tools,
  useAui,
  useAuiState,
  unstable_useComposerInput,
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import {
  ChartBarIcon,
  CopyIcon,
  DatabaseIcon,
  FileSearchIcon,
  ListTreeIcon,
  PencilIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type {
  TesseraExecutionTraceData,
  TesseraUIMessage,
} from "../protocol";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageToolbar,
} from "./components/ai-elements/message";
import { MarkdownText } from "./components/assistant-ui/markdown-text";
import {
  ComposerAddAttachment,
  ComposerAttachments,
  UserMessageAttachments,
} from "./components/assistant-ui/attachment";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "./components/assistant-ui/reasoning";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { AgentActivity } from "./components/agent-activity";
import { ErrorState } from "./components/elements/error-state";
import { PromptInput } from "./components/agents/prompt-input";
import {
  ToolTimeline,
  type TimelineStep,
} from "./components/elements/tool-timeline";
import { Button } from "./components/ui/button";
import { tesseraStudioToolkit } from "./tessera-toolkit";

const tesseraStudioAssistantConfig = AuiConfig({
  tools: Tools({ toolkit: tesseraStudioToolkit }),
});

const TesseraExecutionTraceDataUI = makeAssistantDataUI<TesseraExecutionTraceData>({
  name: "tessera-execution",
  render: ({ data }) => <TesseraExecutionTrace data={data} />,
});

export function StudioAssistant({
  initialMessages,
  initialPrompt,
  isSendDisabled,
  onThreadActivity,
  threadId,
}: {
  initialMessages: readonly TesseraUIMessage[];
  initialPrompt?: string;
  isSendDisabled: boolean;
  onThreadActivity?(): void;
  threadId: string;
}) {
  const transport = useMemo(
    () =>
      new AssistantChatTransport<TesseraUIMessage>({
        api: "/api/chat",
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set("Content-Type", "application/json");
          return globalThis.fetch(input, { ...init, headers });
        }) as typeof fetch,
        prepareSendMessagesRequest: ({ body, messageId, messages, trigger }) => {
          const message = messages.at(-1);
          if (!message || message.role !== "user") {
            throw new Error("Tessera can only submit the current user message.");
          }
          return {
            headers: { "Content-Type": "application/json" },
            body: {
              ...(body ?? {}),
              id: threadId,
              ...(messageId === undefined ? {} : { messageId }),
              messages: [message],
              threadId,
              trigger,
            },
          };
        },
      }),
    [threadId],
  );
  const chat = useChat<TesseraUIMessage>({
    id: threadId,
    messages: [...initialMessages],
    onFinish: () => onThreadActivity?.(),
    transport,
  });
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialMessages.length > 0 || isSendDisabled || initialPromptSent.current) return;
    initialPromptSent.current = true;
    void chat.sendMessage({ text: initialPrompt });
  }, [chat, initialMessages.length, initialPrompt, isSendDisabled]);
  const runtime = useAISDKRuntime<TesseraUIMessage>(chat, { isSendDisabled });
  transport.setRuntime(runtime);

  return (
    <AssistantRuntimeProvider config={tesseraStudioAssistantConfig} runtime={runtime}>
      <TesseraExecutionTraceDataUI />
      <StudioConversation />
    </AssistantRuntimeProvider>
  );
}

function StudioConversation() {
  return (
    <section className="tessera-chat-surface" aria-label="Data analysis conversation">
      <ThreadPrimitive.Root className="tessera-thread-root">
        <ThreadPrimitive.Viewport
          autoScroll
          className="tessera-thread-viewport"
        >
          <Conversation className="tessera-conversation">
            <ConversationContent className="tessera-conversation-content">
              <ThreadPrimitive.Messages>
                {() => <StudioMessage />}
              </ThreadPrimitive.Messages>
            </ConversationContent>
            <ConversationScrollButton
              aria-label="Scroll to latest message"
              className="tessera-conversation-scroll"
            />
          </Conversation>
        </ThreadPrimitive.Viewport>
        <footer className="tessera-composer-dock">
          <StudioComposer />
        </footer>
      </ThreadPrimitive.Root>
    </section>
  );
}

function StudioMessage() {
  const role = useAuiState((state) => state.message.role);
  const isEditing = useAuiState((state) => state.message.composer.isEditing);

  if (isEditing) return <StudioEditComposer />;
  return role === "user" ? <StudioUserMessage /> : <StudioAssistantMessage />;
}

function StudioAssistantMessage() {
  const hasAssistantOutput = useAuiState((state) =>
    state.message.parts.some((part) =>
      part.type === "text" && part.text.trim().length > 0,
    ),
  );

  return (
    <MessagePrimitive.Root className="tessera-message-root tessera-assistant-message">
      <Message className="w-full max-w-none gap-1.5" from="assistant">
        <MessageContent className="tessera-message-content tessera-assistant-message-content w-full gap-1.5 text-[13px] leading-5">
          <MessagePrimitive.GroupedParts
            groupBy={groupPartByType({
              reasoning: ["group-chainOfThought", "group-reasoning"],
              "tool-call": ["group-chainOfThought", "group-tool"],
              "standalone-tool-call": [],
            })}
          >
            {({ children, part }) => {
              switch (part.type) {
                case "group-chainOfThought":
                  return <div className="tessera-chain-of-thought space-y-0.5">{children}</div>;
                case "group-tool":
                  return <div className="tessera-tool-group space-y-0.5">{children}</div>;
                case "group-reasoning": {
                  const streaming = part.status.type === "running";
                  return (
                    <ReasoningRoot streaming={streaming}>
                      {streaming ? (
                        <AgentActivity
                          label="Planning governed analysis"
                          state="thinking"
                        />
                      ) : null}
                      <ReasoningTrigger active={streaming} />
                      <ReasoningContent aria-busy={streaming}>
                        <ReasoningText>{children}</ReasoningText>
                      </ReasoningContent>
                    </ReasoningRoot>
                  );
                }
                case "text":
                  return <MarkdownText />;
                case "reasoning":
                  return <Reasoning {...part} />;
                case "tool-call":
                  // Studio's server allowlist has two presentation-only tools.
                  // Each one is registered in the Assistant UI toolkit and
                  // renders through the official Tool Call Element.
                  return part.toolUI ?? null;
                case "data":
                  return part.dataRendererUI ?? <></>;
                case "indicator":
                  return hasAssistantOutput
                    ? null
                    : <AgentActivity label="Preparing analysis" state="thinking" />;
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
          <MessageError />
        </MessageContent>
        <MessageToolbar className="tessera-message-toolbar">
          <AssistantActions />
        </MessageToolbar>
      </Message>
    </MessagePrimitive.Root>
  );
}

function StudioUserMessage() {
  return (
    <MessagePrimitive.Root className="tessera-message-root tessera-user-message">
      <Message className="ml-auto w-fit max-w-[72%] gap-1" from="user">
        <UserMessageAttachments />
        <MessageContent className="tessera-message-content tessera-user-message-content rounded-md px-3 !py-1.5 text-[13px] leading-5">
          <MessagePrimitive.Parts>
            {({ part }) => (part.type === "text" ? <MarkdownText /> : null)}
          </MessagePrimitive.Parts>
        </MessageContent>
        <MessageToolbar className="tessera-message-toolbar tessera-user-toolbar">
          <UserActions />
        </MessageToolbar>
      </Message>
    </MessagePrimitive.Root>
  );
}

function MessageError() {
  const [retryRequested, setRetryRequested] = useState(false);
  const retryRef = useRef<HTMLButtonElement>(null);
  const isThreadRunning = useAuiState((state) => state.thread.isRunning);

  // A retry request is only in flight while the runtime is actually running.
  // The previous local-only flag survived a second terminal stream error and
  // incorrectly rendered the stale "Retrying" state.
  const retrying = retryRequested && isThreadRunning;

  useEffect(() => {
    if (!isThreadRunning) setRetryRequested(false);
  }, [isThreadRunning]);

  return (
    <MessagePrimitive.Error>
      <ErrorState
        detail="The local agent stopped before it could return a verified result."
        onRetry={() => {
          if (retryRef.current?.disabled) return;
          setRetryRequested(true);
          retryRef.current?.click();
        }}
        retrying={retrying}
        title="Analysis interrupted"
      />
      <ActionBarPrimitive.Reload asChild>
        <button
          aria-hidden="true"
          className="sr-only"
          ref={retryRef}
          tabIndex={-1}
          type="button"
        />
      </ActionBarPrimitive.Reload>
    </MessagePrimitive.Error>
  );
}

function AssistantActions() {
  return (
    <MessageActions>
      <ActionBarPrimitive.Copy asChild>
        <MessageAction label="Copy response" tooltip="Copy response">
          <CopyIcon aria-hidden="true" size={14} />
        </MessageAction>
      </ActionBarPrimitive.Copy>
    </MessageActions>
  );
}

function UserActions() {
  return (
    <MessageActions>
      <ActionBarPrimitive.Edit asChild>
        <MessageAction label="Edit message" tooltip="Edit message">
          <PencilIcon aria-hidden="true" size={14} />
        </MessageAction>
      </ActionBarPrimitive.Edit>
    </MessageActions>
  );
}

function StudioEditComposer() {
  return (
    <MessagePrimitive.Root className="tessera-message-root tessera-user-message">
      <ComposerPrimitive.Root className="tessera-edit-composer">
        <ComposerPrimitive.Input
          aria-label="Edit message"
          className="tessera-edit-composer-input"
          autoFocus
          rows={2}
        />
        <div className="tessera-edit-composer-actions">
          <ComposerPrimitive.Cancel asChild>
            <Button size="sm" type="button" variant="ghost">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" type="submit">
              Save
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function StudioComposer() {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const aui = useAui();
  const composer = unstable_useComposerInput();
  const addAttachments = async (files: File[]) => {
    await Promise.all(files.map(async (file) => {
      try {
        await aui.composer.addAttachment(file);
      } catch {
        // assistant-ui reports attachment failures through its runtime state.
      }
    }));
  };

  return (
    <ComposerPrimitive.Root>
      <PromptInput
        aria-label="Ask Tessera to analyze your data"
        autoFocus
        className="tessera-composer studio-composer"
        attachments={<ComposerAttachments />}
        disabled={composer.isDisabled || !composer.canSend}
        hasAttachments={attachmentCount > 0}
        leadingAction={<ComposerAddAttachment />}
        loading={isRunning}
        onPasteFiles={addAttachments}
        onDropFiles={addAttachments}
        onStop={() => aui.composer.cancel()}
        onSubmit={() => composer.send()}
        onValueChange={composer.setText}
        placeholder="Ask about your data..."
        value={composer.value}
      />
    </ComposerPrimitive.Root>
  );
}

function TesseraExecutionTrace({ data }: { data: TesseraExecutionTraceData }) {
  const [open, setOpen] = useState(data.status !== "completed");
  const isRunning = data.status === "running";
  const steps = data.stages.map((stage): TimelineStep => ({
    chip: stageChip(stage.stage),
    icon: stageIcon(stage.stage),
    verb: stageLabel(stage.stage),
  }));
  const currentStep = steps.at(-1);
  const hasExecutedAnalysis = data.stages.some((stage) => stage.stage === "executing");

  useEffect(() => {
    setOpen(data.status !== "completed");
  }, [data.status]);

  return (
    <ToolTimeline
      activeLabel={currentStep?.verb ?? "Preparing analysis"}
      onOpenChange={setOpen}
      open={open}
      restingLabel={data.status === "completed"
        ? hasExecutedAnalysis ? "Verified analysis" : "Analysis path checked"
        : "Analysis stopped"}
      stats={[]}
      steps={steps}
      streaming={isRunning}
      visibleSteps={steps.length}
    />
  );
}

function stageLabel(stage: TesseraExecutionTraceData["stages"][number]["stage"]) {
  if (stage === "catalog") return "Inspect catalog";
  if (stage === "retrieval") return "Find relevant data";
  if (stage === "planning") return "Plan analysis";
  if (stage === "probing") return "Check data signals";
  if (stage === "compiling") return "Compile analysis";
  if (stage === "executing") return "Run governed analysis";
  if (stage === "verifying") return "Verify result";
  if (stage === "publishing") return "Prepare result";
  return "Write answer";
}

function stageChip(stage: TesseraExecutionTraceData["stages"][number]["stage"]): string {
  if (stage === "catalog") return "schema";
  if (stage === "retrieval") return "retrieval";
  if (stage === "planning") return "plan";
  if (stage === "probing") return "probe";
  if (stage === "compiling") return "compile";
  if (stage === "executing") return "execute";
  if (stage === "verifying") return "verify";
  if (stage === "publishing") return "result";
  return "answer";
}

function stageIcon(stage: TesseraExecutionTraceData["stages"][number]["stage"]): LucideIcon {
  if (stage === "catalog" || stage === "retrieval") return DatabaseIcon;
  if (stage === "planning" || stage === "compiling") return ListTreeIcon;
  if (stage === "probing" || stage === "verifying") return FileSearchIcon;
  if (stage === "executing") return TerminalIcon;
  return ChartBarIcon;
}
