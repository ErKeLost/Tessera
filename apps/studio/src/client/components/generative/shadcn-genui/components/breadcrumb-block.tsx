"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { Fragment } from "react";
import { z } from "zod";

const BreadcrumbBlockSchema = z.object({
  items: z.array(z.string()),
});

export const BreadcrumbBlock = defineComponent({
  name: "BreadcrumbBlock",
  props: BreadcrumbBlockSchema,
  description:
    "Navigation trail running from the broadest step to the current one. items: the ordered steps, where the last entry is the current page and the earlier ones lead back to it. Selecting an earlier step sends its text to the assistant.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const items = props.items ?? [];

    return (
      <Breadcrumb>
        <BreadcrumbList>
          {items.map((item, index) => {
            const isCurrent = index === items.length - 1;
            return (
              <Fragment key={index}>
                <BreadcrumbItem>
                  {isCurrent ? (
                    <BreadcrumbPage>{item}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() => void triggerAction(item)}
                        className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                      >
                        {item}
                      </button>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isCurrent && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    );
  },
});
