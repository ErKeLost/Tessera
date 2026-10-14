"use client";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const ContextMenuBlockSchema = z.object({
  trigger: z.string(),
  items: z.array(z.string()),
});

export const ContextMenuBlock = defineComponent({
  name: "ContextMenuBlock",
  props: ContextMenuBlockSchema,
  description:
    "Menu that opens on right-click. trigger: the hint shown on the target area, items: the actions. Selecting one sends its text to the assistant. Use it when the answer offers actions on one specific thing.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const items = props.items ?? [];

    return (
      <ContextMenu>
        <ContextMenuTrigger className="flex min-h-24 w-full items-center justify-center rounded-(--radius-control) border border-dashed p-4 text-center text-muted-foreground text-sm">
          {props.trigger}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {items.map((item, index) => (
            <ContextMenuItem
              key={index}
              disabled={isStreaming}
              onSelect={() => void triggerAction(item)}
            >
              {item}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  },
});
