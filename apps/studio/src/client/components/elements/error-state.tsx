"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "@/lib/surfaces";
import { StudioIcon } from "@/components/studio-icon";

export interface ErrorStateProps extends Omit<
  ComponentProps<"div">,
  "children" | "role"
> {
  title: string;
  detail: ReactNode;
  retrying: boolean;
  onRetry: () => void;
}

export function ErrorState({
  title,
  detail,
  retrying,
  onRetry,
  className,
  ...props
}: ErrorStateProps) {
  if (retrying) {
    return (
      <div
        data-slot="error-state"
        key="retrying"
        role="status"
        className={cn(
          "fade-in animate-in flex w-full max-w-sm items-center gap-2.5 text-sm duration-300 motion-reduce:animate-none",
          className,
        )}

        {...props}
      >
        <StudioIcon className="text-foreground/45 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" icon="solar:refresh-linear" />
        <ShimmerLabel className="text-foreground/55 relative inline-block">
          Retrying
        </ShimmerLabel>
      </div>
    );
  }

  return (
    <div
      data-slot="error-state"
      key="error"
      role="alert"
      className={cn(
        "fade-in animate-in flex w-full max-w-sm items-start gap-2.5 rounded-2xl bg-destructive/10 px-4 py-3 text-sm duration-300 motion-reduce:animate-none",
        className,
      )}

      {...props}
    >
      <StudioIcon className="mt-0.5 size-4 shrink-0 text-destructive/80" icon="solar:danger-triangle-linear" />
      <div>
        <p className="font-medium text-destructive">{title}</p>
        <p className="mt-0.5 text-[13px] leading-snug text-destructive/70">
          {detail}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="ms-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
      >
        <StudioIcon icon="solar:refresh-linear" size={13} />
        Retry
      </button>
    </div>
  );
}
