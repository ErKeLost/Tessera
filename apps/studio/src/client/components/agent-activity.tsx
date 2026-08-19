"use client";

import { CheckIcon, CircleAlertIcon } from "lucide-react";
import {
  ThinkingOrb,
  type OrbSize,
  type OrbState,
  type OrbTheme,
} from "thinking-orbs";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The four lifecycle states exposed by the Studio's streamed agent events. */
export type AgentActivityState =
  | "thinking"
  | "tool-running"
  | "complete"
  | "failed";

export interface AgentActivityProps {
  /** Current agent lifecycle state. Active states receive the package beam. */
  state: AgentActivityState;
  /** Main status label. A state-specific accessible label is used by default. */
  label?: ReactNode;
  /** Optional compact secondary context, such as the current tool name. */
  detail?: ReactNode;
  /** Override the Orb state for a specific active operation. */
  orbState?: OrbState;
  /** Thinking Orb has two intentionally tuned sizes: 20 and 64. */
  orbSize?: OrbSize;
  /** Passed directly to both third-party components. */
  theme?: OrbTheme;
  className?: string;
}

const activityDefaults: Record<AgentActivityState, { label: string; orb?: OrbState }> = {
  thinking: { label: "Thinking", orb: "solving" },
  "tool-running": { label: "Running tool", orb: "working" },
  complete: { label: "Complete" },
  failed: { label: "Action failed" },
};

/** A compact, non-disruptive status chip for streamed agent work. */
export function AgentActivity({
  className,
  detail,
  label,
  orbSize = 20,
  orbState,
  state,
  theme = "auto",
}: AgentActivityProps) {
  const active = state === "thinking" || state === "tool-running";
  const defaults = activityDefaults[state];
  const resolvedLabel = label ?? defaults.label;
  const resolvedOrbState = orbState ?? defaults.orb ?? "working";

  const content = (
    <div
      aria-atomic="true"
      aria-live={state === "failed" ? "assertive" : active ? "polite" : "off"}
      data-slot="agent-activity"
      data-state={state}
      role={state === "failed" ? "alert" : "status"}
      className="flex w-fit max-w-full items-center gap-2 text-[12px] leading-4"
    >
      <AgentActivityGlyph
        active={active}
        orbSize={orbSize}
        orbState={resolvedOrbState}
        state={state}
        theme={theme}
      />
      <span className="min-w-0 truncate text-foreground/80">{resolvedLabel}</span>
      {detail ? (
        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </div>
  );

  return (
    <div className={cn("w-fit max-w-full", className)}>{content}</div>
  );
}

function AgentActivityGlyph({
  active,
  orbSize,
  orbState,
  state,
  theme,
}: {
  active: boolean;
  orbSize: OrbSize;
  orbState: OrbState;
  state: AgentActivityState;
  theme: OrbTheme;
}) {
  if (active) {
    return (
      <ThinkingOrb
        aria-label={state === "thinking" ? "Agent is thinking" : "Agent tool is running"}
        className="shrink-0"
        size={orbSize}
        state={orbState}
        theme={theme}
      />
    );
  }

  if (state === "failed") {
    return <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />;
  }

  return <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />;
}
