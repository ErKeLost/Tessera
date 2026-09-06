import { Chat } from "@ai-sdk/react";
import { describe, expect, test } from "bun:test";
import { isStudioResumePayload } from "./studio-resume";

describe("Studio Mastra resume payload", () => {
  test("keeps the existing tool invocation when a continuation starts with output", async () => {
    const chat = new Chat({
      messages: [{
        id: "assistant-1",
        role: "assistant",
        parts: [{
          type: "tool-execute_sql",
          toolCallId: "tool-1",
          state: "input-available",
          input: { action: "execute_sql" },
        }],
      }],
      transport: {
        async sendMessages() {
          return new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: "tool-1",
                output: { status: "completed" },
              });
              controller.enqueue({ type: "finish", finishReason: "stop" });
              controller.close();
            },
          });
        },
        async reconnectToStream() {
          return null;
        },
      },
    });

    await chat.sendMessage(undefined, {
      body: {
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "tool-1",
        decision: "approve",
        requestId: "request-1",
        checkpointId: "checkpoint-1",
      },
    });

    expect(chat.messages[0]?.parts[0]).toMatchObject({
      type: "tool-execute_sql",
      toolCallId: "tool-1",
      state: "output-available",
      output: { status: "completed" },
    });
  });

  test("recognizes the complete Mastra tool continuation payload", () => {
    expect(isStudioResumePayload({
      threadId: "thread-1",
      runId: "run-1",
      toolCallId: "tool-1",
      decision: "approve",
      requestId: "request-1",
      checkpointId: "checkpoint-1",
    })).toBeTrue();
    expect(isStudioResumePayload({ decision: "approve" })).toBeFalse();
  });

});
