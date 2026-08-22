import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

const buttonVariants = cva("og-button", {
  variants: {
    variant: {
      default: "og-button-default",
      ghost: "og-button-ghost",
      outline: "og-button-outline",
    },
    size: {
      default: "og-button-size-default",
      icon: "og-button-size-icon",
      "icon-xs": "og-button-size-icon-xs",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> &
  Readonly<{ asChild?: boolean }>;

export function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      className={buttonVariants({ className, size, variant })}
      data-size={size ?? "default"}
      data-slot="button"
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export { buttonVariants };
