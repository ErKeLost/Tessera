"use client";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const MessageBlockSchema = z.object({
  author: z.string(),
  text: z.string(),
  align: z.enum(["start", "end"]).optional(),
  meta: z.string().optional(),
  variant: z
    .enum(["default", "secondary", "muted", "tinted", "outline", "ghost", "destructive"])
    .optional(),
});

/** First letters of an author name, for the avatar fallback. */
function initialsOf(author: string): string {
  return author
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export const MessageBlock = defineComponent({
  name: "MessageBlock",
  props: MessageBlockSchema,
  description:
    'One full chat message row: avatar, author header, bubble body and an optional footer. Use it to quote a conversation or a support thread inside the answer. align: "start" (the other side) | "end" (the reader). meta: small footer text such as a timestamp. variant: the bubble style, same values as BubbleBlock.',
  component: ({ props }) => {
    const align = props.align ?? "start";

    return (
      <Message align={align}>
        <MessageAvatar className="size-8 text-xs font-medium">{initialsOf(props.author)}</MessageAvatar>
        <MessageContent>
          <MessageHeader>{props.author}</MessageHeader>
          <Bubble variant={props.variant ?? "secondary"} align={align}>
            <BubbleContent>{props.text}</BubbleContent>
          </Bubble>
          {props.meta && <MessageFooter>{props.meta}</MessageFooter>}
        </MessageContent>
      </Message>
    );
  },
});
