"use client";

import { AlertDescription, AlertTitle, Alert as ShadcnAlert } from "@/components/ui/alert";
import { defineComponent } from "@openuidev/react-lang";
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { z } from "zod";

const AlertSchema = z.object({
  title: z.string(),
  description: z.string(),
  variant: z.enum(["default", "destructive", "info", "success", "warning"]).optional(),
});

const variantStyles: Record<string, string> = {
  info: "border-primary/30 bg-primary/5 [&>svg]:text-primary",
  success: "border-success/30 bg-success/5 [&>svg]:text-success",
  warning: "border-warning/30 bg-warning/5 [&>svg]:text-warning",
};

const iconMap = {
  default: null,
  destructive: AlertCircle,
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
};

export const Alert = defineComponent({
  name: "Alert",
  props: AlertSchema,
  description:
    'Alert banner with icon, title, and description. variant: "default" | "destructive" | "info" | "success" | "warning".',
  component: ({ props }) => {
    const v = props.variant ?? "default";
    const shadcnVariant = v === "destructive" ? "destructive" : "default";
    const extraClass = variantStyles[v] ?? "";
    const Icon = iconMap[v as keyof typeof iconMap];

    return (
      <ShadcnAlert variant={shadcnVariant} className={extraClass}>
        {Icon && <Icon className="size-4" />}
        <AlertTitle>{props.title}</AlertTitle>
        <AlertDescription>{props.description}</AlertDescription>
      </ShadcnAlert>
    );
  },
});
