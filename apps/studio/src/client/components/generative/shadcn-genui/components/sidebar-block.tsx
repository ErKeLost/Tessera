"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { useState } from "react";
import { z } from "zod";

const SidebarBlockSchema = z.object({
  title: z.string(),
  sections: z.array(z.string()),
  items: z.array(z.string()),
});

/**
 * The node carries one flat list of entries but possibly several section
 * labels, so the entries are split into contiguous runs — one per label — to
 * give each label its own group instead of repeating the whole list under
 * every label. No labels means one unlabelled group.
 */
function groupItems(sections: string[], items: string[]) {
  if (sections.length === 0) return [{ label: "", items }];

  const perSection = Math.ceil(items.length / sections.length);

  return sections.map((label, index) => ({
    label,
    items: perSection === 0 ? [] : items.slice(index * perSection, (index + 1) * perSection),
  }));
}

export const SidebarBlock = defineComponent({
  name: "SidebarBlock",
  props: SidebarBlockSchema,
  description:
    "Collapsible panel of destinations down the side of the answer. title: the panel heading, sections: group labels, items: the destinations, split across the labels in order. Selecting a destination sends its text to the assistant.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const [open, setOpen] = useState(true);
    const sections = props.sections ?? [];
    const items = props.items ?? [];
    const groups = groupItems(sections, items);

    return (
      <SidebarProvider open={open} onOpenChange={setOpen} className="min-h-0 w-full">
        <div className="flex h-44 w-full overflow-hidden rounded-(--radius-control) border">
          <Sidebar
            collapsible="none"
            className={`h-full shrink-0 transition-[width] duration-200 ease-linear ${
              open ? "w-56" : "w-0 overflow-hidden"
            }`}
          >
            <SidebarHeader className="gap-1 p-2">
              <span className="truncate px-2 py-1 font-medium text-sm">{props.title}</span>
            </SidebarHeader>
            <SidebarContent className="gap-0">
              {groups.map((group, groupIndex) => (
                <SidebarGroup key={groupIndex} className="p-2">
                  {group.label !== "" && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item, index) => (
                        <SidebarMenuItem key={index}>
                          <SidebarMenuButton
                            type="button"
                            disabled={isStreaming}
                            onClick={() => void triggerAction(item)}
                          >
                            <span className="truncate">{item}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </SidebarContent>
          </Sidebar>
          <div className="flex h-full flex-1 flex-col items-start gap-2 p-3">
            <SidebarTrigger />
            <span className="text-muted-foreground text-xs">
              {items.length} {items.length === 1 ? "entry" : "entries"}
            </span>
          </div>
        </div>
      </SidebarProvider>
    );
  },
});
