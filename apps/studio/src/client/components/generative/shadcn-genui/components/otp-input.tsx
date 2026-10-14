"use client";

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import * as React from "react";
import { z } from "zod";

const OtpInputSchema = z.object({
  label: z.string(),
  length: z.number().optional(),
});

export const OtpInput = defineComponent({
  name: "OtpInput",
  props: OtpInputSchema,
  description:
    "One-time passcode input made of separate character slots. label: field label. length: number of slots (default 6).",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const [value, setValue] = React.useState("");
    const requested = Number(props.length ?? 6);
    const length = Number.isFinite(requested)
      ? Math.max(1, Math.min(8, Math.floor(requested)))
      : 6;

    return (
      <div className="space-y-2">
        {props.label && <Label>{props.label}</Label>}
        <InputOTP
          maxLength={length}
          value={value}
          onChange={setValue}
          disabled={isStreaming}
          aria-label={props.label}
        >
          <InputOTPGroup>
            {Array.from({ length }, (_, index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
    );
  },
});
