"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { ChevronDown } from "lucide-react";
import { z } from "zod";

const DropdownMenuBlockSchema = z.object({
  trigger: z.string(),
  items: z.array(z.string()),
});

export const DropdownMenuBlock = defineComponent({
  name: "DropdownMenuBlock",
  props: DropdownMenuBlockSchema,
  description:
    "Button that opens a dropdown menu of actions. trigger: button label, items: the menu entries. Selecting an entry sends its text to the assistant. Use it when several distinct actions should be available from one button.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const items = props.items ?? [];

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={isStreaming}>
            {props.trigger}
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {items.map((item, index) => (
            <DropdownMenuItem key={index} onSelect={() => void triggerAction(item)}>
              {item}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
});
