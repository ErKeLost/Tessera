"use client";

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { defineComponent, useIsStreaming, useTriggerAction } from "@openuidev/react-lang";
import { z } from "zod";

const NavigationMenuBlockSchema = z.object({
  trigger: z.string(),
  items: z.array(z.string()),
});

export const NavigationMenuBlock = defineComponent({
  name: "NavigationMenuBlock",
  props: NavigationMenuBlockSchema,
  description:
    "Top navigation bar with one menu that drops down a list of destinations. trigger: the menu label, items: the destinations. Selecting one sends its text to the assistant. Use it when the answer lists a short set of places to go.",
  component: ({ props }) => {
    const isStreaming = useIsStreaming();
    const triggerAction = useTriggerAction();
    const items = props.items ?? [];

    return (
      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger disabled={isStreaming}>{props.trigger}</NavigationMenuTrigger>
            <NavigationMenuContent>
              <ul className="grid w-56 gap-1">
                {items.map((item, index) => (
                  <NavigationMenuItem key={index}>
                    <NavigationMenuLink asChild>
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() => void triggerAction(item)}
                        className="w-full text-left outline-none disabled:pointer-events-none disabled:opacity-50"
                      >
                        {item}
                      </button>
                    </NavigationMenuLink>
                  </NavigationMenuItem>
                ))}
              </ul>
            </NavigationMenuContent>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
    );
  },
});
