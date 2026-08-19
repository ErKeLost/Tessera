"use client";

import { type ComponentProps } from "react";
import { ComposerPrimitive } from "@assistant-ui/react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  DatabaseIcon,
  MicIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "../../lib/utils";
import {
  ghostButton,
  iconSwap,
  iconSwapIn,
  iconSwapOut,
  inkButton,
  paper,
} from "../../lib/surfaces";

export function Composer({ className, ...props }: ComponentProps<"form">) {
  return <form data-slot="composer" className={cn("relative w-full max-w-lg", className)} {...props} />;
}

export function ComposerBar({
  dragActive = false,
  className,
  ...props
}: ComponentProps<"div"> & { dragActive?: boolean }) {
  return (
    <div
      data-slot="composer-bar"
      data-drag-active={dragActive || undefined}
      className={cn(
        paper,
        "flex w-full flex-col gap-2 rounded-[24px] p-2.5 transition-colors focus-within:ring-2 focus-within:ring-ring/50",
        dragActive && "bg-accent",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerInput({ className, ...props }: ComponentProps<typeof ComposerPrimitive.Input>) {
  return (
    <ComposerPrimitive.Input
      data-slot="composer-input"
      className={cn(
        "placeholder:text-foreground/35 min-h-14 max-h-36 w-full resize-none bg-transparent px-3 py-2 text-[15px] caret-foreground outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function ComposerToolbar({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-toolbar" className={cn("flex items-center justify-between", className)} {...props} />;
}

export function ComposerActions({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-actions" className={cn("flex items-center gap-1.5", className)} {...props} />;
}

export function ComposerAttachButton({
  className,
  ...props
}: Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      aria-label="Add attachment"
      data-slot="composer-attach"
      disabled={!props.onClick}
      className={cn(ghostButton, "size-8 disabled:pointer-events-none disabled:opacity-30", className)}
      {...props}
    >
      <PlusIcon className="size-4" />
    </button>
  );
}

export function ComposerDataSourceButton({
  className,
  ...props
}: Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      data-slot="composer-data-source"
      className={cn(ghostButton, "size-8", className)}
      {...props}
    >
      <DatabaseIcon className="size-4" />
    </button>
  );
}

export function ComposerModelTrigger({
  model,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { model: string }) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      data-slot="composer-model-trigger"
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground flex h-8 max-w-56 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      <span className="truncate">{model}</span>
      <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
    </button>
  );
}

export function ComposerContext({
  value = 0,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { value?: number }) {
  const fraction = Math.min(Math.max(value, 0), 1);
  const circumference = 2 * Math.PI * 6;

  return (
    <button
      type="button"
      aria-label="Context usage"
      data-slot="composer-context"
      title="Context usage"
      className={cn(ghostButton, "size-8", className)}
      {...props}
    >
      <svg viewBox="0 0 16 16" className="size-4 -rotate-90" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2.5"
          className="stroke-foreground/10"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-current transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
    </button>
  );
}

export function ComposerVoiceButton({
  active,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { active: boolean }) {
  return (
    <button
      type="button"
      aria-label={active ? "Stop recording" : "Start voice input"}
      data-slot="composer-voice-button"
      className={cn(
        active
          ? cn(inkButton, "flex size-8 items-center justify-center rounded-full")
          : cn(ghostButton, "size-8"),
        className,
      )}
      {...props}
    >
      {active ? <SquareIcon className="size-3 fill-current" /> : <MicIcon className="size-4" />}
    </button>
  );
}

export function ComposerSend({
  streaming,
  idle,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { streaming: boolean; idle: boolean }) {
  return (
    <button
      type="button"
      aria-label={streaming ? "Stop generating" : "Send message"}
      data-slot="composer-send"
      className={cn(
        "grid size-8 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        streaming || !idle
          ? inkButton
          : "bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <ArrowUpIcon className={cn(iconSwap, "size-4", streaming ? iconSwapOut : iconSwapIn)} />
      <SquareIcon className={cn(iconSwap, "size-3 fill-current", streaming ? iconSwapIn : iconSwapOut)} />
    </button>
  );
}
