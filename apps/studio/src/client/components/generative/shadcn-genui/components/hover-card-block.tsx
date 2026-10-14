"use client";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const HoverCardBlockSchema = z.object({
  trigger: z.string(),
  title: z.string(),
  body: z.string(),
});

export const HoverCardBlock = defineComponent({
  name: "HoverCardBlock",
  props: HoverCardBlockSchema,
  description:
    "Inline term that reveals a richer card on hover. trigger: the visible term, title: card heading, body: card text. Use it when a term needs a longer explanation than a tooltip can hold.",
  component: ({ props }) => (
    <HoverCard>
      <HoverCardTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-4">
          {props.trigger}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start">
        <div className="space-y-1">
          <div className="text-sm font-medium">{props.title}</div>
          <p className="text-sm text-muted-foreground">{props.body}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
});
