import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";
import { Dialog, DialogClose } from "./dialog";

describe("DialogClose", () => {
  test("preserves the child button slot when composed with asChild", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true },
        createElement(
          DialogClose,
          { asChild: true },
          createElement(Button, { type: "button", variant: "outline" }, "Cancel"),
        ),
      ),
    );

    expect(markup).toContain('data-slot="button"');
    expect(markup).not.toContain('data-slot="dialog-close"');
  });
});
