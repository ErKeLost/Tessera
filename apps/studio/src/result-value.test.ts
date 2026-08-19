import { describe, expect, test } from "bun:test";
import { normalizeResultValue } from "./result-value";

describe("normalized database result values", () => {
  test("extracts text from message parts and nested JSON strings", () => {
    const value = {
      format: 2,
      parts: [
        { type: "text", text: "用户：查一下最新注册用户" },
        { type: "text", text: "助手：正在查询" },
      ],
    };

    expect(normalizeResultValue(value, 1_000)).toBe("用户：查一下最新注册用户\n助手：正在查询");
    expect(normalizeResultValue(JSON.stringify(value), 1_000)).toBe("用户：查一下最新注册用户\n助手：正在查询");
  });

  test("searches wrapped payloads without turning arbitrary ids into message text", () => {
    expect(normalizeResultValue({ payload: { message: { content: { text: "Hello" } } } }, 1_000)).toBe("Hello");
    expect(normalizeResultValue({ id: "message-1", status: "completed" }, 1_000)).toBe(
      '{"id":"message-1","status":"completed"}',
    );
  });

  test("redacts sensitive structured keys and sensitive message text", () => {
    expect(normalizeResultValue({ metadata: { apiKey: "secret-value" }, status: "ok" }, 1_000)).toBe(
      '{"metadata":{"apiKey":"[redacted]"},"status":"ok"}',
    );
    expect(normalizeResultValue({ text: "token: secret-value" }, 1_000)).toBe("[redacted]");
  });
});
