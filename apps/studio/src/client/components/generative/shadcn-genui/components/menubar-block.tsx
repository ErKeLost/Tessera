"use client";

import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const MenubarBlockSchema = z.object({
  menus: z.array(z.string()),
  items: z.array(z.string()),
});

export const MenubarBlock = defineComponent({
  name: "MenubarBlock",
  props: MenubarBlockSchema,
  description:
    "Horizontal menu bar of named commands. menus: the menu labels, items: the commands listed under each label. Selecting a command sends its text to the assistant. Use it when the answer offers several groups of actions.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const menus = props.menus ?? [];
    const items = props.items ?? [];

    return (
      <Menubar>
        {menus.map((menu, menuIndex) => (
          <MenubarMenu key={menuIndex}>
            <MenubarTrigger disabled={isStreaming}>{menu}</MenubarTrigger>
            <MenubarContent>
              {items.map((item, index) => (
                <MenubarItem
                  key={index}
                  disabled={isStreaming}
                  onSelect={() => void triggerAction(item)}
                >
                  {item}
                </MenubarItem>
              ))}
            </MenubarContent>
          </MenubarMenu>
        ))}
      </Menubar>
    );
  },
});
