"use client";

import { NativeSelect as ShadcnNativeSelect } from "@/components/ui/native-select";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const NativeSelectSchema = z.object({
  label: z.string(),
  options: z.array(z.string()),
  placeholder: z.string().optional(),
});

export const NativeSelect = defineComponent({
  name: "NativeSelect",
  props: NativeSelectSchema,
  description:
    "Labelled native select dropdown rendered by the browser. label: field label, options: the selectable values, placeholder: text for the empty first entry. Choosing an option sends its text to the assistant.",
  component: ({ props }) => {
    const triggerAction = useTriggerAction();
    const isStreaming = useIsStreaming();
    const options = props.options ?? [];

    return (
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {props.label}
        <ShadcnNativeSelect
          className="w-full"
          defaultValue=""
          disabled={isStreaming}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value) void triggerAction(value);
          }}
        >
          <option value="" disabled>
            {props.placeholder ?? "Select..."}
          </option>
          {options.map((option, index) => (
            <option key={index} value={option}>
              {option}
            </option>
          ))}
        </ShadcnNativeSelect>
      </label>
    );
  },
});
