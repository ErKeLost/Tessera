import { useChat } from "@ai-sdk/react";
import { DeepSeek, Grok, Kimi, Qwen, ZAI } from "@lobehub/icons";
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
  BotIcon,
  CopyIcon,
  DatabaseIcon,
  FileSearchIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PencilIcon,
  ShieldCheckIcon,
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
  readStudioSettingsSnapshot,
  type StudioReasoningEffort,
  type StudioReasoningSelection,
  type StudioSettingsCandidate,
  type StudioSettingsSnapshot,
  type StudioSettingsTab,
} from "./studio-settings";
import type { StudioAgentPageContext } from "./layout/studio-route-context";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "./components/motion/select";
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
  onOpenSettings,
  onThreadActivity,
  threadId,
  workspaceContext,
}: {
  initialMessages: readonly TesseraUIMessage[];
  initialPrompt?: string;
  onOpenSettings(tab: StudioSettingsTab): void;
  onThreadActivity?(): void;
  threadId: string;
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
          const message = messages.at(-1);
          if (!message || message.role !== "user") {
            throw new Error("Tessera can only submit the current user message.");
          }
          const currentWorkspaceContext = chatWorkspaceContext(workspaceContextRef.current);
          return {
            headers: { "Content-Type": "application/json" },
            body: {
              ...(body ?? {}),
              id: threadId,
              ...(messageId === undefined ? {} : { messageId }),
              messages: [message],
              threadId,
              trigger,
              ...(currentWorkspaceContext === undefined ? {} : { workspaceContext: currentWorkspaceContext }),
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
    if (!initialPrompt || initialMessages.length > 0 || initialPromptSent.current) return;
    initialPromptSent.current = true;
    void chat.sendMessage({ text: initialPrompt });
  }, [chat, initialMessages.length, initialPrompt]);
  const runtime = useAISDKRuntime<TesseraUIMessage>(chat);
  transport.setRuntime(runtime);

  return (
    <AssistantRuntimeProvider config={tesseraStudioAssistantConfig} runtime={runtime}>
      <TesseraExecutionTraceDataUI />
      <StudioConversation onOpenSettings={onOpenSettings} />
    </AssistantRuntimeProvider>
  );
}

function chatWorkspaceContext(context: StudioAgentPageContext | undefined) {
  if (!context) return undefined;
  return {
    ...(context.currentRelation === undefined ? {} : { currentRelation: context.currentRelation }),
    hasLocalFilter: context.hasLocalFilter,
    view: context.view,
  };
}

function StudioConversation({ onOpenSettings }: { onOpenSettings(tab: StudioSettingsTab): void }) {
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
          <StudioComposer onOpenSettings={onOpenSettings} />
        </footer>
      </ThreadPrimitive.Root>
    </section>
  );
}

function StudioEmptyState() {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);
  if (!isEmpty) return null;
  return (
    <div className="tessera-empty-state">
      <div className="tessera-empty-content">
        <h1>What would you like to analyze?</h1>
        <div className="tessera-starter-prompts" aria-label="Suggested analyses">
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Show me the structure of this database and its most important tables.">Explore schema</ThreadPrimitive.Suggestion>
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Find the most important trends in this database.">Analyze trends</ThreadPrimitive.Suggestion>
          <ThreadPrimitive.Suggestion className="tessera-starter-prompt" prompt="Check the data for quality issues and unusual values.">Check quality</ThreadPrimitive.Suggestion>
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
        detail="The model request did not complete. Verify the OpenRouter API key and its available usage limit in Settings, then retry."
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

function StudioComposer({ onOpenSettings }: { onOpenSettings(tab: StudioSettingsTab): void }) {
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
    <ComposerPrimitive.Root className="tessera-composer-form">
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
        onSubmit={() => composer.send()}
        onValueChange={composer.setText}
        placeholder="Ask about your data..."
        value={composer.value}
      />
    </ComposerPrimitive.Root>
  );
}

function StudioComposerSettings({ onOpenSettings }: { onOpenSettings(tab: StudioSettingsTab): void }) {
  return (
    <>
      <StudioModelPicker />
      <button
        aria-label="Configure permissions"
        className="studio-composer-setting"
        onClick={() => onOpenSettings("permissions")}
        title="Configure permissions"
        type="button"
      >
        <ShieldCheckIcon aria-hidden="true" size={14} />
        <span>Permissions</span>
      </button>
    </>
  );
}

type OpenRouterModelOption = Readonly<{
  id: string;
  name: string;
  family: string;
  reasoning?: Readonly<{
    defaultEffort?: StudioReasoningEffort;
    supportedEfforts: readonly StudioReasoningEffort[];
  }>;
}>;

