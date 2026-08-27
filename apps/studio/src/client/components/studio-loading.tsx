import { cn } from "@/lib/utils";

import { ProductLogoLovartStyle } from "./product-logo-lovart-style";

export type StudioLoadingSize = "compact" | "default" | "large";

export interface StudioLoadingProps {
  label?: string;
  size?: StudioLoadingSize;
  className?: string;
}

const CANVAS_SIZE: Record<StudioLoadingSize, number> = {
  compact: 44,
  default: 72,
  large: 96,
};

export function StudioLoading({
  label = "Loading",
  size = "default",
  className,
}: StudioLoadingProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      className={cn("studio-loading", className)}
      data-size={size}
    >
      <ProductLogoLovartStyle
        aria-hidden
        className="studio-loading-canvas"
        size={CANVAS_SIZE[size]}
      />
      {label ? <span className="studio-loading-label">{label}</span> : null}
    </div>
  );
}
