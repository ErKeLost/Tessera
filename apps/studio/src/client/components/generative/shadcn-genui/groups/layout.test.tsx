import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createLibrary, Renderer } from "@openuidev/react-lang";
import { generateSystemPrompt } from "@openuidev/lang-core";

import { AspectRatioBlock } from "../components/aspect-ratio-block";
import { BreadcrumbBlock } from "../components/breadcrumb-block";
import { ContextMenuBlock } from "../components/context-menu-block";
import { MenubarBlock } from "../components/menubar-block";
import { NavigationMenuBlock } from "../components/navigation-menu-block";
import { ResizableBlock } from "../components/resizable-block";
import { ScrollAreaBlock } from "../components/scroll-area-block";
import { SheetBlock } from "../components/sheet-block";
import { SidebarBlock } from "../components/sidebar-block";

const nodes = [
  AspectRatioBlock,
  BreadcrumbBlock,
  ContextMenuBlock,
  MenubarBlock,
  NavigationMenuBlock,
  ResizableBlock,
  ScrollAreaBlock,
  SheetBlock,
  SidebarBlock,
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

describe("layout nodes", () => {
  test("SheetBlock renders its trigger", () => {
    const html = renderWithRoot(
      "SheetBlock",
      ['root = SheetBlock("Open details", "Method", "Full method text")'].join("\n"),
    );
    expect(html).toContain("Open details");
  });

  test("BreadcrumbBlock renders the trail and marks the last step current", () => {
    const html = renderWithRoot(
      "BreadcrumbBlock",
      ['root = BreadcrumbBlock(["Home", "Reports", "Q3 revenue"])'].join("\n"),
    );
    expect(html).toContain('aria-label="breadcrumb"');
    expect(html).toContain("Home");
    expect(html).toContain("Reports");
    expect(html).toContain('data-slot="breadcrumb-page"');
    expect(html).toContain("Q3 revenue");
  });

  test("NavigationMenuBlock renders its menu label", () => {
    const html = renderWithRoot(
      "NavigationMenuBlock",
      ['root = NavigationMenuBlock("Destinations", ["Overview", "Settings"])'].join("\n"),
    );
    expect(html).toContain("Destinations");
  });

  test("MenubarBlock renders every menu label", () => {
    const html = renderWithRoot(
      "MenubarBlock",
      ['root = MenubarBlock(["File", "Edit"], ["Export CSV", "Archive"])'].join("\n"),
    );
    expect(html).toContain("File");
    expect(html).toContain("Edit");
  });

  test("ResizableBlock renders each panel body", () => {
    const html = renderWithRoot(
      "ResizableBlock",
      ['root = ResizableBlock(["Before", "After"], "horizontal")'].join("\n"),
    );
    expect(html).toContain('data-slot="resizable-panel-group"');
    expect(html).toContain("Before");
    expect(html).toContain("After");
  });

  test("ResizableBlock defaults to a horizontal split and honours a vertical one", () => {
    // react-resizable-panels v4 expresses the orientation of the group as its
    // flex direction, so this also proves `direction` reaches the primitive.
    const horizontal = renderWithRoot(
      "ResizableBlock",
      ['root = ResizableBlock(["Alpha", "Beta"])'].join("\n"),
    );
    expect(horizontal).toContain("flex-direction:row");

    const vertical = renderWithRoot(
      "ResizableBlock",
      ['root = ResizableBlock(["Alpha", "Beta"], "vertical")'].join("\n"),
    );
    expect(vertical).toContain("flex-direction:column");
  });

  test("ScrollAreaBlock renders its title and lines", () => {
    const html = renderWithRoot(
      "ScrollAreaBlock",
      ['root = ScrollAreaBlock("Run log", ["step one", "step two"])'].join("\n"),
    );
    expect(html).toContain("Run log");
    expect(html).toContain('data-slot="scroll-area"');
    expect(html).toContain("step one");
    expect(html).toContain("step two");
  });

  test("AspectRatioBlock renders its text inside a fixed-ratio box", () => {
    const html = renderWithRoot(
      "AspectRatioBlock",
      ['root = AspectRatioBlock("No preview available")'].join("\n"),
    );
    expect(html).toContain('data-slot="aspect-ratio"');
    expect(html).toContain("No preview available");
  });

  test("SidebarBlock renders its title, section labels and entries", () => {
    const html = renderWithRoot(
      "SidebarBlock",
      [
        'root = SidebarBlock("Workspace", ["Reports", "Settings"], ["Revenue", "Churn", "Profile"])',
      ].join("\n"),
    );
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain("Workspace");
    expect(html).toContain("Reports");
    expect(html).toContain("Settings");
    expect(html).toContain("Revenue");
    expect(html).toContain("Profile");
  });

  test("SidebarBlock gives each section its own contiguous run of entries", () => {
    const html = renderWithRoot(
      "SidebarBlock",
      ['root = SidebarBlock("Workspace", ["First", "Second"], ["A", "B", "C", "D"])'].join("\n"),
    );
    // Two labels over four entries split 2 / 2 rather than repeating all four.
    const occurrences = (needle: string) => html.split(needle).length - 1;
    expect(occurrences(">A<")).toBe(1);
    expect(occurrences(">D<")).toBe(1);
  });

  test("ContextMenuBlock renders its right-click hint", () => {
    const html = renderWithRoot(
      "ContextMenuBlock",
      ['root = ContextMenuBlock("Right-click the report", ["Archive", "Delete"])'].join("\n"),
    );
    expect(html).toContain("Right-click the report");
  });

  test("compiles every node signature into the model contract", () => {
    const library = createLibrary({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root: "SheetBlock" as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: nodes as any,
    });
    const prompt = generateSystemPrompt({ library: library.toSpec() });

    for (const signature of [
      "SheetBlock(trigger: string, title: string, body: string, side?: \"top\" | \"bottom\" | \"left\" | \"right\")",
      "BreadcrumbBlock(items: string[])",
      "NavigationMenuBlock(trigger: string, items: string[])",
      "MenubarBlock(menus: string[], items: string[])",
      "ResizableBlock(panels: string[], direction?: \"horizontal\" | \"vertical\")",
      "ScrollAreaBlock(title: string, lines: string[])",
      "AspectRatioBlock(text: string, ratio?: number)",
      "SidebarBlock(title: string, sections: string[], items: string[])",
      "ContextMenuBlock(trigger: string, items: string[])",
    ]) {
      expect(prompt).toContain(signature);
    }
  });

  test("unknown node is dropped", () => {
    const html = renderWithRoot(
      "ScrollAreaBlock",
      ['root = ScrollAreaBlock("Kept", ["line"])', 'nope = MadeUpNode("Leaked")'].join("\n"),
    );
    expect(html).toContain("Kept");
    expect(html).not.toContain("Leaked");
  });
});
