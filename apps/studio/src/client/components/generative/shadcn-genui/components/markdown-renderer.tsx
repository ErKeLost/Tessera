"use client";

import { defineComponent } from "@openuidev/react-lang";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

const MarkDownRendererSchema = z.object({
  text: z.string(),
});

/** The Markdown surface a prose answer falls back to, shared with the library. */
export function MarkdownRenderer({ text }: { text: string }) {
  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

export const MarkDownRenderer = defineComponent({
  name: "MarkDownRenderer",
  props: MarkDownRendererSchema,
  description: "Renders markdown text with GFM support.",
  component: ({ props }) => {
    const text = props.text == null ? "" : String(props.text);
    return <MarkdownRenderer text={text} />;
  },
});
