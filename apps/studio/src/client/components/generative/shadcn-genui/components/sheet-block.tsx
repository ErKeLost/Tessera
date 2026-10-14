"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { z } from "zod";

const SheetBlockSchema = z.object({
  trigger: z.string(),
  title: z.string(),
  body: z.string(),
  side: z.enum(["top", "bottom", "left", "right"]).optional(),
});

export const SheetBlock = defineComponent({
  name: "SheetBlock",
  props: SheetBlockSchema,
  description:
    "Button that opens a side panel. trigger: the button label, title and body: the panel heading and its text, side: which edge the panel slides from. Use it when supporting detail should stay out of the answer until the reader asks for it.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();

    return (
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline" disabled={isStreaming}>
            {props.trigger}
          </Button>
        </SheetTrigger>
        <SheetContent side={props.side ?? "right"}>
          <SheetHeader>
            <SheetTitle>{props.title}</SheetTitle>
            <SheetDescription>{props.body}</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
  },
});
