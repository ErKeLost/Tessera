"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { defineComponent, useIsStreaming } from "@openuidev/react-lang";
import { ChevronDown } from "lucide-react";
import { z } from "zod";

const CollapsibleBlockSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export const CollapsibleBlock = defineComponent({
  name: "CollapsibleBlock",
  props: CollapsibleBlockSchema,
  description:
    "Single section whose body starts hidden behind a toggle. title: the toggle label, body: the text revealed when expanded. Use it for one optional explanation; use Accordion when there are several sections.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();

    return (
      <Collapsible className="rounded-(--radius-control) border px-3">
        <CollapsibleTrigger
          disabled={isStreaming}
          className="flex w-full items-center justify-between gap-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180"
        >
          {props.title}
          <ChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden pb-3 text-sm text-muted-foreground data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          {props.body}
        </CollapsibleContent>
      </Collapsible>
    );
  },
});