function StudioModelPicker() {
  const [models, setModels] = useState<readonly OpenRouterModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<StudioSettingsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [savingModel, setSavingModel] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/settings", { headers: { Accept: "application/json" }, signal: controller.signal }),
      fetch("/api/settings/models", { headers: { Accept: "application/json" }, signal: controller.signal }),
    ])
      .then(async ([settingsResponse, modelsResponse]) => {
        if (!settingsResponse.ok || !modelsResponse.ok) throw new Error("model_picker_request_failed");
        const [settingsBody, modelsBody] = await Promise.all([settingsResponse.json(), modelsResponse.json()]);
        if (controller.signal.aborted) return;
        setSettings(readStudioSettingsSnapshot(settingsBody));
        setModels(readOpenRouterModels(modelsBody));
        setError(undefined);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("OpenRouter models could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const selectedModel = settings?.llm.model;
  const selectedLabel = models.find((model) => model.id === selectedModel)?.name
    ?? selectedModel
    ?? "OpenRouter models";

  const selectModel = async (model: OpenRouterModelOption) => {
    if (!settings || savingModel) return;
    setSavingModel(model.id);
    setError(undefined);
    const candidate: StudioSettingsCandidate = {
      database: {
        accessMode: settings.database.accessMode,
        dialect: settings.database.dialect,
      },
      llm: {
        model: model.id,
        provider: "openrouter",
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
    } catch {
      setError("The model was not changed. Check workspace settings and try again.");
      setOpen(true);
    } finally {
      setSavingModel(undefined);
    }
  };

  return (
    <Select
      className="studio-model-picker-root"
      disabled={Boolean(savingModel)}
      onOpenChange={setOpen}
      onValueChange={(modelId) => {
        const model = models.find((candidate) => candidate.id === modelId);
        if (model) void selectModel(model);
      }}
      open={open}
      value={selectedModel ?? ""}
    >
      <SelectTrigger className="studio-composer-setting studio-model-picker-trigger">
        <span className="studio-model-picker-current" title={selectedLabel}>
          <StudioModelBrandIcon family={models.find((model) => model.id === selectedModel)?.family ?? selectedLabel} size={16} />
          <span className="studio-model-picker-label">{selectedLabel}</span>
          {loading ? <LoaderCircleIcon aria-label="Loading models" className="spin" size={13} /> : null}
        </span>
      </SelectTrigger>
      <SelectContent className="studio-model-picker-popover">
        <div className="studio-model-picker-heading">
          <span>OpenRouter models</span>
          <span>{models.length || ""}</span>
        </div>
        <div className="studio-model-picker-list">
          {models.map((model) => {
            const busy = savingModel === model.id;
            return (
              <SelectItem
                className="studio-model-picker-option"
                disabled={Boolean(savingModel)}
                key={model.id}
                value={model.id}
              >
                <span aria-hidden="true" className="studio-model-picker-option-icon">
                  <StudioModelBrandIcon family={model.family} size={20} />
                </span>
                <span className="studio-model-picker-option-copy">
                  <strong>{model.name}</strong>
                  <small>{model.family}</small>
                </span>
                {busy ? <LoaderCircleIcon aria-label="Saving model" className="spin" size={15} /> : null}
              </SelectItem>
            );
          })}
          {!loading && models.length === 0 ? <p className="studio-model-picker-empty">No OpenRouter models are available.</p> : null}
        </div>
        {error ? <p className="studio-model-picker-error" role="status">{error}</p> : null}
      </SelectContent>
    </Select>
  );
}

function StudioModelBrandIcon({ family, size }: { family: string; size: number }) {
  const normalized = family.toLocaleLowerCase("en-US");
  if (normalized.includes("deepseek")) return <DeepSeek.Color size={size} />;
  if (normalized.includes("qwen")) return <Qwen.Color size={size} />;
  if (normalized.includes("kimi") || normalized.includes("moonshot")) return <Kimi.Color size={size} />;
  if (normalized.includes("glm") || normalized.includes("z.ai") || normalized.includes("zhipu")) return <ZAI size={size} />;
  if (normalized.includes("grok") || normalized.includes("xai")) return <Grok size={size} />;
  return <BotIcon size={size} strokeWidth={1.8} />;
}

function readOpenRouterModels(value: unknown): readonly OpenRouterModelOption[] {
  const root = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const source = Array.isArray(root?.models) ? root.models : [];
  const seen = new Set<string>();
  const models: OpenRouterModelOption[] = [];
  for (const item of source) {
    const model = item !== null && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined;
    const id = readModelText(model?.id);
    const name = readModelText(model?.name);
    const family = readModelText(model?.family);
    if (!id || !name || !family || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name, family, reasoning: readModelReasoning(model?.reasoning) });
  }
  return models;
}

function readModelText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : undefined;
}

function readModelReasoning(value: unknown): OpenRouterModelOption["reasoning"] {
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
  model: OpenRouterModelOption,
  current: StudioReasoningSelection,
): StudioReasoningSelection {
  const supported = model.reasoning?.supportedEfforts;
  if (!supported?.length) return "default";
  if (current !== "default" && supported.includes(current)) return current;
  if (supported.includes("low")) return "low";
  return model.reasoning?.defaultEffort ?? "default";
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
