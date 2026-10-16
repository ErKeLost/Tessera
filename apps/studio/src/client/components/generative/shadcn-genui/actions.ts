import { defineAction } from "@openuidev/react-lang";
import { z } from "zod";

/**
 * The custom action the model writes as `@CopyText("...")`. The same string is
 * the `type` the host receives on `onAction`, so the handler and the library
 * cannot drift.
 */
export const COPY_TEXT_ACTION = "CopyText";

/**
 * Copy text out of an answer — a generated SQL statement, an id, a JSON blob —
 * to the reader's clipboard. Unlike `@ToAssistant` it does not touch the chat,
 * so a copied query never starts another model turn.
 */
export const copyTextAction = defineAction({
  name: COPY_TEXT_ACTION,
  description:
    'Copy the given text to the clipboard. Use it on a button when the answer contains something the reader will reuse, such as a SQL statement, an id or a value, e.g. @CopyText("SELECT 1").',
  params: z.object({
    text: z.string(),
  }),
});

/** Every custom action the answer library exposes to the model. */
export const answerActions = [copyTextAction];
