import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const badgeVariants = cva("og-badge", {
  variants: {
    variant: {
      default: "og-badge-default",
      positive: "og-badge-positive",
      secondary: "og-badge-secondary",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={badgeVariants({ className, variant })}
      data-slot="badge"
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export { badgeVariants };
