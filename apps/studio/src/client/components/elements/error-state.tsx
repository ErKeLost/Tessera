"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ShimmerLabel } from "@/lib/surfaces";
import { StudioIcon } from "@/components/studio-icon";
import { Button } from "@/components/ui/button";

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
        data-state="retrying"
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
      data-state="error"
      key="error"
      role="alert"
      className={cn(
        "fade-in animate-in grid w-full max-w-xl grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-(--radius-card) bg-destructive/10 px-4 py-3 text-sm duration-300 motion-reduce:animate-none",
        className,
      )}

      {...props}
    >
      <StudioIcon className="mt-0.5 size-4 shrink-0 text-destructive/80" icon="solar:danger-triangle-linear" />
      <div className="min-w-0">
        <p className="font-semibold text-destructive">{title}</p>
        <p className="mt-0.5 leading-snug text-muted-foreground [overflow-wrap:anywhere]">
          {detail}
        </p>
      </div>
      <Button
        aria-label="Retry analysis"
        className="-me-1 -mt-1 shrink-0 self-start whitespace-nowrap px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        size="sm"
        type="button"
        onClick={onRetry}
        variant="ghost"
      >
        <StudioIcon icon="solar:refresh-linear" size={13} />
        Retry
      </Button>
    </div>
  );
}
