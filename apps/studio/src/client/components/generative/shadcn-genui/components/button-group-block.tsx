"use client";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const ButtonGroupBlockSchema = z.object({
  items: z.array(z.string()),
  direction: z.enum(["row", "column"]).optional(),
});

export const ButtonGroupBlock = defineComponent({
  name: "ButtonGroupBlock",
  props: ButtonGroupBlockSchema,
  description:
    'Row or column of attached buttons. Clicking a button sends its label to the assistant as the next user message. direction: "row" | "column".',
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const items = props.items ?? [];

    if (items.length === 0) return null;

    return (
      <ButtonGroup orientation={props.direction === "column" ? "vertical" : "horizontal"}>
        {items.map((item, index) => (
          <Button
            key={`${item}-${index}`}
            variant="outline"
            disabled={isStreaming}
            onClick={() => triggerAction(item)}
          >
            {item}
          </Button>
        ))}
      </ButtonGroup>
    );
  },
});
