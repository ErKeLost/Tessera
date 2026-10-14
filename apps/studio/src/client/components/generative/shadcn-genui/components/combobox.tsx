"use client";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { ChevronsUpDown } from "lucide-react";
import React from "react";
import { z } from "zod";

const ComboboxSchema = z.object({
  label: z.string(),
  options: z.array(z.string()),
  placeholder: z.string().optional(),
});

export const Combobox = defineComponent({
  name: "Combobox",
  props: ComboboxSchema,
  description:
    "Labelled combobox: a button showing the current choice that opens a searchable option list. label: field label, options: the selectable values, placeholder: text shown before a choice is made. Picking an option sends its text to the assistant. Use it when the user must choose one value from a long list.",
  component: ({ props }) => {
    const [open, setOpen] = React.useState(false);
    const [value, setValue] = React.useState<string | null>(null);
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const options = props.options ?? [];

    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{props.label}</span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              disabled={isStreaming}
              className="w-full justify-between"
            >
              <span className="truncate">
                {value ?? props.placeholder ?? props.label}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--radix-popover-trigger-width) p-0"
          >
            <Command>
              <CommandInput placeholder="Search..." />
              <CommandList>
                <CommandEmpty>No results found.</CommandEmpty>
                <CommandGroup>
                  {options.map((option, index) => (
                    <CommandItem
                      key={index}
                      value={option}
                      onSelect={() => {
                        setValue(option);
                        setOpen(false);
                        void triggerAction(option);
                      }}
                    >
                      {option}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    );
  },
});
