import { describe, expect, test } from "bun:test";
import { generateSystemPrompt } from "@openuidev/lang-core";
import { Renderer, createLibrary } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";

import { AttachmentBlock } from "../components/attachment-block";
import { BubbleBlock } from "../components/bubble-block";
import { MarkerBlock } from "../components/marker-block";
import { MessageBlock } from "../components/message-block";
import { MessageScrollerBlock } from "../components/message-scroller-block";
import { QuestionnaireBlock } from "../components/questionnaire-block";
import { chatComponents, chatExamples, chatRules } from "./chat";

const nodes = [
  MarkerBlock,
  AttachmentBlock,
  BubbleBlock,
  MessageBlock,
  MessageScrollerBlock,
  QuestionnaireBlock,
];

function renderWithRoot(root: string, program: string) {
  const library = createLibrary({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root: root as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    components: nodes as any,
  });
  return renderToStaticMarkup(<Renderer library={library} response={program} />);
}

describe("chat nodes", () => {
  test("MarkerBlock renders its text and the chosen variant", () => {
    const html = renderWithRoot("MarkerBlock", 'root = MarkerBlock("Loaded 12 tables", "border", "database")');
    expect(html).toContain("Loaded 12 tables");
    expect(html).toContain('data-slot="marker"');
    expect(html).toContain('data-variant="border"');
    expect(html).toContain('data-slot="marker-icon"');
  });

  test("MarkerBlock renders without an icon", () => {
    const html = renderWithRoot("MarkerBlock", 'root = MarkerBlock("Latest run", "separator")');
    expect(html).toContain("Latest run");
    expect(html).toContain('data-variant="separator"');
    expect(html).not.toContain('data-slot="marker-icon"');
  });

  test("AttachmentBlock renders the file name, detail and state", () => {
    const html = renderWithRoot(
      "AttachmentBlock",
      'root = AttachmentBlock("monthly_revenue.csv", "184 KB", "sheet", "processing")',
    );
    expect(html).toContain('data-slot="attachment"');
    expect(html).toContain('data-state="processing"');
    expect(html).toContain("monthly_revenue.csv");
    expect(html).toContain("184 KB");
  });

  test("BubbleBlock renders its text with the requested variant and alignment", () => {
    const html = renderWithRoot("BubbleBlock", 'root = BubbleBlock("Exclude the sandbox.", "outline", "end")');
    expect(html).toContain('data-slot="bubble"');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-align="end"');
    expect(html).toContain("Exclude the sandbox.");
  });

  test("MessageBlock renders the avatar initials, header, body and footer", () => {
    const html = renderWithRoot(
      "MessageBlock",
      'root = MessageBlock("Ada Lovelace", "Three rows were dropped.", "start", "10:24")',
    );
    expect(html).toContain('data-slot="message"');
    expect(html).toContain('data-slot="message-avatar"');
    expect(html).toContain("AL");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Three rows were dropped.");
    expect(html).toContain("10:24");
  });
  test("MessageScrollerBlock renders a scroll panel around the thread", () => {
    const html = renderWithRoot(
      "MessageScrollerBlock",
      [
        "root = MessageScrollerBlock([m1, m2], 18)",
        'm1 = MessageBlock("Ada", "Which tables feed this?", "start", "10:02")',
        'm2 = MessageBlock("Sam", "orders and refunds.", "end", "10:04")',
      ].join("\n"),
    );

    expect(html).toContain('data-slot="message-scroller"');
    expect(html).toContain('data-slot="message-scroller-viewport"');
    expect(html).toContain("Which tables feed this?");
    expect(html).toContain("orders and refunds.");
    expect(html).toContain("height:18rem");
  });

  test("QuestionnaireBlock renders the question with its choices", () => {
    const html = renderWithRoot(
      "QuestionnaireBlock",
      'root = QuestionnaireBlock("Which revenue definition?", ["Gross", "Net"], "Each changes the trend.")',
    );

    expect(html).toContain('data-slot="questionnaire"');
    expect(html).toContain("Which revenue definition?");
    expect(html).toContain("Each changes the trend.");
    expect(html).toContain("Gross");
    expect(html).toContain("Net");
    expect(html).toContain("Submit");
  });
});

describe("chat group", () => {
  test("teaches every node and its rules to the model", () => {
    const prompt = generateSystemPrompt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      library: createLibrary({ root: "MarkerBlock" as any, components: nodes as any }).toSpec(),
      promptOptions: { examples: chatExamples, additionalRules: chatRules },
    });

    expect(chatComponents).toHaveLength(6);
    for (const node of chatComponents) expect(prompt).toContain(node.name);
    expect(prompt).toContain("MarkerBlock(text");
    expect(prompt).toContain("AttachmentBlock(name");
    expect(prompt).toContain("MessageBlock(author");
  });
});
