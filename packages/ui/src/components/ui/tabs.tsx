import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

function classes(base: string, className: string | undefined): string {
  return className === undefined ? base : `${base} ${className}`;
}

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={classes("og-tabs", className)} data-slot="tabs" {...props} />;
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={classes("og-tabs-list", className)} data-slot="tabs-list" {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={classes("og-tabs-trigger", className)} data-slot="tabs-trigger" {...props} />;
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={classes("og-tabs-content", className)} data-slot="tabs-content" {...props} />;
}
