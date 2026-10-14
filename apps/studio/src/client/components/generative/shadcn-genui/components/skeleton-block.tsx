"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const SkeletonBlockSchema = z.object({
  lines: z.number().optional(),
});

const LINE_WIDTHS = ["w-full", "w-4/5", "w-3/5"] as const;

export const SkeletonBlock = defineComponent({
  name: "SkeletonBlock",
  props: SkeletonBlockSchema,
  description:
    "Skeleton placeholder bars that stand in for content that is still loading. lines: number of bars (default 3).",
  component: ({ props }) => {
    const requested = Number(props.lines ?? 3);
    const count = Number.isFinite(requested)
      ? Math.max(1, Math.min(12, Math.floor(requested)))
      : 3;

    return (
      <div className="space-y-2" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton key={index} className={cn("h-4", LINE_WIDTHS[index % LINE_WIDTHS.length])} />
        ))}
      </div>
    );
  },
});
