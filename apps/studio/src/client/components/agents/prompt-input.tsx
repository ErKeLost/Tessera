"use client";
// beui.dev/components/agents/prompt-input

import { ArrowUp, Plus, Square } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type ClipboardEvent,
  type DragEvent,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import { SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface PromptAction {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  onSubmit?: (value: string) => void | Promise<void>;
  loading?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  footer?: ReactNode;
  attachments?: ReactNode;
  hasAttachments?: boolean;
  onPasteFiles?: (files: File[]) => void | Promise<void>;
  onDropFiles?: (files: File[]) => void | Promise<void>;
  className?: string;
}

export function PromptInput({
  value,
  defaultValue = "",
  onValueChange,
  actions = [],
  onAction,
  onSubmit,
  loading = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  footer,
  attachments,
  hasAttachments = false,
  onPasteFiles,
  onDropFiles,
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onPaste: onTextareaPaste,
  onKeyDown,
  ...textareaProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const canSubmit = (Boolean(currentValue.trim()) || hasAttachments) && !disabled && !loading;

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    const measurement = measurementRef.current;
    if (!textarea || !measurement || textarea.value !== currentValue) return;

    const lineHeight = 24;
    const nextHeight = Math.min(
      Math.max(measurement.scrollHeight, minRows * lineHeight),
      maxRows * lineHeight,
    );
    const height = `${nextHeight}px`;
    if (textarea.style.height !== height) textarea.style.height = height;
  }, [currentValue, maxRows, minRows]);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resizeTextarea);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };

  const submit = () => {
    const prompt = currentValue.trim();
    if ((!prompt && !hasAttachments) || disabled || loading) return;

    onSubmit?.(prompt);
    if (value === undefined) setInternalValue("");
    textareaRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  const readClipboardFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const directFiles = Array.from(event.clipboardData?.files ?? []);
    if (directFiles.length > 0) return directFiles;
    return Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    onTextareaPaste?.(event);
    if (event.defaultPrevented || !onPasteFiles) return;
    const files = readClipboardFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    void onPasteFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void onDropFiles(Array.from(event.dataTransfer.files));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!onDropFiles || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative w-full rounded-2xl border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {attachments}
      <div
        ref={measurementRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute inset-x-2 top-0 whitespace-pre-wrap px-2 text-sm leading-6 [overflow-wrap:break-word]"
      >
        {`${currentValue}\u200b`}
      </div>
      <textarea
        ref={textareaRef}
        value={currentValue}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={minRows}
        {...textareaProps}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground/55"
      />

      <div className="mt-1 flex min-h-8 items-center gap-1">
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label="Add to prompt"
                className="size-8 rounded-full"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              radius={12}
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">
                      {action.label}
                    </span>
                    {action.description ? (
                      <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                        {action.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {footer ? (
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {footer}
          </div>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            disabled={loading ? !onStop : !canSubmit}
            aria-label={loading ? "Stop generating" : "Send prompt"}
            onClick={loading ? onStop : submit}
            className="size-8 rounded-full"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={loading ? "stop" : "send"}
                initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="grid place-items-center"
              >
                {loading ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>
    </div>
  );
}
