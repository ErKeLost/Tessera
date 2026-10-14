"use client";

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const ItemBlockSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  meta: z.string().optional(),
});

export const ItemBlock = defineComponent({
  name: "ItemBlock",
  props: ItemBlockSchema,
  description:
    "Card-like list row with a title, optional description, and optional meta text on the right.",
  component: ({ props }) => (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{props.title}</ItemTitle>
        {props.description && <ItemDescription>{props.description}</ItemDescription>}
      </ItemContent>
      {props.meta && (
        <ItemActions>
          <span className="text-sm text-muted-foreground">{props.meta}</span>
        </ItemActions>
      )}
    </Item>
  ),
});
