"use client";

import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import * as React from "react";
import { z } from "zod";

const ToggleBlockSchema = z.object({
  label: z.string(),
  pressed: z.boolean().optional(),
  variant: z.enum(["default", "outline"]).optional(),
});

export const ToggleBlock = defineComponent({
  name: "ToggleBlock",
  props: ToggleBlockSchema,
  description:
    'Single toggle button that stays pressed or unpressed. variant: "default" | "outline".',
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const [pressed, setPressed] = React.useState(props.pressed ?? false);

    return (
      <Toggle
        variant={props.variant ?? "default"}
        pressed={pressed}
        onPressedChange={setPressed}
        disabled={isStreaming}
      >
        {props.label}
      </Toggle>
    );
  },
});

const ToggleGroupBlockSchema = z.object({
  items: z.array(z.string()),
  variant: z.enum(["default", "outline"]).optional(),
  size: z.enum(["sm", "default", "lg"]).optional(),
});

export const ToggleGroupBlock = defineComponent({
  name: "ToggleGroupBlock",
  props: ToggleGroupBlockSchema,
  description:
    'Single-select row of toggle buttons. items: button labels. variant: "default" | "outline". size: "sm" | "default" | "lg".',
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const [value, setValue] = React.useState<string | undefined>(undefined);
    const items = props.items ?? [];

    if (items.length === 0) return null;

    return (
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={setValue}
        variant={props.variant ?? "outline"}
        size={props.size ?? "default"}
        disabled={isStreaming}
      >
        {items.map((item, index) => (
          <ToggleGroupItem key={`${item}-${index}`} value={item}>
            {item}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    );
  },
});
