import { useChat } from "@ai-sdk/react";
import {
  ActionBarPrimitive,
  AuiConfig,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  Tools,
  useAssistantDataUI,
  useAui,
  useAuiState,
  unstable_useComposerInput,
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { BorderBeam } from "border-beam";
import { gooeyToast } from "goey-toast";
import {
  CopyIcon,
  CheckIcon,
  LoaderCircleIcon,
  PencilIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { TesseraSuspendedToolPayload, TesseraUIMessage } from "../protocol";
import {
  readStudioSettingsSnapshot,
  type StudioReasoningEffort,
  type StudioReasoningSelection,
  type StudioSettingsCandidate,
  type StudioSettingsSnapshot,
  type StudioSettingsTab,
} from "./studio-settings";
import { useStudioTheme } from "./studio-theme";
import type { StudioAgentPageContext, StudioAgentType } from "./layout/studio-route-context";
import { isStudioResumePayload } from "./studio-resume";
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
} from "./components/assistant-ui/reasoning";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { AgentActivity } from "./components/agent-activity";
import { ErrorState } from "./components/elements/error-state";
import { ProviderModelPicker, StudioModelBrandIcon } from "./components/elements/openrouter-model-picker";
import { ReasoningPanel } from "./components/elements/reasoning-panel";
import { WorkPanel } from "./components/elements/work-panel";
import { PromptInput } from "./components/agents/prompt-input";
import { Button } from "./components/ui/button";
import { useStudioFeishuQuery, useStudioSettingsQuery } from "./queries/studio-queries";
import { TesseraToolFallback, tesseraStudioToolkit } from "./tessera-toolkit";
import { AnswerThreadContext } from "./components/generative/answer-state-context";

const tesseraStudioAssistantConfig = AuiConfig({
  tools: Tools({ toolkit: tesseraStudioToolkit }),
});

const StudioThreadIdContext = AnswerThreadContext;
const StudioAgentTypeContext = createContext<StudioAgentType>("database");

export function StudioAssistant({
  initialMessages,
  initialPrompt,
  onOpenSettings,
  onThreadActivity,
  threadId,
  agentType = "database",
  onOpenFeishuAuthorization,
  workspaceContext,
}: {
  initialMessages: readonly TesseraUIMessage[];
  initialPrompt?: string;
  onOpenSettings(tab: StudioSettingsTab): void;
  onThreadActivity?(): void;
  threadId: string;
  agentType?: StudioAgentType;
  onOpenFeishuAuthorization?(): void;
  workspaceContext?: StudioAgentPageContext;
}) {
  // The transport stays stable while the table selection changes, while each
  // submitted turn receives the latest non-sensitive editor context.
  const workspaceContextRef = useRef<StudioAgentPageContext | undefined>(workspaceContext);
  workspaceContextRef.current = workspaceContext;
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
          // The server owns the tool registry. AssistantChatTransport adds an
          // empty `tools` field to the request body, but `/api/chat` never
          // consumes it and the client-side toolkit is registered above.
          const requestBody = { ...(body ?? {}) };
          delete (requestBody as { tools?: unknown }).tools;
          if (isStudioResumePayload(requestBody)) {
            return {
              api: "/api/chat/resume",
              headers: { "Content-Type": "application/json" },
              body: { ...requestBody, agentType },
            };
          }
          const message = messages.at(-1);
          if (!message || message.role !== "user") {
            throw new Error("Tessera can only submit the current user message.");
          }
          const currentWorkspaceContext = chatWorkspaceContext(workspaceContextRef.current);
          return {
            headers: { "Content-Type": "application/json" },
            body: {
              ...requestBody,
              id: threadId,
              ...(messageId === undefined ? {} : { messageId }),
              messages: [message],
              threadId,
              trigger,
              agentType,
              ...(currentWorkspaceContext === undefined ? {} : { workspaceContext: currentWorkspaceContext }),
            },
          };
        },
      }),
    [agentType, threadId],
  );
  const chat = useChat<TesseraUIMessage>({
    id: threadId,
    // Coalesce token bursts before updating the React external store. This
    // bounds OpenUI parsing/layout work without delaying the network stream.
    throttle: 50,
    messages: [...initialMessages],
    onFinish: () => {
      onThreadActivity?.();
    },
    transport,
  });
  const settingsQuery = useStudioSettingsQuery();
  const feishuQuery = useStudioFeishuQuery(agentType === "feishu");
  const configurationCheckRef = useRef(false);
  const ensureConfiguration = useMemo(() => async (send: () => void | Promise<void>) => {
    if (configurationCheckRef.current) return;
    configurationCheckRef.current = true;
    try {
      if (agentType === "feishu") {
        const connection = await feishuQuery.refetch();
        if (!connection.data?.connected) { onOpenFeishuAuthorization?.(); return; }
      }
      let status = settingsQuery.data;
      if (!status) {
        try {
          status = (await settingsQuery.refetch()).data;
        } catch {
          status = undefined;
        }
      }
      if (!status) {
        showConfigurationError(onOpenSettings);
        return;
      }
      const missingDatabase = agentType === "database" && !status.database.urlConfigured;
      const missingModelKey = !status.llm.apiKeyConfigured;
      if (missingDatabase || missingModelKey) {
        showMissingConfigurationToast({
          missingDatabase,
          missingModelKey,
          provider: status.llm.provider,
          onOpenSettings,
        });
        return;
      }
      await send();
    } finally {
      configurationCheckRef.current = false;
    }
  }, [agentType, feishuQuery.refetch, onOpenFeishuAuthorization, onOpenSettings, settingsQuery.data, settingsQuery.refetch]);
  const initialPromptSent = useRef(false);
  useEffect(() => {
    if (!initialPrompt || initialMessages.length > 0 || initialPromptSent.current) return;
    initialPromptSent.current = true;
    void ensureConfiguration(() => chat.sendMessage({ text: initialPrompt }));
  }, [chat, ensureConfiguration, initialMessages.length, initialPrompt]);
  const runtime = useAISDKRuntime<TesseraUIMessage>(chat, {
    onResume: async (config) => {
      // Mastra tool suspensions are a continuation of the current assistant
      // message. Use a normal AI SDK submit so useChat keeps that message's
      // tool invocation; resumeStream() is reserved for disconnect recovery
      // and intentionally starts with an empty continuation message.
      await chat.sendMessage(undefined, { body: config.runConfig.custom });
    },
  });
  transport.setRuntime(runtime);

  return (
    <AssistantRuntimeProvider config={tesseraStudioAssistantConfig} runtime={runtime}>
      <StudioAgentTypeContext.Provider value={agentType}>
      <StudioThreadIdContext.Provider value={threadId}>
        <StudioConversation onBeforeSend={ensureConfiguration} onOpenSettings={onOpenSettings} />
      </StudioThreadIdContext.Provider>
      </StudioAgentTypeContext.Provider>
    </AssistantRuntimeProvider>
  );
}

