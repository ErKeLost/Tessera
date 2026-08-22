import { describe, expect, test } from "bun:test";
import {
  BACKGROUND_STREAM_PROVIDER_OPTIONS,
  createBackgroundPostHandler,
  type BackgroundPerformanceReport,
  type BackgroundStreamPerformance,
  type BackgroundStreamResult,
} from "./handler";
import { BACKGROUND_MODEL } from "../../background/model";

function chatRequest(messages: unknown, model?: string): Request {
  return new Request("http://localhost/api/background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "background-demo",
      trigger: "submit-message",
      messageId: "user-1",
      messages,
      ...(model ? { model } : {}),
    }),
  });
}

function userMessage(text = "Show the validated revenue metric.") {
  return { id: "user-1", role: "user", parts: [{ type: "text", text }] };
}

function textStream(body = "data: {\"type\":\"finish\"}\n\n"): BackgroundStreamResult {
  return {
    toResponse: ({ serverTiming }) => new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "server-timing": serverTiming,
      },
    }),
  };
}

describe("background API handler", () => {
  test("returns a clear 503 without invoking a provider when the key is absent", async () => {
    let invoked = false;
    const handler = createBackgroundPostHandler({
      readApiKey: () => undefined,
      startStream: () => {
        invoked = true;
        throw new Error("must not run");
      },
    });

    const response = await handler(chatRequest([userMessage()]));

    expect(response.status).toBe(503);
    expect(invoked).toBe(false);
    expect(await response.json()).toEqual({
      error: {
        code: "background_unavailable",
        message: "Background demo is unavailable because OPENROUTER_API_KEY is not configured.",
      },
    });
  });

  test("rejects invalid chat input before invoking the provider", async () => {
    let invoked = false;
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      startStream: () => {
        invoked = true;
        throw new Error("must not run");
      },
    });

    const response = await handler(chatRequest([]));

    expect(response.status).toBe(400);
    expect(invoked).toBe(false);
  });

  test("rejects denied admissions before reading a provider key", async () => {
    let keyRead = false;
    const handler = createBackgroundPostHandler({
      admitRequest: async () => ({
        allowed: false as const,
        status: 429 as const,
        code: "background_rate_limited",
        message: "Too many Playground requests. Please try again shortly.",
        retryAfterSeconds: 7,
      }),
      readApiKey: () => {
        keyRead = true;
        return "test-only-placeholder";
      },
      startStream: () => textStream(),
    });

    const response = await handler(chatRequest([userMessage()]));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(keyRead).toBe(false);
  });

  test("redacts provider failures", async () => {
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      startStream: () => {
        throw new Error("provider rejected test-only-placeholder");
      },
    });

    const response = await handler(chatRequest([userMessage()]));
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("The model request failed.");
    expect(body).not.toContain("test-only-placeholder");
  });

  test("keeps text history but excludes prior generated payloads from model input", async () => {
    let capturedMessages: readonly { role: "user" | "assistant"; content: string }[] | undefined;
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      startStream: ({ turn }) => {
        capturedMessages = turn.messages;
        return textStream();
      },
    });

    const response = await handler(chatRequest([
      userMessage("Show the validated revenue metric."),
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Here is the revenue summary." },
          { type: "data-artifact", id: "historical-part", data: { untrustedNetworkWire: true } },
        ],
      },
      userMessage("Now show the next metric."),
    ]));

    expect(response.status).toBe(200);
    expect(capturedMessages).toEqual([
      { role: "user", content: "Show the validated revenue metric." },
      { role: "assistant", content: "Here is the revenue summary." },
      { role: "user", content: "Now show the next metric." },
    ]);
  });

  test("always uses the fixed model and ignores a client override", async () => {
    let streamedModel: string | undefined;
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      startStream: ({ model }) => {
        streamedModel = model.id;
        return textStream();
      },
    });

    const response = await handler(chatRequest([userMessage()], "another/provider-model"));

    expect(response.status).toBe(200);
    expect(streamedModel).toBe(BACKGROUND_MODEL.id);
  });

  test("disables hidden reasoning and reports only bounded timing", async () => {
    let streamPerformance: BackgroundStreamPerformance | undefined;
    const reports: BackgroundPerformanceReport[] = [];
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      observePerformance: (report) => reports.push(report),
      startStream: ({ performance }) => {
        streamPerformance = performance;
        return textStream();
      },
    });

    const response = await handler(chatRequest([userMessage("render a compact metric")]));
    await response.text();

    if (!streamPerformance) throw new Error("The stream performance trace was not supplied.");
    streamPerformance.markProviderStarted();
    streamPerformance.markProviderCompleted({
      responseMs: 42.5,
      timeToFirstOutputMs: 8.25,
      outputTokensPerSecond: 96.5,
      inputTokens: 321,
      outputTokens: 87,
      reasoningTokens: 0,
    });
    streamPerformance.finish();

    expect(BACKGROUND_STREAM_PROVIDER_OPTIONS.openrouter.reasoning).toEqual({
      effort: "none",
      exclude: true,
    });
    expect(response.headers.get("server-timing")).toMatch(
      /^input;dur=\d+(?:\.\d+)?, compile;dur=\d+(?:\.\d+)?, stream-init;dur=\d+(?:\.\d+)?$/,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      outcome: "succeeded",
      provider: { responseMs: 42.5, reasoningTokens: 0 },
    });
  });

  test("does not claim the text-only playground is the Generative UI proof path", async () => {
    const handler = createBackgroundPostHandler({
      readApiKey: () => "test-only-placeholder",
      startStream: () => textStream("data: {\"type\":\"text-end\"}\n\n"),
    });

    const response = await handler(chatRequest([userMessage()]));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("data-artifact");
  });
});
