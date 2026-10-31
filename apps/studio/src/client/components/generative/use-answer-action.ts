"use client";

import { useAui } from "@assistant-ui/react";
import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";
import { useCallback } from "react";
import { toast } from "sonner";
import { COPY_TEXT_ACTION } from "./shadcn-genui/actions";

/**
 * What an answer action should do, decided without touching a chat runtime so
 * the routing can be tested on its own.
 */
export type AnswerActionOutcome =
  | { kind: "assistant"; text: string }
  | { kind: "copy"; text: string }
  | { kind: "ignore" };

/**
 * Routes an action emitted by an answer to the host.
 *
 * This mirrors OpenUI's own assistant-ui integration: a `FollowUpBlock` press
 * (or any `@ToAssistant(...)` step) arrives as `continue_conversation` and is
 * appended to the thread. Our `@CopyText(...)` action copies to the clipboard
 * and leaves the conversation alone. Every other action type is ignored rather
 * than guessed at, so a generated answer can never navigate the workspace on
 * its own.
 */
export function resolveAnswerAction(event: ActionEvent): AnswerActionOutcome {
  if (event.type === BuiltinActionType.ContinueConversation) {
    const text = event.humanFriendlyMessage.trim();
    if (text.length === 0) return { kind: "ignore" };
    // Form submissions must carry the values the reader actually selected.
    // This is ordinary user input, never authority or private model memory.
    const details: Record<string, unknown> = {};
    if (event.formState && Object.keys(event.formState).length > 0) details.formValues = event.formState;
    if (event.params?.context !== undefined) details.context = event.params.context;
    let serialized = "";
    try { serialized = Object.keys(details).length > 0 ? JSON.stringify(details) : ""; } catch { /* Ignore non-JSON custom context. */ }
    return { kind: "assistant", text: serialized && serialized.length <= 8_000 ? `${text}\n\nSubmitted values (JSON):\n${serialized}` : text };
  }
  if (event.type === COPY_TEXT_ACTION) {
    const text = event.params?.text;
    return typeof text === "string" && text.trim().length > 0
      ? { kind: "copy", text }
      : { kind: "ignore" };
  }
  return { kind: "ignore" };
}

async function copyToClipboard(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) {
    toast.error("Clipboard is not available here.");
    return;
  }
  try {
    await clipboard.writeText(text);
    toast.success("Copied to clipboard.");
  } catch {
    toast.error("Could not copy to the clipboard.");
  }
}

export function useAnswerAction(): (event: ActionEvent) => void {
  const aui = useAui();

  return useCallback(
    (event: ActionEvent) => {
      const outcome = resolveAnswerAction(event);
      if (outcome.kind === "assistant") {
        aui.thread.append({
          role: "user",
          content: [{ type: "text", text: outcome.text }],
        });
        return;
      }
      if (outcome.kind === "copy") {
        void copyToClipboard(outcome.text);
      }
    },
    [aui],
  );
}
