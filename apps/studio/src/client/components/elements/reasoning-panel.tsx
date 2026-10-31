"use client";

import { useEffect, useRef } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, mono, ShimmerLabel, SwapLabel } from "./surfaces";
import { take } from "./range";

export interface ReasoningStep {
  title: string;
  body: string;
}

export interface ReasoningPanelProps {
  steps: ReasoningStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  elapsed?: string;
  className?: string;
}

export function ReasoningPanel({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  elapsed,
  className,
}: ReasoningPanelProps) {
  const shown = take(steps, visibleSteps);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);

  // The body keeps a fixed reading height: once the steps outgrow it the panel
  // scrolls instead of pushing the rest of the transcript off screen. While
  // thinking streams the newest step stays pinned in view, unless the reader
  // scrolled up to re-read an earlier step.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return undefined;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight,
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => {
      if (!pinned) return;
      scrollEl.scrollTop = scrollEl.scrollHeight;
    };
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is user intent.
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true;
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false;
      }
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [streaming, open]);

  return (
    <Collapsible
      data-slot="reasoning-panel"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/70 hover:text-foreground flex items-center gap-1.5 py-1 text-[13.5px] transition-[color,scale] outline-none active:scale-[0.98]">
        <SwapLabel active={streaming ? 0 : 1} className="text-start">
          <>
            <ShimmerLabel
              active={streaming}
              className="relative inline-block leading-none"
            >
              Thinking
            </ShimmerLabel>
            {elapsed !== undefined && (
              <span className={cn(mono, "text-foreground/55 tabular-nums")}>
                {elapsed}
              </span>
            )}
          </>
          <>{restingLabel}</>
        </SwapLabel>
        <ChevronDownIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-180 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        <div
          ref={scrollRef}
          data-slot="reasoning-panel-scroll"
          className="max-h-64 overflow-y-auto overscroll-contain"
        >
          <ol ref={contentRef} className="flex flex-col gap-4 pt-3 pb-1">
            {shown.map((step, i) => {
              const active = streaming && i === shown.length - 1;
              return (
                <li
                  key={step.title}
                  className="animate-reveal flex gap-3 motion-reduce:animate-none"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[7px] size-[5px] shrink-0 rounded-full transition-colors duration-300",
                      active
                        ? "bg-link animate-pulse"
                        : "bg-foreground/35",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <p className="text-foreground/90 text-[13.5px] font-medium">
                      {step.title}
                    </p>
                    <p className="text-foreground/70 mt-0.5 text-[13px] leading-relaxed break-words">
                      {step.body}
                    </p>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
