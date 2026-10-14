"use client";

import { AspectRatio } from "@/components/ui/aspect-ratio";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const AspectRatioBlockSchema = z.object({
  text: z.string(),
  ratio: z.number().optional(),
});

export const AspectRatioBlock = defineComponent({
  name: "AspectRatioBlock",
  props: AspectRatioBlockSchema,
  description:
    "Box held to a fixed width-to-height ratio with centred text, for a placeholder or a caption panel. text: what the box says, ratio: width divided by height, defaulting to 16:9. Use it to reserve a stable area when no image is available.",
  component: ({ props }) => (
    <div className="overflow-hidden rounded-(--radius-control) border">
      <AspectRatio ratio={props.ratio ?? 16 / 9}>
        <div className="flex h-full w-full items-center justify-center bg-muted p-4">
          <span className="text-center text-muted-foreground text-sm">{props.text}</span>
        </div>
      </AspectRatio>
    </div>
  ),
});
