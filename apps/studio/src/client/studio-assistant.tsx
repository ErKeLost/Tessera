import { useChat } from "@ai-sdk/react";
import {
  ActionBarPrimitive,
  AuiConfig,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  Tools,
  useAui,
  useAuiState,
  unstable_useComposerInput,
} from "@assistant-ui/react";
import { AssistantChatTransport, useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { BorderBeam } from "border-beam";
import {
  CopyIcon,
  LoaderCircleIcon,
  PencilIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { TesseraUIMessage } from "../protocol";
import {
  readStudioSettingsSnapshot,
  type StudioReasoningEffort,
  type StudioReasoningSelection,
  type StudioSettingsCandidate,
  type StudioSettingsSnapshot,
  type StudioSettingsTab,
} from "./studio-settings";
import { useStudioTheme } from "./studio-theme";
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
} from "./components/assistant-ui/reasoning";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { AgentActivity } from "./components/agent-activity";
import { ErrorState } from "./components/elements/error-state";
import { OpenRouterModelPicker } from "./components/elements/openrouter-model-picker";
import { ReasoningPanel } from "./components/elements/reasoning-panel";
import { PromptInput } from "./components/agents/prompt-input";
import { Button } from "./components/ui/button";
import { tesseraStudioToolkit } from "./tessera-toolkit";

const tesseraStudioAssistantConfig = AuiConfig({
  tools: Tools({ toolkit: tesseraStudioToolkit }),
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
          // The server owns the tool registry. AssistantChatTransport adds an
          // empty `tools` field to the request body, but `/api/chat` never
          // consumes it and the client-side toolkit is registered above.
          const requestBody = { ...(body ?? {}) };
          delete (requestBody as { tools?: unknown }).tools;
          return {
            headers: { "Content-Type": "application/json" },
            body: {
              ...requestBody,
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
                case "group-reasoning":
                  return <StudioReasoningGroup group={part} />;
                case "text":
                  return <MarkdownText />;
                case "reasoning":
                  return <Reasoning {...part} />;
                case "tool-call":
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

type StudioReasoningGroupPart = MessagePrimitive.GroupedParts.GroupPart;

function StudioReasoningGroup({ group }: { group: StudioReasoningGroupPart }) {
  const messageParts = useAuiState((state) => state.message.parts);
  const streaming = group.status.type === "running";
  const [open, setOpen] = useState(streaming);
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
    setOpen(true);
    const updateElapsed = () => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    };
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(interval);
  }, [streaming]);

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
  const elapsed = formatReasoningElapsed(elapsedMs);

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

function formatReasoningElapsed(elapsedMs: number): string {
  return `${Math.max(1, Math.round(elapsedMs / 1_000))}s`;
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
          onSubmit={() => composer.send()}
          onValueChange={composer.setText}
          placeholder="Ask about your data..."
          value={composer.value}
        />
      </BorderBeam>
    </ComposerPrimitive.Root>
  );
}

function StudioComposerSettings({ onOpenSettings }: { onOpenSettings(tab: StudioSettingsTab): void }) {
  return (
    <>
      <StudioModelPicker />
      <TooltipIconButton
        aria-label="Configure permissions"
        className="ml-auto size-8 shrink-0 rounded-full"
        onClick={() => onOpenSettings("permissions")}
        side="top"
        tooltip="Configure permissions"
        type="button"
      >
        <ShieldCheckIcon aria-hidden="true" size={16} />
      </TooltipIconButton>
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
    <OpenRouterModelPicker
      busyValue={savingModel}
      disabled={Boolean(savingModel)}
      error={error}
      loading={loading}
      models={models}
      onOpenChange={setOpen}
      onValueChange={(modelId) => {
        const model = models.find((candidate) => candidate.id === modelId);
        if (model) void selectModel(model);
      }}
      open={open}
      value={selectedModel}
      variant="composer"
    />
  );
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
