"use client";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { defineComponent } from "@openuidev/react-lang";
import { Fragment } from "react";
import { z } from "zod";

const ResizableBlockSchema = z.object({
  panels: z.array(z.string()),
  direction: z.enum(["horizontal", "vertical"]).optional(),
});

export const ResizableBlock = defineComponent({
  name: "ResizableBlock",
  props: ResizableBlockSchema,
  description:
    "Two or more text panes the reader can drag apart, for reading two pieces of writing in parallel. panels: one text per pane, direction: whether the panes sit side by side or stacked. Use it instead of a table when the items are paragraphs rather than values.",
  component: ({ props }) => {
    const panels = props.panels ?? [];

    return (
      <ResizablePanelGroup
        orientation={props.direction ?? "horizontal"}
        className="h-48 rounded-(--radius-control) border"
      >
        {panels.map((panel, index) => (
          <Fragment key={index}>
            {index > 0 && <ResizableHandle withHandle />}
            <ResizablePanel>
              <div className="h-full overflow-auto p-3 text-sm">{panel}</div>
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    );
  },
});
