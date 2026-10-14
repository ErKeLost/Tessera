import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer, createLibrary } from "@openuidev/react-lang";
import { generateSystemPrompt } from "@openuidev/lang-core";

import { CommandBlock } from "../components/command-block";
import { CommandDialogBlock } from "../components/command-dialog-block";
import { Combobox } from "../components/combobox";
import { NativeSelect } from "../components/native-select";
import { PopoverBlock } from "../components/popover-block";
import { DropdownMenuBlock } from "../components/dropdown-menu-block";
import { TooltipBlock } from "../components/tooltip-block";
import { HoverCardBlock } from "../components/hover-card-block";
import { CollapsibleBlock } from "../components/collapsible-block";

const nodes = [
  CommandBlock,
  CommandDialogBlock,
  Combobox,
  NativeSelect,
  PopoverBlock,
  DropdownMenuBlock,
  TooltipBlock,
  HoverCardBlock,
  CollapsibleBlock,
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

describe("selection nodes", () => {
  test("CommandBlock renders items", () => {
    const html = renderWithRoot(
      "CommandBlock",
      ['root = CommandBlock("Commands", ["Run report", "Export CSV"])'].join("\n"),
    );
    expect(html).toContain("Run report");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Commands");
  });

  test("CommandDialogBlock renders its trigger", () => {
    const html = renderWithRoot(
      "CommandDialogBlock",
      ['root = CommandDialogBlock("Open palette", "Commands", ["Run report"])'].join("\n"),
    );
    expect(html).toContain("Open palette");
  });

  test("Combobox renders label and placeholder", () => {
    const html = renderWithRoot(
      "Combobox",
      ['root = Combobox("Region", ["AMER", "EMEA"], "Pick a region")'].join("\n"),
    );
    expect(html).toContain("Region");
    expect(html).toContain("Pick a region");
  });

  test("NativeSelect renders options", () => {
    const html = renderWithRoot(
      "NativeSelect",
      ['root = NativeSelect("Region", ["AMER", "EMEA"], "Pick a region")'].join("\n"),
    );
    expect(html).toContain("<select");
    expect(html).toContain("AMER");
    expect(html).toContain("EMEA");
  });

  test("PopoverBlock renders trigger", () => {
    const html = renderWithRoot(
      "PopoverBlock",
      ['root = PopoverBlock("Details", "More", "Body text")'].join("\n"),
    );
    expect(html).toContain("Details");
  });

  test("DropdownMenuBlock renders trigger", () => {
    const html = renderWithRoot(
      "DropdownMenuBlock",
      ['root = DropdownMenuBlock("Actions", ["Archive", "Delete"])'].join("\n"),
    );
    expect(html).toContain("Actions");
  });

  test("TooltipBlock renders term", () => {
    const html = renderWithRoot(
      "TooltipBlock",
      ['root = TooltipBlock("ARR", "Annual recurring revenue")'].join("\n"),
    );
    expect(html).toContain("ARR");
  });

  test("HoverCardBlock renders trigger", () => {
    const html = renderWithRoot(
      "HoverCardBlock",
      ['root = HoverCardBlock("ARR", "Annual recurring revenue", "Yearly value")'].join("\n"),
    );
    expect(html).toContain("ARR");
  });

  test("CollapsibleBlock renders title", () => {
    const html = renderWithRoot(
      "CollapsibleBlock",
      ['root = CollapsibleBlock("Method", "Body text")'].join("\n"),
    );
    expect(html).toContain("Method");
  });

  test("compiles every node signature into the model contract", () => {
    const library = createLibrary({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: "CommandBlock" as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: nodes as any,
    });
    const prompt = generateSystemPrompt({ library: library.toSpec() });

    for (const signature of [
      'CommandBlock(title?: string, items: string[])',
      'CommandDialogBlock(trigger: string, title?: string, items: string[])',
      'Combobox(label: string, options: string[], placeholder?: string)',
      'NativeSelect(label: string, options: string[], placeholder?: string)',
      'PopoverBlock(trigger: string, title?: string, body: string)',
      'DropdownMenuBlock(trigger: string, items: string[])',
      'TooltipBlock(text: string, hint: string)',
      'HoverCardBlock(trigger: string, title: string, body: string)',
      'CollapsibleBlock(title: string, body: string)',
    ]) {
      expect(prompt).toContain(signature);
    }
  });

  test("unknown node is dropped", () => {
    const html = renderWithRoot(
      "CommandBlock",
      ['root = CommandBlock("Commands", ["Kept"])', 'nope = MadeUpNode("Leaked")'].join("\n"),
    );
    expect(html).toContain("Kept");
    expect(html).not.toContain("Leaked");
  });
});
