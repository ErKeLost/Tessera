import { describe, expect, test } from "bun:test";
import { studioResumeApi } from "./studio-resume";

describe("studioResumeApi", () => {
  test("serializes the direct resume body used by chat.resumeStream", () => {
    expect(studioResumeApi({
      threadId: "thread-1",
      runId: "run-1",
      toolCallId: "tool-1",
      decision: "approve",
      requestId: "request-1",
      checkpointId: "checkpoint-1",
    })).toBe("/api/chat/resume?threadId=thread-1&runId=run-1&toolCallId=tool-1&decision=approve&requestId=request-1&checkpointId=checkpoint-1");
  });

  test("does not interpret legacy wrapped payloads", () => {
    expect(studioResumeApi({ custom: { threadId: "thread-1", runId: "run-1" } }))
      .toBe("/api/chat/resume");
  });

  test("does not create an empty query string", () => {
    expect(studioResumeApi(undefined)).toBe("/api/chat/resume");
  });
});
