"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { memo, useCallback, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message";
import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BackgroundAccessDialogProps } from "./background-access-dialog";
import { BACKGROUND_MODEL } from "./model";
import type { DecodedArtifactProps } from "./decoded-artifact";
import styles from "./background.module.css";

type ArtifactPayload = import("./decoded-artifact").ArtifactPayload;

type BackgroundMessage = UIMessage<unknown, { artifact: ArtifactPayload }>;

const transport = new DefaultChatTransport<BackgroundMessage>({
  api: "/api/background",
});

const loadDecodedArtifact = () => import("./decoded-artifact");

const MessageResponse = dynamic<MessageResponseProps>(
  () => import("@/components/ai-elements/message-response").then((module) => module.MessageResponse),
  { ssr: false, loading: () => <PendingResponse /> },
);

const DecodedArtifact = dynamic<DecodedArtifactProps>(
  () => import("./decoded-artifact").then((module) => module.DecodedArtifact),
  { ssr: false, loading: () => <ArtifactModuleLoading /> },
);

const BackgroundAccessDialog = dynamic<BackgroundAccessDialogProps>(
  () => import("./background-access-dialog").then((module) => module.BackgroundAccessDialog),
  { ssr: false },
);

const examplePrompts = [
  "展示最近 12 个月的月度收入趋势，并标出异常月份",
  "比较 Pro 和 Enterprise 两个套餐的转化漏斗",
  "生成一个本周活跃用户、留存率和收入的运营概览",
] as const;

export function BackgroundChat() {
  const [input, setInput] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const {
    clearError,
    error,
    messages,
    regenerate,
    sendMessage,
    setMessages,
    status,
    stop,
  } = useChat<BackgroundMessage>({ throttle: 60, transport });
  const isGenerating = status === "submitted" || status === "streaming";
  const statusText = getStatusText(status);
  const errorCode = useMemo(() => getErrorCode(error), [error]);
  const latestAssistantId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id,
    [messages],
  );

  const submitMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isGenerating) return;
    clearError();
    setInput("");
    void loadDecodedArtifact();
    await sendMessage({ text: trimmed });
  }, [clearError, isGenerating, sendMessage]);

  const handleSubmit = useCallback(async (message: PromptInputMessage) => {
    await submitMessage(message.text);
  }, [submitMessage]);

  const handleSuggestion = useCallback((suggestion: string) => {
    void submitMessage(suggestion);
  }, [submitMessage]);

  const startNewConversation = useCallback(() => {
    if (isGenerating) void stop();
    clearError();
    setInput("");
    setMessages([]);
  }, [clearError, isGenerating, setMessages, stop]);

  const copyAssistantText = useCallback(async (message: BackgroundMessage) => {
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? undefined : current), 1800);
    } catch {
      // Clipboard access is best-effort and should not interrupt the conversation.
    }
  }, []);

  const rerunMessage = useCallback((messageId: string) => {
    clearError();
    void regenerate({ messageId });
  }, [clearError, regenerate]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link aria-label="返回 Tessera Agent 首页" className={styles.backLink} href="/zh">
            <ArrowLeftIcon aria-hidden="true" />
            <span>Tessera Agent</span>
          </Link>

          <div className={styles.headerMeta}>
            <div aria-label={`当前模型：${BACKGROUND_MODEL.name}，1M context`} className={styles.modelInfo}>
              <span aria-hidden="true" className={styles.modelDot} />
              <span className={styles.modelName}>{BACKGROUND_MODEL.name}</span>
              <span className={styles.modelContext}>1M context</span>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="新建对话"
                  className={styles.newConversationButton}
                  disabled={isGenerating}
                  onClick={startNewConversation}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>新建对话</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.chatStage}>
          <div className={styles.statusRow} role="status">
            <span aria-hidden="true" className={`${styles.statusDot} ${isGenerating ? styles.statusDotActive : ""}`} />
            <span>{statusText}</span>
          </div>

          <Conversation aria-label="Artifact Playground 对话" className={styles.conversation}>
            <ConversationContent className={styles.conversationContent}>
              {messages.length === 0 ? (
                <ConversationEmptyState
                  className={styles.emptyState}
                  description=""
                  icon={<SparklesIcon aria-hidden="true" />}
                  title="准备分析"
                />
              ) : (
                messages.map((message, messageIndex) => {
                  return (
                    <BackgroundChatMessage
                      copied={copiedMessageId === message.id}
                      isGenerating={isGenerating}
                      isLastMessage={messageIndex === messages.length - 1}
                      isLatestAssistant={message.id === latestAssistantId}
                      key={message.id}
                      message={message}
                      onCopy={copyAssistantText}
                      onRerun={rerunMessage}
                    />
                  );
                })
              )}
              {isGenerating && messages.at(-1)?.role !== "assistant" ? <PendingResponse /> : null}
            </ConversationContent>
            <ConversationScrollButton aria-label="滚动到最新消息" className={styles.scrollButton} />
          </Conversation>

          {error ? (
            <div className={styles.errorBanner} role="alert">
              <CircleAlertIcon aria-hidden="true" />
              <p>{formatError(error)}</p>
              {errorCode === "background_access_required" ? (
                <Button onClick={() => setAccessDialogOpen(true)} size="sm" type="button" variant="ghost">访问令牌</Button>
              ) : null}
              <Button onClick={clearError} size="sm" type="button" variant="ghost">关闭</Button>
            </div>
          ) : null}

          <div className={styles.composerArea}>
            <Suggestions aria-label="示例请求" className={styles.suggestions}>
              {examplePrompts.map((suggestion) => (
                <Suggestion
                  disabled={isGenerating}
                  key={suggestion}
                  onClick={handleSuggestion}
                  suggestion={suggestion}
                />
              ))}
            </Suggestions>

            <PromptInput aria-label="发送分析请求" className={styles.promptInput} onSubmit={handleSubmit}>
              <PromptInputTextarea
                aria-label="输入分析请求"
                disabled={isGenerating}
                onChange={(event) => setInput(event.currentTarget.value)}
                placeholder="输入分析请求..."
                value={input}
              />
              <PromptInputFooter className={styles.promptFooter}>
                <span className={styles.protocolLabel}><ShieldCheckIcon aria-hidden="true" /> Protocol 2.0</span>
                <PromptInputSubmit
                  aria-label={isGenerating ? "停止生成" : "发送请求"}
                  disabled={isGenerating ? false : !input.trim()}
                  onStop={() => void stop()}
                  status={status}
                />
              </PromptInputFooter>
            </PromptInput>
          </div>
        </div>
      </main>
      {accessDialogOpen ? (
        <BackgroundAccessDialog
          onGranted={clearError}
          onOpenChange={setAccessDialogOpen}
          open={accessDialogOpen}
        />
      ) : null}
    </div>
  );
}

