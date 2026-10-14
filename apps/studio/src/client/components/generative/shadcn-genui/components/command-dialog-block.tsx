"use client";

import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import React from "react";
import { z } from "zod";

const CommandDialogBlockSchema = z.object({
  trigger: z.string(),
  title: z.string().optional(),
  items: z.array(z.string()),
});

export const CommandDialogBlock = defineComponent({
  name: "CommandDialogBlock",
  props: CommandDialogBlockSchema,
  description:
    "Button that opens a command palette modal with a search field and a filterable list. trigger: button label, title: palette heading, items: the searchable option labels. Clicking an option closes the palette and sends its text to the assistant. Use it for searchable actions instead of CommandBlock when the list should not take space in the answer.",
  component: ({ props }) => {
    const [open, setOpen] = React.useState(false);
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const items = props.items ?? [];

    return (
      <>
        <Button variant="outline" disabled={isStreaming} onClick={() => setOpen(true)}>
          {props.trigger}
        </Button>
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          title={props.title ?? "Command Palette"}
          description="Search for a command to run..."
        >
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {items.map((item, index) => (
                <CommandItem
                  key={index}
                  value={item}
                  onSelect={() => {
                    setOpen(false);
                    void triggerAction(item);
                  }}
                >
                  {item}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </CommandDialog>
      </>
    );
  },
});
