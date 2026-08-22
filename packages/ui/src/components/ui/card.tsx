import type { ComponentProps } from "react";

function classes(base: string, className: string | undefined): string {
  return className === undefined ? base : `${base} ${className}`;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card", className)} data-slot="card" {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card-header", className)} data-slot="card-header" {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card-title", className)} data-slot="card-title" {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card-description", className)} data-slot="card-description" {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card-content", className)} data-slot="card-content" {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={classes("og-card-footer", className)} data-slot="card-footer" {...props} />;
}
