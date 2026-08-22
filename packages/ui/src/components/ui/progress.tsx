import { Progress as ProgressPrimitive } from "radix-ui";
import type { ComponentProps, CSSProperties } from "react";

export type ProgressProps = ComponentProps<typeof ProgressPrimitive.Root> & Readonly<{
  indicatorClassName?: string;
  orientation?: "horizontal" | "vertical";
}>;

export function Progress({
  className,
  indicatorClassName,
  max = 100,
  orientation = "horizontal",
  value = 0,
  ...props
}: ProgressProps) {
  const boundedValue = Math.min(Math.max(value ?? 0, 0), max);
  const percentage = max <= 0 ? 0 : boundedValue / max * 100;
  return (
    <ProgressPrimitive.Root
      aria-orientation={orientation}
      className={className === undefined ? "og-progress" : `og-progress ${className}`}
      data-orientation={orientation}
      data-slot="progress"
      max={max}
      value={boundedValue}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={indicatorClassName === undefined ? "og-progress-indicator" : `og-progress-indicator ${indicatorClassName}`}
        data-slot="progress-indicator"
        style={{ "--og-progress-value": `${percentage}%` } as CSSProperties}
      />
    </ProgressPrimitive.Root>
  );
}
