"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const ScrollAreaBlockSchema = z.object({
  title: z.string(),
  lines: z.array(z.string()),
});

export const ScrollAreaBlock = defineComponent({
  name: "ScrollAreaBlock",
  props: ScrollAreaBlockSchema,
  description:
    "Titled panel of fixed height that scrolls its own lines. title: the panel heading, lines: the text entries, one per line. Use it for a short log or a list of plain lines that would otherwise make the answer very tall.",
  component: ({ props }) => {
    const lines = props.lines ?? [];

    return (
      <div className="flex flex-col gap-2">
        <span className="font-medium text-sm">{props.title}</span>
        <ScrollArea className="h-40 rounded-(--radius-control) border">
          <div className="flex flex-col gap-1.5 p-3">
            {lines.map((line, index) => (
              <p className="text-sm" key={index}>
                {line}
              </p>
            ))}
          </div>
        </ScrollArea>
      </div>
    );
  },
});
