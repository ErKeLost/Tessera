"use client";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

import { MessageBlock } from "./message-block";

const MessageScrollerBlockSchema = z.object({
  messages: z.array(MessageBlock.ref),
  height: z.number().optional(),
});

export const MessageScrollerBlock = defineComponent({
  name: "MessageScrollerBlock",
  props: MessageScrollerBlockSchema,
  description:
    'Fixed-height scroll panel holding a longer MessageBlock thread. messages: MessageBlock references in reading order. height: panel height in rem (default 20). Use it instead of a bare list of MessageBlocks once a quoted thread is longer than a few messages.',
  component: ({ props, renderNode }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (props.messages ?? []) as any[];

    return (
      <MessageScrollerProvider>
        <MessageScroller
          className="rounded-(--radius-card) border"
          style={{ height: `${props.height ?? 20}rem` }}
        >
          <MessageScrollerViewport className="p-4">
            <MessageScrollerContent className="gap-4">
              {messages.map((message, index) => (
                <MessageScrollerItem key={index}>{renderNode([message])}</MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    );
  },
});
