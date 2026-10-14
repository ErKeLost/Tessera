"use client";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { defineComponent } from "@openuidev/react-lang";
import { Inbox } from "lucide-react";
import { z } from "zod";

const EmptyBlockSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
});

export const EmptyBlock = defineComponent({
  name: "EmptyBlock",
  props: EmptyBlockSchema,
  description: "Empty state with an icon, a title, and an optional description.",
  component: ({ props }) => (
    <Empty className="p-8">
      <EmptyMedia variant="icon">
        <Inbox />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description && <EmptyDescription>{props.description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  ),
});
