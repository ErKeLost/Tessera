import { describe, expect, test } from "bun:test";
import { Renderer, createLibrary, defineComponent } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { z } from "zod";

import { feedbackComponents } from "./feedback";

const TestRoot = defineComponent({
  name: "TestRoot",
  props: z.object({
    children: z.array(
      z.union([
        feedbackComponents[0].ref,
        feedbackComponents[1].ref,
        feedbackComponents[2].ref,
        feedbackComponents[3].ref,
        feedbackComponents[4].ref,
        feedbackComponents[5].ref,
        feedbackComponents[6].ref,
        feedbackComponents[7].ref,
        feedbackComponents[8].ref,
        feedbackComponents[9].ref,
        feedbackComponents[10].ref,
      ]),
    ),
  }),
  description: "Test-only root that renders its children.",
  component: ({ props, renderNode }) => <div>{renderNode(props.children)}</div>,
});

const testLibrary = createLibrary({
  root: "TestRoot",
  componentGroups: [{ name: "Feedback", components: feedbackComponents.map((c) => c.name) }],
  components: [TestRoot, ...feedbackComponents],
});

function render(program: string) {
  return renderToStaticMarkup(<Renderer library={testLibrary} response={program} />);
}

const PROGRAM = [
  "root = TestRoot([skeleton, spinner, toggle, toggleGroup, otp, kbd, empty, item, group, buttons, toast])",
  "skeleton = SkeletonBlock(3)",
  'spinner = SpinnerBlock("Loading rows")',
  'toggle = ToggleBlock("Pin report", true, "outline")',
  'toggleGroup = ToggleGroupBlock(["Daily", "Weekly"], "outline", "sm")',
  'otp = OtpInput("Verification code", 6)',
  'kbd = Kbd(["⌘", "K"])',
  'empty = EmptyBlock("No reports yet", "Generate one to get started.")',
  'item = ItemBlock("Ada Lovelace", "Owner", "Active")',
  'group = InputGroup("Budget", "$", "USD", "0.00")',
  'buttons = ButtonGroupBlock(["Run again", "Explain"], "row")',
  'toast = ToastBlock("Queued", "We will notify you.", "Notify me", "success")',
].join("\n");

describe("feedback component group", () => {
  test("renders every node with its shadcn primitive", () => {
    const html = render(PROGRAM);

    // SkeletonBlock
    expect(html).toContain('data-slot="skeleton"');
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(3);

    // SpinnerBlock
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain("Loading rows");

    // ToggleBlock
    expect(html).toContain('data-slot="toggle"');
    expect(html).toContain("Pin report");

    // ToggleGroupBlock
    expect(html).toContain('data-slot="toggle-group"');
    expect(html).toContain("Daily");
    expect(html).toContain("Weekly");

    // OtpInput
    expect(html).toContain('data-slot="input-otp"');
    expect(html.match(/data-slot="input-otp-slot"/g)).toHaveLength(6);

    // Kbd
    expect(html).toContain('data-slot="kbd"');
    expect(html).toContain("⌘");
    expect(html).toContain("K");

    // EmptyBlock
    expect(html).toContain('data-slot="empty"');
    expect(html).toContain("No reports yet");
    expect(html).toContain("Generate one to get started.");

    // ItemBlock
    expect(html).toContain('data-slot="item"');
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Active");

    // InputGroup
    expect(html).toContain('data-slot="input-group"');
    expect(html).toContain("Budget");
    expect(html).toContain("USD");

    // ButtonGroupBlock
    expect(html).toContain('data-slot="button-group"');
    expect(html).toContain("Run again");
    expect(html).toContain("Explain");

    // ToastBlock renders a trigger button, never fires on its own
    expect(html).toContain("Notify me");
  });

  test("caps SkeletonBlock at 12 bars and OtpInput at 8 slots", () => {
    const html = render(
      [
        "root = TestRoot([skeleton, otp])",
        "skeleton = SkeletonBlock(99)",
        "otp = OtpInput(\"Code\", 99)",
      ].join("\n"),
    );

    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(12);
    expect(html.match(/data-slot="input-otp-slot"/g)).toHaveLength(8);
  });

  test("drops empty collections instead of rendering bare containers", () => {
    const html = render(
      [
        "root = TestRoot([kbd, buttons, toggleGroup])",
        "kbd = Kbd([])",
        "buttons = ButtonGroupBlock([])",
        'toggleGroup = ToggleGroupBlock([])',
      ].join("\n"),
    );

    expect(html).not.toContain('data-slot="kbd"');
    expect(html).not.toContain('data-slot="button-group"');
    expect(html).not.toContain('data-slot="toggle-group"');
  });
});
