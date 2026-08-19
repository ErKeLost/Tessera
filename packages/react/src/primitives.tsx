"use client";

import { InboxIcon, XIcon, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { useArtifactUI, useArtifactSlotClass } from "./bridge";
import { control, field, ghostButton, paper, shape, typography } from "./tokens";
import { cn } from "./utils";

export type ArtifactProps = HTMLAttributes<HTMLDivElement> & { "data-theme"?: string };

export function Artifact({ className, style, "data-theme": dataTheme, ...props }: ArtifactProps) {
  const { themeName, themeVariables } = useArtifactUI();
  const slotClass = useArtifactSlotClass("artifact");
  return (
    <section
      {...props}
      className={cn("de-artifact de-theme-root group/artifact flex min-w-0 flex-col overflow-hidden text-foreground", paper, shape.panel, slotClass, className)}
      data-slot="artifact"
      data-theme={dataTheme ?? themeName}
      style={{ ...themeVariables, ...style }}
    />
  );
}

export function ArtifactHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const slotClass = useArtifactSlotClass("artifact-header");
  return <header {...props} className={cn("flex min-w-0 items-start justify-between gap-4 px-4 py-4", slotClass, className)} data-slot="artifact-header" />;
}

export function ArtifactTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  const slotClass = useArtifactSlotClass("artifact-title");
  return <h3 {...props} className={cn(typography.title, "min-w-0 text-balance", slotClass, className)} data-slot="artifact-title" />;
}

export function ArtifactDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  const slotClass = useArtifactSlotClass("artifact-description");
  return <p {...props} className={cn(typography.body, "mt-1 max-w-[62ch] text-pretty text-muted-foreground", slotClass, className)} data-slot="artifact-description" />;
}

export function ArtifactActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const slotClass = useArtifactSlotClass("artifact-actions");
  return <div {...props} className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", slotClass, className)} data-slot="artifact-actions" />;
}

export type ArtifactActionProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; label: string };

export function ArtifactAction({ className, icon: Icon, label, children, ...props }: ArtifactActionProps) {
  const slotClass = useArtifactSlotClass("artifact-action");
  return (
    <button
      {...props}
      aria-label={label}
      className={cn(ghostButton, control.iconButton, "inline-flex touch-manipulation items-center justify-center disabled:pointer-events-none disabled:opacity-40", Icon ? "size-7" : "gap-1.5 px-3", slotClass, className)}
      data-slot="artifact-action"
      title={props.title ?? label}
      type={props.type ?? "button"}
    >
      {Icon ? <><Icon aria-hidden="true" className="size-4" /><span className="sr-only">{label}</span></> : children}
    </button>
  );
}

export function ArtifactClose(props: Omit<ArtifactActionProps, "icon" | "label"> & { label?: string }) {
  const { label = "Close artifact", ...buttonProps } = props;
  return <ArtifactAction icon={XIcon} label={label} {...buttonProps} />;
}

export function ArtifactContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const slotClass = useArtifactSlotClass("artifact-content");
  return <div {...props} className={cn("min-w-0 flex-1", slotClass, className)} data-slot="artifact-content" />;
}

export function ArtifactStatus({ className, icon: Icon, children, ...props }: HTMLAttributes<HTMLSpanElement> & { icon?: LucideIcon }) {
  const slotClass = useArtifactSlotClass("artifact-status");
  return <span {...props} className={cn(typography.metadata, "inline-flex shrink-0 items-center gap-1", slotClass, className)} data-slot="artifact-status">{Icon && <Icon aria-hidden="true" className="size-3" />}{children}</span>;
}

export type ArtifactEmptyProps = HTMLAttributes<HTMLDivElement> & {
  "data-theme"?: string;
  title?: string;
  description?: string;
};

export function ArtifactEmpty({ className, style, "data-theme": dataTheme, title = "Nothing to display", description = "The artifact returned no renderable data.", ...props }: ArtifactEmptyProps) {
  const { themeName, themeVariables } = useArtifactUI();
  const rootClass = useArtifactSlotClass("artifact-empty");
  const iconClass = useArtifactSlotClass("artifact-empty-icon");
  const titleClass = useArtifactSlotClass("artifact-empty-title");
  const descriptionClass = useArtifactSlotClass("artifact-empty-description");
  return (
    <div {...props} className={cn("de-theme-root", field, "grid min-h-52 place-items-center p-8 text-center", shape.panel, rootClass, className)} data-slot="artifact-empty" data-theme={dataTheme ?? themeName} style={{ ...themeVariables, ...style }}>
      <div className="flex max-w-sm flex-col items-center">
        <span className={cn(paper, "mb-3 grid size-9 place-items-center text-muted-foreground", shape.field, iconClass)} data-slot="artifact-empty-icon"><InboxIcon aria-hidden="true" className="size-4" /></span>
        <p className={cn(typography.title, titleClass)} data-slot="artifact-empty-title">{title}</p>
        <p className={cn(typography.body, "mt-1.5 text-pretty text-muted-foreground", descriptionClass)} data-slot="artifact-empty-description">{description}</p>
      </div>
    </div>
  );
}
