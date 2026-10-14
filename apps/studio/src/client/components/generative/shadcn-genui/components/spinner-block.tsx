"use client";

import { Spinner } from "@/components/ui/spinner";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const SpinnerBlockSchema = z.object({
  label: z.string().optional(),
});

export const SpinnerBlock = defineComponent({
  name: "SpinnerBlock",
  props: SpinnerBlockSchema,
  description: "Inline loading indicator with an optional text label.",
  component: ({ props }) => (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner className="size-4" />
      {props.label && <span>{props.label}</span>}
    </div>
  ),
});
