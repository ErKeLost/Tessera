import { describe, expect, test } from "bun:test";
import { Renderer } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { shadcnChatLibrary } from "./index";

function render(program: string) {
  return renderToStaticMarkup(<Renderer library={shadcnChatLibrary} response={program} />);
}

describe("answer actions", () => {
  const spec = shadcnChatLibrary.toSpec() as unknown as {
    actions?: Record<string, { signature: string }>;
    functions?: Record<string, { signature: string }>;
    components: Record<string, { signature: string }>;
  };

  test("registers CopyText and the computed-value functions in the contract", () => {
    expect(spec.actions?.CopyText?.signature).toBe("CopyText(text: string)");
    expect(spec.functions?.Percent?.signature).toBe("Percent(part: number, total: number) → string");
    expect(spec.functions?.Delta).toBeDefined();
    expect(spec.functions?.FormatNumber).toBeDefined();
  });

  test("types the Button action prop as an ActionExpression", () => {
    expect(spec.components.Button?.signature).toContain("action?: ActionExpression");
  });

  test("renders a button whose action is a bare @ToAssistant step", () => {
    const html = render(
      'root = Card([btns])\nbtns = Buttons([b])\nb = Button("Ask", @ToAssistant("Tell me more"))',
    );

    expect(html).toContain("<button");
    expect(html).toContain("Ask");
  });

  test("renders a button whose action is a custom @CopyText step", () => {
    const html = render(
      [
        "root = Card([btns])",
        "btns = Buttons([b])",
        'b = Button("Copy SQL", @CopyText("SELECT region FROM orders"), "outline")',
      ].join("\n"),
    );

    expect(html).toContain("<button");
    expect(html).toContain("Copy SQL");
  });

  test("renders a multi-step Action plan", () => {
    const html = render(
      [
        "root = Card([btns])",
        "btns = Buttons([b])",
        'b = Button("Save", Action([@Set($saved, true), @ToAssistant("Saved")]))',
      ].join("\n"),
    );

    expect(html).toContain("Save");
  });
});
