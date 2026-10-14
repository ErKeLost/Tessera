"use client";

import { Button } from "@/components/ui/button";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { toast } from "sonner";
import { z } from "zod";

const ToastBlockSchema = z.object({
  text: z.string(),
  description: z.string().optional(),
  trigger: z.string().optional(),
  variant: z.enum(["default", "success", "error"]).optional(),
});

export const ToastBlock = defineComponent({
  name: "ToastBlock",
  props: ToastBlockSchema,
  description:
    'Notification trigger. Renders a button that raises a toast when pressed — it never fires on its own. variant: "default" | "success" | "error".',
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const variant = props.variant ?? "default";
    const label = props.trigger ?? "Show notification";
    const options = props.description ? { description: props.description } : undefined;

    return (
      <Button
        variant="outline"
        disabled={isStreaming}
        onClick={() => {
          if (variant === "success") {
            toast.success(props.text, options);
          } else if (variant === "error") {
            toast.error(props.text, options);
          } else {
            toast(props.text, options);
          }
        }}
      >
        {label}
      </Button>
    );
  },
});
