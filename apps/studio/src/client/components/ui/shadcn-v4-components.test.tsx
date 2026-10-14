import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Attachment, AttachmentContent, AttachmentMedia, AttachmentTitle } from "./attachment";
import { Bubble, BubbleContent } from "./bubble";
import { Combobox, ComboboxInput } from "./combobox";
import { DirectionProvider } from "./direction";
import { Marker, MarkerContent, MarkerIcon } from "./marker";
import { Message, MessageContent, MessageHeader } from "./message";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./message-scroller";
import {
  Questionnaire,
  QuestionnaireChoices,
  QuestionnaireItem,
  QuestionnaireProgress,
  QuestionnaireTitle,
} from "./questionnaire";
import { Toaster, toast } from "./toast";

describe("the components the Studio ported from the newer shadcn registry", () => {
  test("marker renders its variants and icon slot", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Marker,
        { variant: "separator" },
        createElement(MarkerIcon, null, createElement("svg")),
        createElement(MarkerContent, null, "Latest run"),
      ),
    );

    expect(markup).toContain('data-slot="marker"');
    expect(markup).toContain('data-variant="separator"');
    expect(markup).toContain("Latest run");
  });

  test("message renders its header inside the message container", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Message,
        { align: "end" },
        createElement(MessageContent, null, createElement(MessageHeader, null, "Ada")),
      ),
    );

    expect(markup).toContain('data-slot="message"');
    expect(markup).toContain('data-align="end"');
    expect(markup).toContain("Ada");
  });

  test("bubble renders its variant and alignment", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Bubble,
        { variant: "outline", align: "end" },
        createElement(BubbleContent, null, "Exclude the sandbox."),
      ),
    );

    expect(markup).toContain('data-slot="bubble"');
    expect(markup).toContain('data-variant="outline"');
    expect(markup).toContain("Exclude the sandbox.");
  });

  test("attachment renders its state on the card, not on the media", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Attachment,
        { state: "processing" },
        createElement(AttachmentMedia, null, createElement("svg")),
        createElement(AttachmentContent, null, createElement(AttachmentTitle, null, "revenue.csv")),
      ),
    );

    expect(markup).toContain('data-state="processing"');
    expect(markup).toContain("revenue.csv");
  });

  test("message scroller renders its viewport and items", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MessageScrollerProvider,
        null,
        createElement(
          MessageScroller,
          null,
          createElement(
            MessageScrollerViewport,
            null,
            createElement(
              MessageScrollerContent,
              null,
              createElement(MessageScrollerItem, null, "first"),
            ),
          ),
        ),
      ),
    );

    expect(markup).toContain('data-slot="message-scroller"');
    expect(markup).toContain('data-slot="message-scroller-viewport"');
    expect(markup).toContain("first");
  });

  test("questionnaire renders one item with its choices", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Questionnaire,
        { items: [{ choices: [{ value: "daily" }], name: "grain" }] },
        createElement(QuestionnaireProgress, null),
        createElement(
          QuestionnaireItem,
          { name: "grain" },
          createElement(QuestionnaireTitle, null, "Which grain?"),
          createElement(QuestionnaireChoices, null),
        ),
      ),
    );

    expect(markup).toContain('data-slot="questionnaire"');
    expect(markup).toContain('data-slot="questionnaire-item"');
    expect(markup).toContain("Which grain?");
  });

  test("toast renders a mountable toaster and shares one manager", () => {
    // The viewport lives in a portal, so the server markup is empty: what
    // matters is that the manager is shared and the mount does not throw.
    const markup = renderToStaticMarkup(createElement(Toaster));

    expect(typeof toast.add).toBe("function");
    expect(typeof toast.close).toBe("function");
    expect(markup).toBe("");
  });

  test("combobox renders a combobox input", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Combobox,
        { items: ["AMER", "EMEA"] },
        createElement(ComboboxInput, { placeholder: "Pick a region" }),
      ),
    );

    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('placeholder="Pick a region"');
  });

  test("direction provider renders its children", () => {
    const markup = renderToStaticMarkup(
      createElement(DirectionProvider, { dir: "rtl" }, "content"),
    );

    expect(markup).toContain("content");
  });
});
