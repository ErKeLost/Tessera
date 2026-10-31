import { describe, expect, test } from "bun:test";
import type { ActionEvent } from "@openuidev/react-lang";
import { resolveAnswerAction } from "./use-answer-action";

function event(partial: Pick<ActionEvent, "type"> & Partial<ActionEvent>): ActionEvent {
  return {
    params: partial.params ?? {},
    humanFriendlyMessage: partial.humanFriendlyMessage ?? "",
    ...partial,
  };
}

describe("resolveAnswerAction", () => {
  test("routes a continue_conversation step to the assistant", () => {
    const outcome = resolveAnswerAction(
      event({ type: "continue_conversation", humanFriendlyMessage: "Tell me more" }),
    );

    expect(outcome).toEqual({ kind: "assistant", text: "Tell me more" });
  });

  test("ignores an empty assistant message", () => {
    const outcome = resolveAnswerAction(
      event({ type: "continue_conversation", humanFriendlyMessage: "   " }),
    );

    expect(outcome).toEqual({ kind: "ignore" });
  });
  test("carries submitted form values and explicit action context into the next turn", () => {
    const outcome = resolveAnswerAction(event({ type: "continue_conversation", humanFriendlyMessage: "Analyze", formState: { filters: { status: { value: "paid", componentType: "Select" } } }, params: { context: { relation: "orders" } } }));
    expect(outcome.kind).toBe("assistant");
    if (outcome.kind === "assistant") {
      expect(outcome.text).toContain('"value":"paid"');
      expect(outcome.text).toContain('"relation":"orders"');
    }
  });

  test("routes CopyText to the clipboard without a model turn", () => {
    const outcome = resolveAnswerAction(
      event({ type: "CopyText", params: { text: "SELECT 1" } }),
    );

    expect(outcome).toEqual({ kind: "copy", text: "SELECT 1" });
  });

  test("ignores CopyText without usable text", () => {
    expect(resolveAnswerAction(event({ type: "CopyText", params: {} }))).toEqual({ kind: "ignore" });
    expect(
      resolveAnswerAction(event({ type: "CopyText", params: { text: "  " } })),
    ).toEqual({ kind: "ignore" });
  });

  test("ignores an unknown action instead of guessing at workspace navigation", () => {
    expect(resolveAnswerAction(event({ type: "OpenTable", params: { name: "orders" } }))).toEqual({
      kind: "ignore",
    });
  });
});
