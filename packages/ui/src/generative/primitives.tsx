"use client";

import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";
import type { LucideIcon } from "lucide-react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type SurfaceProps = HTMLAttributes<HTMLElement> & {
  as?: "article" | "div" | "section";
  tone?: "default" | "muted";
};

export function Surface({
  as: Element = "section",
  className,
  tone = "default",
  ...props
}: SurfaceProps) {
  return (
    <Element
      {...props}
      className={classes("og-ui og-surface", `og-surface-${tone}`, className)}
      data-og-primitive="surface"
    />
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost" | "destructive";
  size?: "sm" | "md";
};

export function Button({
  className,
  size = "md",
  type = "button",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={classes("og-button", `og-button-${variant}`, `og-button-${size}`, className)}
      data-og-primitive="button"
      type={type}
    />
  );
}

export type IconButtonProps = Omit<ButtonProps, "children"> & {
  icon: LucideIcon;
  label: string;
};

export function IconButton({ icon: Icon, label, title, ...props }: IconButtonProps) {
  return (
    <Button {...props} aria-label={label} className={classes("og-icon-button", props.className)} title={title ?? label}>
      <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
    </Button>
  );
}

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "default" | "positive" | "negative" | "warning" | "info";
};

export function Badge({ className, tone = "default", ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={classes("og-badge", `og-badge-${tone}`, className)}
      data-og-primitive="badge"
    />
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...props }: InputProps) {
  return <input {...props} className={classes("og-input", className)} data-og-primitive="input" />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, ...props }: SelectProps) {
  return <select {...props} className={classes("og-select", className)} data-og-primitive="select" />;
}

export type SkeletonProps = HTMLAttributes<HTMLDivElement> & {
  lines?: number;
};

export function Skeleton({ className, lines = 3, ...props }: SkeletonProps) {
  return (
    <div {...props} aria-busy="true" className={classes("og-skeleton", className)} data-og-primitive="skeleton">
      {Array.from({ length: lines }, (_, index) => (
        <span aria-hidden="true" className="og-skeleton-line" key={index} />
      ))}
      <span className="og-sr-only">Loading</span>
    </div>
  );
}

export type EmptyStateProps = HTMLAttributes<HTMLDivElement> & {
  description?: string;
  icon?: LucideIcon;
  title: string;
};

export function EmptyState({
  className,
  description,
  icon: Icon,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div {...props} className={classes("og-empty", className)} data-og-primitive="empty-state">
      {Icon ? <Icon aria-hidden="true" className="og-empty-icon" size={20} strokeWidth={1.7} /> : null}
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

export { classes };