type StudioSendGuard = (send: () => void | Promise<void>) => Promise<void>;

function showConfigurationError(onOpenSettings: (tab: StudioSettingsTab) => void) {
  gooeyToast.error("无法读取工作区配置", {
    description: "请稍后重试，或打开设置检查数据库和模型配置。",
    action: {
      label: "打开设置",
      onClick: () => onOpenSettings("database"),
    },
  });
}

function showMissingConfigurationToast({
  missingDatabase,
  missingModelKey,
  onOpenSettings,
  provider,
}: {
  missingDatabase: boolean;
  missingModelKey: boolean;
  onOpenSettings: (tab: StudioSettingsTab) => void;
  provider: string;
}) {
  const missing = missingDatabase && missingModelKey
    ? "OpenRouter API Key 和数据库连接"
    : missingModelKey
      ? `${provider === "openrouter" ? "OpenRouter" : provider} API Key`
      : "数据库连接";
  const targetTab: StudioSettingsTab = missingModelKey ? "model" : "database";
  gooeyToast.warning("请先完成工作区配置", {
    description: `当前还没有配置${missing}，配置完成后才能发送分析请求。`,
    action: {
      label: "打开设置",
      onClick: () => onOpenSettings(targetTab),
    },
  });
}

function chatWorkspaceContext(context: StudioAgentPageContext | undefined) {
  if (!context) return undefined;
  return {
    ...(context.currentRelation === undefined ? {} : { currentRelation: context.currentRelation }),
    hasLocalFilter: context.hasLocalFilter,
    view: context.view,
  };
}

function StudioConversation({
  onBeforeSend,
  onOpenSettings,
}: {
  onBeforeSend: StudioSendGuard;
  onOpenSettings(tab: StudioSettingsTab): void;
}) {
  useAssistantDataUI({
    name: "tool-call-suspended",
    render: SuspendedApprovalDataRenderer,
  });
  return (
    <section className="tessera-chat-surface" aria-label="Data analysis conversation">
      <ThreadPrimitive.Root className="tessera-thread-root">
        <ThreadPrimitive.Viewport
          autoScroll
          className="tessera-thread-viewport"
        >
          <Conversation className="tessera-conversation">
            <ConversationContent className="tessera-conversation-content">
              <StudioEmptyState />
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
          <StudioComposer onBeforeSend={onBeforeSend} onOpenSettings={onOpenSettings} />
        </footer>
      </ThreadPrimitive.Root>
    </section>
  );
}

