"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const TooltipBlockSchema = z.object({
  text: z.string(),
  hint: z.string(),
});

export const TooltipBlock = defineComponent({
  name: "TooltipBlock",
  props: TooltipBlockSchema,
  description:
    "Inline term with a hover tooltip. text: the visible term, hint: the explanation shown on hover. Use it to explain jargon or abbreviations without spending space in the answer.",
  component: ({ props }) => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted underline-offset-4">
            {props.text}
          </span>
        </TooltipTrigger>
        <TooltipContent>{props.hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
});
