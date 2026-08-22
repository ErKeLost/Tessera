"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleXIcon,
  InfoIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { ArtifactEmpty } from "./primitives";
import type { ArtifactNodeRendererProps } from "./node-types";
import { field, shape, typography } from "./tokens";
import { cn } from "./utils";

const gapClasses = {
  none: "gap-0",
  xs: "gap-1.5",
  sm: "gap-3",
  md: "gap-5",
  lg: "gap-8",
  xl: "gap-12",
} as const;

const alignClasses = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} as const;

export function LayoutStackNode({ nodeId, value, children }: ArtifactNodeRendererProps) {
  const gap = enumValue(value.gap, gapClasses, "md");
  const align = enumValue(value.align, alignClasses, "stretch");
  return (
    <div className={cn("flex min-w-0 flex-col", gapClasses[gap], alignClasses[align])} data-artifact-node-id={nodeId} data-node-type="layout.stack" tabIndex={-1}>
      {children}
    </div>
  );
}

export function LayoutGridNode({ nodeId, value, children }: ArtifactNodeRendererProps) {
  const gap = enumValue(value.gap, gapClasses, "md");
  const columns = typeof value.columns === "number" && Number.isInteger(value.columns)
    ? Math.min(4, Math.max(1, value.columns))
    : "auto";
  const style = {
    gridTemplateColumns: columns === "auto"
      ? "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))"
      : `repeat(${columns}, minmax(0, 1fr))`,
  } satisfies CSSProperties;
  return (
    <div className={cn("grid min-w-0", gapClasses[gap])} data-artifact-node-id={nodeId} data-node-type="layout.grid" style={style} tabIndex={-1}>
      {children}
    </div>
  );
}

export function LayoutSectionNode({ nodeId, value, children }: ArtifactNodeRendererProps) {
  const title = stringValue(value.title);
  const description = stringValue(value.description);
  return (
    <section className="min-w-0" data-artifact-node-id={nodeId} data-node-type="layout.section" tabIndex={-1}>
      {(title || description) && (
        <header className="mb-3 min-w-0">
          {title && <h2 className={cn(typography.title, "text-foreground")}>{title}</h2>}
          {description && <p className={cn(typography.body, "mt-1 max-w-[68ch] text-muted-foreground")}>{description}</p>}
        </header>
      )}
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function ContentTextNode({ nodeId, value }: ArtifactNodeRendererProps) {
  const text = stringValue(value.text) ?? "";
  const role = textRole(value.role ?? value.variant);
  const tone = enumValue(value.tone, textToneClasses, "default");
  if (role === "heading") {
    return <h3 className={cn(typography.heading, textToneClasses[tone])} data-artifact-node-id={nodeId} data-node-type="content.text" tabIndex={-1}>{text}</h3>;
  }
  if (role === "caption") {
    return <p className={cn(typography.caption, textToneClasses[tone])} data-artifact-node-id={nodeId} data-node-type="content.text" tabIndex={-1}>{text}</p>;
  }
  return <p className={cn(typography.body, "max-w-[72ch] whitespace-pre-wrap leading-6", textToneClasses[tone])} data-artifact-node-id={nodeId} data-node-type="content.text" tabIndex={-1}>{text}</p>;
}

const textToneClasses = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  positive: "de-positive",
  warning: "de-warning",
  critical: "de-negative",
} as const;

const calloutStyles = {
  info: { icon: InfoIcon, className: "text-foreground" },
  success: { icon: CheckCircle2Icon, className: "de-positive" },
  warning: { icon: CircleAlertIcon, className: "de-warning" },
  critical: { icon: CircleXIcon, className: "de-negative" },
} as const;

export function ContentCalloutNode({ nodeId, value, children }: ArtifactNodeRendererProps) {
  const rawTone = value.tone === "danger" ? "critical" : value.tone;
  const tone = enumValue(rawTone, calloutStyles, "info");
  const style = calloutStyles[tone];
  const Icon = style.icon;
  const title = stringValue(value.title);
  const text = stringValue(value.body) ?? stringValue(value.text) ?? stringValue(value.description);
  return (
    <aside className={cn(field, "flex min-w-0 gap-3 px-4 py-3", shape.callout)} data-artifact-node-id={nodeId} data-node-type="content.callout" role={tone === "critical" ? "alert" : "note"} tabIndex={-1}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", style.className)} />
      <div className="min-w-0 flex-1">
        {title && <p className={typography.label}>{title}</p>}
        {text && <p className={cn(typography.body, title && "mt-0.5")}>{text}</p>}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </aside>
  );
}

export function ContentProgressNode({ nodeId, value }: ArtifactNodeRendererProps) {
  const rawValue = typeof value.value === "number" && Number.isFinite(value.value) ? value.value : 0;
  const maximum = typeof value.max === "number" && Number.isFinite(value.max) && value.max > 0 ? value.max : 100;
  const normalized = Math.min(100, Math.max(0, (rawValue / maximum) * 100));
  const label = stringValue(value.label);
  const detail = stringValue(value.detail);
  const showValue = value.showValue !== false;
  return (
    <div className="min-w-0" data-artifact-node-id={nodeId} data-node-type="content.progress" tabIndex={-1}>
      {(label || showValue) && (
        <div className={cn(typography.body, "mb-1.5 flex min-w-0 items-baseline justify-between gap-3")}>
          <span className="truncate font-medium text-foreground">{label}</span>
          {showValue && <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(normalized)}%</span>}
        </div>
      )}
      <div
        aria-label={label ?? "Progress"}
        aria-valuemax={maximum}
        aria-valuemin={0}
        aria-valuenow={rawValue}
        className="de-progress-track"
        role="progressbar"
      >
        <div className="de-progress-value" style={{ width: `${normalized}%` }} />
      </div>
      {detail && <p className={cn(typography.body, "mt-1.5 text-muted-foreground")}>{detail}</p>}
    </div>
  );
}

export function ContentEmptyNode({ nodeId, value }: ArtifactNodeRendererProps) {
  return (
    <ArtifactEmpty
      data-artifact-node-id={nodeId}
      description={stringValue(value.description) ?? "There is no data available for this view."}
      tabIndex={-1}
      title={stringValue(value.title) ?? "Nothing to display"}
    />
  );
}

export const officialSurfaceNodeRenderers = Object.freeze({
  "layout.stack": LayoutStackNode,
  "layout.grid": LayoutGridNode,
  "layout.section": LayoutSectionNode,
  "content.text": ContentTextNode,
  "content.callout": ContentCalloutNode,
  "content.progress": ContentProgressNode,
  "content.empty": ContentEmptyNode,
});

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function textRole(value: unknown): "heading" | "paragraph" | "caption" {
  if (value === "heading" || value === "caption" || value === "paragraph") return value;
  return value === "body" ? "paragraph" : "paragraph";
}

function enumValue<TValues extends Readonly<Record<string, unknown>>>(
  value: unknown,
  values: TValues,
  fallback: Extract<keyof TValues, string>,
): Extract<keyof TValues, string> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(values, value)
    ? value as Extract<keyof TValues, string>
    : fallback;
}

export function renderSlot(slots: Readonly<Record<string, ReactNode[]>>, name = "children"): ReactNode {
  return slots[name] ?? null;
}
