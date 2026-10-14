/**
 * The chat-shaped nodes: a status marker line, a file/artifact card, the two
 * message containers (bubble and full message row), the scroller that holds a
 * longer thread, and the clarifying questionnaire.
 *
 * Re-exported from one place so `index.tsx` registers a group instead of six
 * import lines, and so the group can grow without touching the registry.
 */
export { AttachmentBlock } from "../components/attachment-block";
export { BubbleBlock } from "../components/bubble-block";
export { MarkerBlock } from "../components/marker-block";
export { MessageBlock } from "../components/message-block";
export { MessageScrollerBlock } from "../components/message-scroller-block";
export { QuestionnaireBlock } from "../components/questionnaire-block";

import type { ComponentGroup } from "@openuidev/react-lang";

import { AttachmentBlock } from "../components/attachment-block";
import { BubbleBlock } from "../components/bubble-block";
import { MarkerBlock } from "../components/marker-block";
import { MessageBlock } from "../components/message-block";
import { MessageScrollerBlock } from "../components/message-scroller-block";
import { QuestionnaireBlock } from "../components/questionnaire-block";

/** Every component defined by this group, ready to spread into `createLibrary`. */
export const chatComponents = [
  MarkerBlock,
  AttachmentBlock,
  BubbleBlock,
  MessageBlock,
  MessageScrollerBlock,
  QuestionnaireBlock,
] as const;

export const chatComponentGroup: ComponentGroup = {
  name: "Chat & Status",
  components: [
    "MarkerBlock",
    "AttachmentBlock",
    "BubbleBlock",
    "MessageBlock",
    "MessageScrollerBlock",
    "QuestionnaireBlock",
  ],
  notes: [
    "- MarkerBlock is one status line: use it for progress notes, timestamps and section dividers instead of writing separators by hand.",
    "- AttachmentBlock names a file or artifact the answer refers to; it is a label, not a download.",
    "- BubbleBlock and MessageBlock quote a conversation. MessageBlock adds an avatar, an author header and a footer to BubbleBlock; MessageScrollerBlock wraps a long thread in a scroll panel.",
    "- QuestionnaireBlock asks the reader to choose before the Agent continues.",
    "- These nodes carry text only — never put charts, tables or forms inside a bubble.",
  ],
};

export const chatExamples: string[] = [
  `Example — Status lines and an artifact:
root = Card([header, started, finished, divider, file])
header = CardHeader("Refresh report", "Rebuilt the semantic layer")
started = MarkerBlock("Read 12 tables from the catalog", "default", "database")
finished = MarkerBlock("Verified all row counts", "default", "success")
divider = MarkerBlock("Latest run", "separator")
file = AttachmentBlock("monthly_revenue.csv", "184 KB · generated just now", "sheet", "done")`,

  `Example — Support thread quote:
root = Card([header, first, second, followUps])
header = CardHeader("Why were 3 rows dropped?", "A short thread from the support inbox")
first = MessageBlock("Ada", "Three rows were excluded because their join key was empty.", "start", "10:24")
second = MessageBlock("Lin", "Can we keep them in a separate bucket?", "end", "10:31")
followUps = FollowUpBlock([FollowUpItem("Show me the excluded rows"), FollowUpItem("Explain the join")])`,

  `Example — Bubble variants:
root = Card([title, b1, b2, b3])
title = TextContent("Callouts", "large-heavy")
b1 = BubbleBlock("Revenue is up 12% quarter over quarter.", "tinted", "start")
b2 = BubbleBlock("Exclude the sandbox account.", "outline", "end")
b3 = BubbleBlock("One table returned no rows.", "destructive", "start")`,

  `Example — Long thread in a scroller:
root = Card([header, thread])
header = CardHeader("Support thread", "Last 6 messages")
thread = MessageScrollerBlock([m1, m2, m3], 18)
m1 = MessageBlock("Ada", "Which tables feed the revenue metric?", "start", "10:02")
m2 = MessageBlock("Sam", "orders and refunds.", "end", "10:04")
m3 = MessageBlock("Ada", "Do refunds subtract from the total?", "start", "10:06")`,

  `Example — Clarifying question:
root = Card([header, q, followUps])
header = CardHeader("Revenue dropped 8%", "I need one detail before the breakdown")
q = QuestionnaireBlock("Which revenue definition do you want?", ["Gross bookings", "Net of refunds", "Recognised revenue"], "Each one changes the trend line.")
followUps = FollowUpBlock([FollowUpItem("Explain the difference"), FollowUpItem("Show all three")])`,
];

export const chatRules: string[] = [
  "MarkerBlock is a status line, not a section header — keep it to one short sentence.",
  'Use MarkerBlock with variant "separator" to break an answer into stages, and variant "border" for a labelled block underneath.',
  'MarkerBlock icon vocabulary is fixed: "info" | "success" | "warning" | "error" | "loading" | "file" | "calendar" | "user" | "database" | "clock".',
  'Use AttachmentBlock to name a file or artifact (kind: "file" | "image" | "table" | "code" | "sheet"); it renders a label only, so never promise a download.',
  "Use BubbleBlock for a single quoted line and MessageBlock when the quote needs an author and a timestamp.",
  "Use MessageScrollerBlock once a quoted thread is longer than a few messages — keep it to five to eight visible messages and give it a height in rem.",
  "Use QuestionnaireBlock only when a small set of choices resolves a genuine ambiguity; pressing Submit sends the chosen text as the next user message.",
  'Bubble/Message align uses "start" for the other side and "end" for the reader; align all messages of the same thread consistently.',
  "Never nest tables, charts, forms or other blocks inside BubbleBlock or MessageBlock.",
];
