"use client";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { z } from "zod";

const PopoverBlockSchema = z.object({
  trigger: z.string(),
  title: z.string().optional(),
  body: z.string(),
});

export const PopoverBlock = defineComponent({
  name: "PopoverBlock",
  props: PopoverBlockSchema,
  description:
    "Button that opens a small floating panel holding extra text. trigger: button label, title: optional panel heading, body: the panel text. Use it for optional details that should stay hidden until asked for; use MarkDownRenderer instead when the text should always be visible.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" disabled={isStreaming}>
            {props.trigger}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverHeader>
            {props.title && <PopoverTitle>{props.title}</PopoverTitle>}
            <PopoverDescription>{props.body}</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    );
  },
});
