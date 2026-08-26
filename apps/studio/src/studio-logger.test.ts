import { describe, expect, test } from "bun:test";
import { APICallError, RetryError } from "ai";
import {
  publicStudioStreamError,
  safeStudioErrorDetails,
  sanitizeStudioErrorText,
} from "./studio-logger";

describe("Studio error diagnostics", () => {
  test("keeps database error detail, hint, position, code, and cause chain", () => {
    const cause = Object.assign(new Error("socket closed during execution"), { name: "ConnectionError" });
    const error = Object.assign(new Error('relation "invoice_lines" does not exist'), {
      name: "PostgresError",
      code: "42P01",
      detail: "The referenced relation was not found in the active search path.",
      hint: "Use the exact schema-qualified relation name.",
      position: "22",
      cause,
    });

    expect(safeStudioErrorDetails(error)).toEqual({
      diagnosticCode: "42P01",
      errorType: "PostgresError",
      errorMessage: [
        'relation "invoice_lines" does not exist',
        "Detail: The referenced relation was not found in the active search path.",
        "Hint: Use the exact schema-qualified relation name.",
        "Position: 22",
        "Caused by ConnectionError: socket closed during execution",
      ].join(" "),
    });
  });

  test("redacts credentials, URLs, SQL, and provider payloads without hiding the concrete cause", () => {
    const value = sanitizeStudioErrorText([
      "OpenRouter returned 401: invalid credentials.",
      "authorization: Bearer provider-token-secret",
      "postgresql://reader:database-password@db.internal/warehouse",
      "query: SELECT card_number FROM private.payments",
      'response body: {"error":{"message":"raw-provider-payload"}}',
    ].join(" "));

    expect(value).toContain("OpenRouter returned 401: invalid credentials.");
    expect(value).toContain("[REDACTED]");
    expect(value).toContain("[REDACTED_SQL]");
    expect(value).toContain("[REDACTED_PROVIDER_PAYLOAD]");
    expect(value).not.toContain("provider-token-secret");
    expect(value).not.toContain("database-password");
    expect(value).not.toContain("card_number");
    expect(value).not.toContain("raw-provider-payload");
  });

  test("maps provider HTTP failures to concrete browser-safe summaries", () => {
    expect(publicStudioStreamError({ statusCode: 401 }, "openrouter/qwen/qwen3.8-27b")).toEqual({
      message: "OpenRouter 401: Unauthorized. The configured API credentials were rejected.",
      phase: "provider",
    });
    expect(publicStudioStreamError({ status: 403 }, "anthropic/claude-sonnet-4-5").message)
      .toBe("Anthropic 403: Forbidden. This account or model is not authorized for the request.");
    expect(publicStudioStreamError({ response: { status: 429 } }, "openrouter/qwen/qwen3.8-27b").message)
      .toBe("OpenRouter 429: Too Many Requests. The rate or usage limit was reached.");
    expect(publicStudioStreamError({ $metadata: { httpStatusCode: 503 } }, "openai/gpt-5").message)
      .toBe("OpenAI 503: Service Unavailable. The provider is temporarily unavailable.");
  });

  test("finds the final APICallError inside a real RetryError", () => {
    const apiError = new APICallError({
      message: "private provider message",
      url: "https://provider.example/private",
      requestBodyValues: { prompt: "private-user-prompt" },
      statusCode: 429,
      responseHeaders: { authorization: "Bearer secret-provider-token" },
      responseBody: '{"secret":"private-response-body"}',
    });
    const retryError = new RetryError({
      message: "private retry summary",
      reason: "maxRetriesExceeded",
      errors: [new Error("private first failure"), apiError],
    });

    expect(publicStudioStreamError(retryError, "openrouter/qwen/qwen3.8-27b")).toEqual({
      message: "OpenRouter 429: Too Many Requests. The rate or usage limit was reached.",
      phase: "provider",
    });
  });

  test("uses the fixed stream error for failures without an HTTP status", () => {
    expect(publicStudioStreamError(new Error("private tool failure"), "openrouter/qwen/qwen3.8-27b"))
      .toEqual({
        message: "The Tessera Agent stream could not be processed.",
        phase: "stream",
      });
  });

  test("never copies raw provider diagnostics into the public error", () => {
    const nested: Record<string, unknown> = {
      statusCode: "429",
      message: "provider-message-secret",
      url: "https://provider.example/private",
      requestBodyValues: { prompt: "private-user-prompt" },
      responseHeaders: {
        authorization: "Bearer secret-provider-token",
        cookie: "session=secret-cookie",
        "x-private-header": "secret-header-value",
      },
      responseBody: '{"secret":"private-response-body"}',
      stack: "Error: provider-message-secret\n at /Users/private/provider.ts:1:1",
      data: { secret: "private-provider-data" },
    };
    const wrapper: Record<string, unknown> = {
      message: "wrapper-message-secret",
      cause: nested,
    };
    nested.cause = wrapper;

    const result = publicStudioStreamError(wrapper, "openrouter/qwen/qwen3.8-27b").message;
    expect(result).toBe("OpenRouter 429: Too Many Requests. The rate or usage limit was reached.");
    for (const secret of [
      "provider-message-secret",
      "provider.example",
      "private-user-prompt",
      "secret-provider-token",
      "secret-cookie",
      "secret-header-value",
      "private-response-body",
      "/Users/private",
      "private-provider-data",
      "wrapper-message-secret",
    ]) {
      expect(result).not.toContain(secret);
    }
  });

  test("is bounded and never throws on cycles, throwing getters, or proxies", () => {
    const apiError = new APICallError({
      message: "private provider message",
      url: "https://provider.example/private",
      requestBodyValues: { prompt: "private-user-prompt" },
      statusCode: 503,
    });
    const cyclic: Record<string, unknown> = { errors: [apiError] };
    cyclic.cause = cyclic;
    cyclic.lastError = cyclic;
    expect(publicStudioStreamError(cyclic, "openai/gpt-5").message)
      .toBe("OpenAI 503: Service Unavailable. The provider is temporarily unavailable.");

    const throwing = new Proxy({}, {
      get() { throw new Error("throwing-getter-secret"); },
    });
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const error of [throwing, revocable.proxy]) {
      expect(() => publicStudioStreamError(error, "openrouter/qwen/qwen3.8-27b")).not.toThrow();
      expect(publicStudioStreamError(error, "openrouter/qwen/qwen3.8-27b")).toEqual({
        message: "The Tessera Agent stream could not be processed.",
        phase: "stream",
      });
    }
  });
});
