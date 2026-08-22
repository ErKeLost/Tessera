"use client";

import type {
  ContentCalloutProps,
  ContentEmptyProps,
  ContentTextProps,
} from "@open-generative/components";
import type { RendererInput } from "@open-generative/react";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  FilterX,
  Inbox,
  Info,
  RotateCcw,
  Settings2,
  TriangleAlert,
  X,
} from "lucide-react";
import { createElement } from "react";
import { canEmit, emitEvent, officialRendererEventPorts } from "./events";
import { EmptyState, IconButton, Surface, classes } from "./primitives";

const calloutIcons = {
  info: Info,
  positive: CircleCheck,
  warning: TriangleAlert,
  critical: CircleAlert,
} as const;

const emptyIcons = {
  "no-data": Inbox,
  filtered: FilterX,
  unavailable: CircleX,
  "not-configured": Settings2,
} as const;

export function ContentTextRenderer({ resolvedProps }: RendererInput<ContentTextProps>) {
  if (resolvedProps.role === "heading") {
    return createElement(
      `h${resolvedProps.level}`,
      {
        className: classes("og-ui og-text og-text-heading", `og-text-${resolvedProps.tone}`),
        "data-og-component": "content.text",
      },
      resolvedProps.text,
    );
  }
  if (resolvedProps.role === "code") {
    return (
      <pre className={classes("og-ui og-text og-text-code", `og-text-${resolvedProps.tone}`)} data-og-component="content.text">
        <code>{resolvedProps.text}</code>
      </pre>
    );
  }
  const Element = resolvedProps.role === "caption" ? "small" : "p";
  return (
    <Element
      className={classes("og-ui og-text", `og-text-${resolvedProps.role}`, `og-text-${resolvedProps.tone}`)}
      data-og-component="content.text"
    >
      {resolvedProps.text}
    </Element>
  );
}

export function ContentCalloutRenderer(input: RendererInput<ContentCalloutProps>) {
  const { resolvedProps, slots } = input;
  const Icon = calloutIcons[resolvedProps.tone];
  const dismissible = resolvedProps.dismissible && canEmit(input, officialRendererEventPorts.dismiss);
  return (
    <Surface
      aria-live={resolvedProps.tone === "critical" ? "assertive" : "polite"}
      className={classes("og-callout", `og-callout-${resolvedProps.tone}`)}
      data-og-component="content.callout"
      role={resolvedProps.tone === "critical" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" className="og-callout-icon" size={18} strokeWidth={1.8} />
      <div className="og-callout-copy">
        {resolvedProps.title ? <strong>{resolvedProps.title}</strong> : null}
        <p>{resolvedProps.body}</p>
        {slots.actions?.length ? <div className="og-callout-actions">{slots.actions}</div> : null}
      </div>
      {dismissible ? (
        <IconButton
          className="og-callout-dismiss"
          icon={X}
          label="Dismiss"
          onClick={() => emitEvent(input, officialRendererEventPorts.dismiss, {})}
          size="sm"
          variant="ghost"
        />
      ) : null}
    </Surface>
  );
}

export function ContentEmptyRenderer(input: RendererInput<ContentEmptyProps>) {
  const { resolvedProps, slots } = input;
  const Icon = emptyIcons[resolvedProps.reason];
  return (
    <Surface className="og-empty-surface" data-og-component="content.empty" role="status" tone="muted">
      <EmptyState description={resolvedProps.description} icon={Icon} title={resolvedProps.title}>
        {resolvedProps.retryable && canEmit(input, officialRendererEventPorts.retry) ? (
          <IconButton
            icon={RotateCcw}
            label="Retry"
            onClick={() => emitEvent(input, officialRendererEventPorts.retry, {})}
            variant="outline"
          />
        ) : null}
        {slots.actions?.length ? <div className="og-empty-actions">{slots.actions}</div> : null}
      </EmptyState>
    </Surface>
  );
}