function PendingResponse() {
  return (
    <div className={styles.pendingResponse} role="status">
      <LoaderCircleIcon aria-hidden="true" />
      <span>正在生成可信 Artifact</span>
    </div>
  );
}

function ArtifactModuleLoading() {
  return (
    <section aria-label="正在载入 Artifact" className={styles.artifactLoading}>
      <LoaderCircleIcon aria-hidden="true" />
      <span>正在载入 Artifact</span>
    </section>
  );
}

type BackgroundChatMessageProps = {
  copied: boolean;
  isGenerating: boolean;
  isLastMessage: boolean;
  isLatestAssistant: boolean;
  message: BackgroundMessage;
  onCopy: (message: BackgroundMessage) => Promise<void>;
  onRerun: (messageId: string) => void;
};

const BackgroundChatMessage = memo(function BackgroundChatMessage({
  copied,
  isGenerating,
  isLastMessage,
  isLatestAssistant,
  message,
  onCopy,
  onRerun,
}: BackgroundChatMessageProps) {
  const text = getMessageText(message);

  return (
    <Message
      aria-label={message.role === "user" ? "你的请求" : "Tessera Agent 回复"}
      className={message.role === "user" ? styles.userMessage : styles.assistantMessage}
      from={message.role}
    >
      <MessageContent className={styles.messageContent}>
        {message.parts.map((part, partIndex) => {
          if (part.type === "text") {
            if (message.role === "user") {
              return <p className={styles.userMessageText} key={`${message.id}-${partIndex}`}>{part.text}</p>;
            }
            return (
              <MessageResponse
                isAnimating={isGenerating && isLatestAssistant}
                key={`${message.id}-${partIndex}`}
              >
                {part.text}
              </MessageResponse>
            );
          }
          if (part.type === "data-artifact") {
            return <DecodedArtifact key={part.id ?? `${message.id}-${partIndex}`} payload={part.data} />;
          }
          return null;
        })}
      </MessageContent>

      {message.role === "assistant" && text ? (
        <MessageActions className={styles.messageActions}>
          <MessageAction
            label={copied ? "已复制" : "复制回复"}
            onClick={() => void onCopy(message)}
            tooltip={copied ? "已复制" : "复制回复"}
          >
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          </MessageAction>
          {isLatestAssistant && !isGenerating ? (
            <MessageAction
              label="重新生成"
              onClick={() => onRerun(message.id)}
              tooltip="重新生成"
            >
              <RotateCcwIcon aria-hidden="true" />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null}

      {isLastMessage && message.role === "assistant" && isGenerating && !text ? <PendingResponse /> : null}
    </Message>
  );
});

BackgroundChatMessage.displayName = "BackgroundChatMessage";

function getMessageText(message: BackgroundMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

function getStatusText(status: "submitted" | "streaming" | "ready" | "error"): string {
  switch (status) {
    case "submitted":
      return "正在连接模型";
    case "streaming":
      return "模型正在生成";
    case "error":
      return "请求未完成";
    default:
      return "已就绪";
  }
}

function formatError(error: Error): string {
  const message = error.message.trim();
  if (!message) return "请求未完成，请检查服务端配置后重试。";
  if (message === "background:model_request_failed") {
    return "DeepSeek 模型当前不可用或请求超时，请稍后重试。";
  }

  try {
    const payload = JSON.parse(message) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return message;
    const failure = (payload as { error?: unknown }).error;
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return message;
    const code = (failure as { code?: unknown }).code;
    const publicMessage = (failure as { message?: unknown }).message;
    if (code === "background_unavailable") return "演示服务尚未配置 OpenRouter Key。";
    if (code === "background_access_required") return "此 Playground 需要访问令牌。";
    if (code === "background_rate_limited") return "请求过于频繁，请稍后重试。";
    if (code === "background_busy") return "当前请求较多，请稍后重试。";
    if (code === "background_security_unconfigured") return "此 Playground 尚未完成生产访问配置。";
    if (typeof publicMessage === "string" && publicMessage.trim()) return publicMessage;
  } catch {
    // Network errors are usually plain text and are safe to display as-is.
  }

  return message;
}

function getErrorCode(error: Error | undefined): string | undefined {
  if (!error) return undefined;
  try {
    const payload = JSON.parse(error.message) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const failure = (payload as { error?: unknown }).error;
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return undefined;
    const code = (failure as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}
