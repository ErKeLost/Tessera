"use client";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const BubbleBlockSchema = z.object({
  text: z.string(),
  variant: z
    .enum(["default", "secondary", "muted", "tinted", "outline", "ghost", "destructive"])
    .optional(),
  align: z.enum(["start", "end"]).optional(),
});

export const BubbleBlock = defineComponent({
  name: "BubbleBlock",
  props: BubbleBlockSchema,
  description:
    'Single chat bubble holding one short piece of text — a quote, a user line, or a highlighted takeaway. variant: "default" (filled primary), "secondary" (muted fill), "muted", "tinted" (subtle primary tint), "outline" (bordered), "ghost" (no chrome), "destructive" (red). align: "start" | "end" (end pushes it to the right, like the reader\'s own message).',
  component: ({ props }) => (
    <Bubble variant={props.variant ?? "default"} align={props.align ?? "start"}>
      <BubbleContent>{props.text}</BubbleContent>
    </Bubble>
  ),
});
