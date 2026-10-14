"use client";

import { useAui } from "@assistant-ui/react";
import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";
import { useCallback } from "react";

/**
 * Turns an analysis-view action into the user's next message.
 *
 * This mirrors OpenUI's own assistant-ui integration: a `FollowUpBlock` press
 * (or any `Action([@ToAssistant(...)])`) arrives as a `continue_conversation`
 * event, and the host appends it to the thread. Any other action type is
 * ignored rather than guessed at, so a generated answer can never navigate the
 * workspace on its own.
 */
export function useAnswerAction(): (event: ActionEvent) => void {
  const aui = useAui();

  return useCallback(
    (event: ActionEvent) => {
      if (event.type !== BuiltinActionType.ContinueConversation) return;
      const text = event.humanFriendlyMessage.trim();
      if (text.length === 0) return;
      aui.thread.append({
        role: "user",
        content: [{ type: "text", text }],
      });
    },
    [aui],
  );
}
