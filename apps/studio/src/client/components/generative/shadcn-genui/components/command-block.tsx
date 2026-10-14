"use client";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const CommandBlockSchema = z.object({
  title: z.string().optional(),
  items: z.array(z.string()),
});

export const CommandBlock = defineComponent({
  name: "CommandBlock",
  props: CommandBlockSchema,
  description:
    "Inline command palette with a search field and a filterable list of options. items: the searchable option labels. Clicking an option sends its text to the assistant. Use it when the user must pick from a long, searchable list of choices.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const items = props.items ?? [];

    return (
      <div className="overflow-hidden rounded-(--radius-card) border">
        <Command>
          {props.title && (
            <div className="border-b px-3 py-2 text-sm font-medium">{props.title}</div>
          )}
          <CommandInput placeholder="Search..." disabled={isStreaming} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {items.map((item, index) => (
                <CommandItem
                  key={index}
                  value={item}
                  disabled={isStreaming}
                  onSelect={() => void triggerAction(item)}
                >
                  {item}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </div>
    );
  },
});
