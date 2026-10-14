"use client";

import {
  InputGroup as ShadcnInputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import * as React from "react";
import { z } from "zod";

const InputGroupSchema = z.object({
  label: z.string(),
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  placeholder: z.string().optional(),
});

export const InputGroup = defineComponent({
  name: "InputGroup",
  props: InputGroupSchema,
  description:
    "Text input with optional prefix and suffix text inside the field. label: field label. prefix/suffix: inline text such as a currency or unit.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const [value, setValue] = React.useState("");

    return (
      <div className="space-y-2">
        {props.label && <Label>{props.label}</Label>}
        <ShadcnInputGroup>
          {props.prefix && (
            <InputGroupAddon align="inline-start">
              <InputGroupText>{props.prefix}</InputGroupText>
            </InputGroupAddon>
          )}
          <InputGroupInput
            placeholder={props.placeholder ?? ""}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={isStreaming}
            aria-label={props.label}
          />
          {props.suffix && (
            <InputGroupAddon align="inline-end">
              <InputGroupText>{props.suffix}</InputGroupText>
            </InputGroupAddon>
          )}
        </ShadcnInputGroup>
      </div>
    );
  },
});
