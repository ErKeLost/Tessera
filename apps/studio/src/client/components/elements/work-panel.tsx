"use client";

import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { collapsePanel, mono, ShimmerLabel, SwapLabel } from "./surfaces";

export interface WorkPanelProps {
  /** True while the wrapped execution trace is still producing parts. */
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Elapsed wall clock of the whole span, already formatted (`2m 35s`).
   * Omitted before the first tick so the label reads `Working` / `Worked`.
   */
  elapsed?: string;
  /** Compact right-aligned summary of what the span contains (`5 steps`). */
  detail?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * The one disclosure that wraps a run of agent work.
 *
 * A turn can interleave any number of reasoning blocks and tool calls before
 * the answer; listing them flat buries the answer under the trace. They all
 * collapse behind a single `Working for 2m 35s` / `Worked for 2m 35s` row
 * instead, and expand back into the same nested reasoning and tool rows.
 */
export function WorkPanel({
  streaming,
  open,
  onOpenChange,
  elapsed,
  detail,
  children,
  className,
}: WorkPanelProps) {
  const suffix = elapsed === undefined ? "" : ` for ${elapsed}`;

  return (
    <Collapsible
      data-slot="work-panel"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 flex items-center gap-1.5 py-1 text-[13.5px] transition-[color,scale] outline-none active:scale-[0.98]">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={streaming ? 0 : 1} className="text-start">
          <>
            <ShimmerLabel
              active={streaming}
              className="relative inline-block leading-none"
            >
              Working
            </ShimmerLabel>
            {elapsed !== undefined && (
              <span className={cn(mono, "text-foreground/30 tabular-nums")}>
                {`for ${elapsed}`}
              </span>
            )}
          </>
          <>{`Worked${suffix}`}</>
        </SwapLabel>
        {detail === undefined ? null : (
          <span className={cn(mono, "text-foreground/30 ms-auto tabular-nums")}>
            {detail}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {/* The rail is what makes a run of reasoning and tool rows read as one
            wrapped unit instead of a loose list. */}
        <div
          data-slot="work-panel-body"
          className="border-border/60 ms-[6px] mt-1 mb-1 border-s ps-3"
        >
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