function SuspendedApprovalDataRenderer({ data }: { data: {
  state: "data-tool-call-suspended";
  runId: string;
  toolCallId: string;
  toolName: string;
  suspendPayload: TesseraSuspendedToolPayload;
  resumeSchema?: unknown;
} }) {
  const runtime = useAui();
  const threadId = useContext(StudioThreadIdContext);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject">();
  const review = data.suspendPayload;
  const runId = data.runId;
  const toolCallId = data.toolCallId;
  const respond = async (nextDecision: "approve" | "reject") => {
    if (busy || !threadId) return;
    setBusy(true);
    setDecision(nextDecision);
    try {
      await runtime.thread.resumeRun({
        parentId: null,
        sourceId: null,
        runConfig: {
          custom: {
            threadId,
            runId,
            toolCallId,
            decision: nextDecision,
            requestId: review.requestId,
            checkpointId: review.checkpointId,
          },
        },
      });
    } catch {
      setBusy(false);
      setDecision(undefined);
    }
  };
  return (
    <section className="tessera-approval-card" data-state={decision ?? "idle"} aria-live="polite">
      <div className="tessera-approval-card-accent" aria-hidden="true" />
      <div className="tessera-approval-card-main">
        <header className="tessera-approval-card-header">
          <div className="tessera-approval-card-icon" aria-hidden="true"><ShieldCheckIcon /></div>
          <div className="tessera-approval-card-heading">
            <div className="tessera-approval-card-kicker"><span>Database action</span><span className="tessera-approval-card-status">{decision ? (decision === "approve" ? "Running" : "Declined") : "Awaiting approval"}</span></div>
            <h3>{review.operation} · {review.target}</h3>
            <p>{review.purpose}</p>
          </div>
        </header>
        {review.compiled ? <div className="tessera-approval-card-query"><span className="tessera-approval-card-section-label">SQL</span><pre><code>{review.compiled.sql}</code></pre></div> : null}
        {!decision ? <footer className="tessera-approval-card-actions"><span className="tessera-approval-card-footnote">Nothing changes until you approve.</span><div><Button disabled={busy} onClick={() => void respond("reject")} type="button" variant="ghost"><XIcon />Decline</Button><Button disabled={busy} onClick={() => void respond("approve")} type="button"><CheckIcon />Approve &amp; run</Button></div></footer> : <div className="tessera-approval-card-warning"><LoaderCircleIcon className={busy ? "animate-spin" : undefined} aria-hidden="true" /><span>{decision === "approve" ? "Executing the approved change…" : "The change was declined."}</span></div>}
      </div>
    </section>
  );
}

function StudioEmptyState() {
  const agentType = useContext(StudioAgentTypeContext);
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);
  if (!isEmpty) return null;
  return (
    <div className="tessera-empty-state">
      <div className="tessera-empty-content">
        <h1>What would you like to analyze?</h1>
        <div className="tessera-starter-prompts" aria-label="Suggested analyses">
          {agentType === "feishu" ? <>
            <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="搜索我有权限的产品规划文档，概括主要方向并引用来源。">查找文档</ThreadPrimitive.Suggestion>
            <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="我想阅读一份飞书文档，我会提供文档链接。">阅读文档</ThreadPrimitive.Suggestion>
            <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="搜索项目相关的周报，整理进展与风险并引用来源。">归纳进展</ThreadPrimitive.Suggestion>
          </> : <>
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Show me the structure of this database and its most important tables.">Explore schema</ThreadPrimitive.Suggestion>
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Find the most important trends in this database.">Analyze trends</ThreadPrimitive.Suggestion>
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Check the data for quality issues and unusual values.">Check quality</ThreadPrimitive.Suggestion>
          </>}
        </div>
      </div>
    </div>
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
    state.message.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
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
                  return <StudioTraceGroup group={part}>{children}</StudioTraceGroup>;
                case "group-tool":
                  return <div className="tessera-tool-group space-y-0.5">{children}</div>;
                case "group-reasoning":
                  return <StudioReasoningGroup group={part} />;
                case "text":
                  return <MarkdownText />;
                case "reasoning":
                  return <Reasoning {...part} />;
                case "tool-call":
                  return part.toolUI ?? <TesseraToolFallback {...part} />;
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
        {hasAssistantOutput ? (
          <MessageToolbar className="tessera-message-toolbar">
            <AssistantActions />
          </MessageToolbar>
        ) : null}
      </Message>
    </MessagePrimitive.Root>
  );
}

type StudioReasoningGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * One run of agent work: every reasoning block and tool call between two
 * answers, collapsed behind a single `Working` / `Worked for 2m 35s` row.
 * The nested reasoning and tool rows keep their own disclosures inside it.
 */
function StudioTraceGroup({
  children,
  group,
}: {
  children: React.ReactNode;
  group: StudioReasoningGroupPart;
}) {
  const streaming = group.status.type === "running";
  const { open, setOpen, elapsedMs } = useStreamSpan(streaming);
  const count = group.indices.length;

  return (
    <WorkPanel
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
      elapsed={elapsedMs > 0 ? formatElapsed(elapsedMs) : undefined}
      detail={`${count} ${count === 1 ? "step" : "steps"}`}
    >
      <div className="tessera-chain-of-thought space-y-0.5">{children}</div>
    </WorkPanel>
  );
}

/**
 * Times one streaming span and holds its disclosure open while it runs, then
 * settles it closed and keeps the final wall clock for the resting label.
 */
function useStreamSpan(streaming: boolean, openWhileStreaming = true) {
  const [open, setOpen] = useState(streaming && openWhileStreaming);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(streaming ? Date.now() : null);

  useEffect(() => {
    if (!streaming) {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
        startedAtRef.current = null;
      }
      setOpen(false);
      return undefined;
    }

    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
      setElapsedMs(0);
    }
    if (openWhileStreaming) setOpen(true);
    const updateElapsed = () => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(interval);
  }, [openWhileStreaming, streaming]);

  return { open, setOpen, elapsedMs };
}

function StudioReasoningGroup({ group }: { group: StudioReasoningGroupPart }) {
  const messageParts = useAuiState((state) => state.message.parts);
  const streaming = group.status.type === "running";
  const { open, setOpen, elapsedMs } = useStreamSpan(streaming, false);

  const steps = group.indices.flatMap((index) => {
    const part = messageParts[index];
    if (part?.type !== "reasoning") return [];
    const body = part.text.trim();
    if (!body) return [];
    return [{
      title: part.unstable_summary?.trim() || "Reasoning",
      body,
    }];
  });
  const elapsed = formatElapsed(elapsedMs);

  return (
    <ReasoningPanel
      steps={steps}
      visibleSteps={steps.length}
      streaming={streaming}
      open={open}
      onOpenChange={setOpen}
      restingLabel={elapsedMs > 0 ? `Reasoned for ${elapsed}` : "Reasoned"}
      elapsed={elapsed}
    />
  );
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
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
        detail={<ErrorPrimitive.Message />}
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

function StudioComposer({
  onBeforeSend,
  onOpenSettings,
}: {
  onBeforeSend: StudioSendGuard;
  onOpenSettings(tab: StudioSettingsTab): void;
}) {
  const agentType = useContext(StudioAgentTypeContext);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const { resolvedTheme } = useStudioTheme();
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
    <ComposerPrimitive.Root className="tessera-composer-form">
      <BorderBeam
        active={isRunning}
        className="studio-composer-beam"
        colorVariant="sunset"
        duration={3.1}
        size="line"
        staticColors
        strength={0.64}
        theme={resolvedTheme}
      >
        <PromptInput
          aria-label="Ask Tessera to analyze your data"
          autoFocus
          className="tessera-composer studio-composer"
          attachments={<ComposerAttachments />}
          disabled={composer.isDisabled}
          footer={<StudioComposerSettings onOpenSettings={onOpenSettings} />}
          hasAttachments={attachmentCount > 0}
          leadingAction={<ComposerAddAttachment />}
          loading={isRunning}
          onPasteFiles={addAttachments}
          onDropFiles={addAttachments}
          onStop={() => aui.composer.cancel()}
          onSubmit={() => { void onBeforeSend(() => composer.send()); }}
          onValueChange={composer.setText}
          placeholder={agentType === "feishu" ? "粘贴飞书文档链接，或搜索文档…" : "Ask about your data..."}
          value={composer.value}
        />
      </BorderBeam>
    </ComposerPrimitive.Root>
  );
}

function StudioComposerSettings({ onOpenSettings }: { onOpenSettings(tab: StudioSettingsTab): void }) {
  const agentType = useContext(StudioAgentTypeContext);
  return (
    <>
      <StudioModelPicker />
      {agentType === "database" ? <TooltipIconButton
        aria-label="Configure permissions"
        className="ml-auto size-8 shrink-0 rounded-full"
        onClick={() => onOpenSettings("permissions")}
        side="top"
        tooltip="Configure permissions"
        type="button"
      >
        <ShieldCheckIcon aria-hidden="true" size={16} />
      </TooltipIconButton> : null}
    </>
  );
}

type ProviderModelOption = Readonly<{
  id: string;
  name: string;
  family: string;
  contextWindow?: number;
  reasoning?: Readonly<{
    defaultEffort?: StudioReasoningEffort;
    supportedEfforts: readonly StudioReasoningEffort[];
  }>;
}>;

const COMPOSER_MODEL_PROVIDERS = new Set(["openrouter", "vercel", "openai", "anthropic", "google", "custom"]);
const REASONING_EFFORT_ORDER: readonly StudioReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const COMPATIBLE_GATEWAY_EFFORTS: readonly StudioReasoningEffort[] = ["low", "medium", "high"];

function StudioModelPicker() {
  const settingsQuery = useStudioSettingsQuery();
  const provider = settingsQuery.data?.llm.provider;
  const selectedModel = settingsQuery.data?.llm.model;
  const catalogPicker = provider !== undefined && COMPOSER_MODEL_PROVIDERS.has(provider);
  const [models, setModels] = useState<readonly ProviderModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<StudioSettingsSnapshot>();
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [savingModel, setSavingModel] = useState<string>();
  const [savingEffort, setSavingEffort] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!catalogPicker || !provider) {
      setModels([]);
      setError(undefined);
      setLoadingCatalog(false);
      return;
    }
    const controller = new AbortController();
    setModels([]);
    setError(undefined);
    setLoadingCatalog(true);
    void Promise.all([
      fetch("/api/settings", { headers: { Accept: "application/json" }, signal: controller.signal }),
      fetch(`/api/settings/models?provider=${encodeURIComponent(provider)}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }),
    ])
      .then(async ([settingsResponse, modelsResponse]) => {
        if (!settingsResponse.ok || !modelsResponse.ok) throw new Error("model_picker_request_failed");
        const [settingsBody, modelsBody] = await Promise.all([settingsResponse.json(), modelsResponse.json()]);
        if (controller.signal.aborted) return;
        setSettings(readStudioSettingsSnapshot(settingsBody));
        setModels(readProviderModels(modelsBody));
        setError(undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Models could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCatalog(false);
      });
    return () => controller.abort();
  }, [catalogPicker, provider, settingsQuery.dataUpdatedAt]);

  const pickerModels = useMemo(() => {
    if (!selectedModel) return models;
    if (models.some((model) => model.id === selectedModel)) return models;
    return [{ id: selectedModel, name: selectedModel, family: provider ?? "" }, ...models];
  }, [models, provider, selectedModel]);

  const selectedOption = pickerModels.find((model) => model.id === selectedModel);
  const effortOptions = useMemo(() => composerEffortOptions(provider, selectedOption), [provider, selectedOption]);

  const selectModel = async (model: ProviderModelOption) => {
    if (!settings || savingModel || savingEffort) return;
    setSavingModel(model.id);
    setError(undefined);
    const candidate: StudioSettingsCandidate = {
      database: {
        accessMode: settings.database.accessMode,
        dialect: settings.database.dialect,
      },
      llm: {
        model: model.id,
        provider: settings.llm.provider,
        reasoningEffort: modelReasoningEffort(model, settings.llm.reasoningEffort),
      },
      limits: settings.limits,
    };
    try {
      const response = await fetch("/api/settings", {
        body: JSON.stringify(candidate),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) throw new Error("model_picker_save_failed");
      setSettings(readStudioSettingsSnapshot(await response.json()));
      setOpen(false);
      await settingsQuery.refetch();
    } catch {
      setError("The model was not changed. Check workspace settings and try again.");
      setOpen(true);
    } finally {
      setSavingModel(undefined);
    }
  };

  const selectEffort = async (effort: StudioReasoningSelection) => {
    if (!settings || savingModel || savingEffort || !provider || !selectedModel) return;
    setSavingEffort(true);
    setError(undefined);
    const candidate: StudioSettingsCandidate = {
      database: {
        accessMode: settings.database.accessMode,
        dialect: settings.database.dialect,
      },
      llm: {
        model: selectedModel,
        provider: settings.llm.provider,
        reasoningEffort: effort,
      },
      limits: settings.limits,
    };
    try {
      const response = await fetch("/api/settings", {
        body: JSON.stringify(candidate),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "PUT",
      });
      if (!response.ok) throw new Error("model_picker_effort_save_failed");
      setSettings(readStudioSettingsSnapshot(await response.json()));
      await settingsQuery.refetch();
    } catch {
      setError("The effort setting was not changed. Check workspace settings and try again.");
    } finally {
      setSavingEffort(false);
    }
  };

  if (!provider && settingsQuery.isLoading) {
    return (
      <ProviderModelPicker
        ariaLabel="Choose a model"
        disabled
        loading
        models={[]}
        onValueChange={() => undefined}
        variant="composer"
      />
    );
  }

  if (!catalogPicker) {
    const option = selectedModel
      ? { id: selectedModel, name: selectedModel, family: provider ?? "" }
      : undefined;
    return (
      <span className="studio-composer-setting studio-model-picker-trigger" title={selectedModel}>
        <StudioModelBrandIcon model={option} size={16} />
        <span className="studio-model-picker-label">{selectedModel ?? "No model selected"}</span>
      </span>
    );
  }

  return (
    <ProviderModelPicker
      ariaLabel="Choose a model"
      busyValue={savingModel}
      disabled={Boolean(savingModel || savingEffort)}
      error={error}
      effort={effortOptions.length > 1 ? {
        value: effortOptions.includes(settings?.llm.reasoningEffort ?? "default")
          ? settings?.llm.reasoningEffort ?? "default"
          : "default",
        options: effortOptions,
        disabled: savingEffort,
        onValueChange: (value) => void selectEffort(value as StudioReasoningSelection),
      } : undefined}
      loading={loadingCatalog}
      models={pickerModels}
      onOpenChange={setOpen}
      onValueChange={(modelId) => {
        const model = pickerModels.find((candidate) => candidate.id === modelId);
        if (model) void selectModel(model);
      }}
      open={open}
      value={selectedModel}
      variant="composer"
    />
  );
}

function composerEffortOptions(
  provider: string | undefined,
  model: ProviderModelOption | undefined,
): StudioReasoningSelection[] {
  const supported = model?.reasoning?.supportedEfforts
    ?? (provider === "custom" || provider === "openai" ? COMPATIBLE_GATEWAY_EFFORTS : []);
  if (supported.length === 0) return [];
  return ["default", ...REASONING_EFFORT_ORDER.filter((effort) => supported.includes(effort))];
}

function readProviderModels(value: unknown): readonly ProviderModelOption[] {
  const root = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const source = Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const models: ProviderModelOption[] = [];
  for (const item of source) {
    const model = item !== null && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    const id = readModelText(model?.id, 512);
    const name = readModelText(model?.name, 256);
    const family = readModelText(model?.family);
    if (!id || !name || !family || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = typeof model?.contextWindow === "number"
      && Number.isSafeInteger(model.contextWindow)
      && model.contextWindow > 0
      ? model.contextWindow
      : undefined;
    models.push({
      id,
      name,
      family,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      reasoning: readModelReasoning(model?.reasoning),
    });
  }
  return models;
}

function readModelText(value: unknown, maximumLength = 200): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maximumLength ? value.trim() : undefined;
}

function readModelReasoning(value: unknown): ProviderModelOption["reasoning"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const supportedEfforts = Array.isArray(source.supportedEfforts)
    ? source.supportedEfforts.filter((effort): effort is StudioReasoningEffort => (
      effort === "minimal" || effort === "low" || effort === "medium" || effort === "high"
        || effort === "xhigh" || effort === "max" || effort === "none"
    ))
    : [];
  if (supportedEfforts.length === 0) return undefined;
  const defaultEffort = supportedEfforts.includes(source.defaultEffort as StudioReasoningEffort)
    ? source.defaultEffort as StudioReasoningEffort
    : undefined;
  return { defaultEffort, supportedEfforts };
}

function modelReasoningEffort(
  model: ProviderModelOption,
  current: StudioReasoningSelection,
): StudioReasoningSelection {
  const supported = model.reasoning?.supportedEfforts;
  if (!supported?.length) return "default";
  if (current !== "default" && supported.includes(current)) return current;
  if (supported.includes("low")) return "low";
  return model.reasoning?.defaultEffort ?? "default";
}
