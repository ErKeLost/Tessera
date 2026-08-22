import { describe, expect, test } from "bun:test";
import {
  createBackgroundPerformanceObserver,
  type BackgroundTelemetryEvent,
  type BackgroundTelemetrySink,
} from "./background-observability";

const report = {
  outcome: "succeeded" as const,
  totalMs: 543.2,
  inputMs: 1.2,
  compileMs: 2.3,
  streamSetupMs: 3.4,
  artifactValidationMs: 0.7,
  provider: {
    providerStartDelayMs: 15,
    responseMs: 520,
    timeToFirstOutputMs: 110,
    outputTokensPerSecond: 82.5,
    inputTokens: 123,
    outputTokens: 45,
    reasoningTokens: 0,
  },
};

describe("background performance observer", () => {
  test("remains disabled until a log or telemetry sink is configured", () => {
    expect(createBackgroundPerformanceObserver({ env: {} })).toBeUndefined();
  });

  test("publishes only redacted model-turn metrics without blocking the caller", async () => {
    const events: BackgroundTelemetryEvent[] = [];
    const sink: BackgroundTelemetrySink = {
      emit(event) {
        events.push(event);
      },
    };
    const observer = createBackgroundPerformanceObserver({ env: {}, sinks: [sink] });
    if (!observer) throw new Error("Expected an active observer.");

    observer(report);
    await Promise.resolve();

    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error("Expected one telemetry event.");
    expect(event).toMatchObject({
      type: "background.model_turn",
      stage: "transport",
      provider: "openrouter",
      outcome: "succeeded",
      durationMs: 543.2,
    });
    expect(event.attributes["artifact.input_ms"]).toBe(1.2);
    expect(event.attributes["gen_ai.response_ms"]).toBe(520);
    expect(event.attributes["gen_ai.usage.reasoning_tokens"]).toBe(0);
    expect(JSON.stringify(event)).not.toContain("prompt");
    expect(JSON.stringify(event)).not.toContain("token-value");
  });

  test("does not make an invalid optional collector configuration fatal", () => {
    const errors: unknown[] = [];
    const observer = createBackgroundPerformanceObserver({
      env: { ARTIFACT_OTLP_LOGS_ENDPOINT: "http://collector.example.com/v1/logs" },
      onConfigurationError: (error) => errors.push(error),
    });
    expect(observer).toBeUndefined();
    expect(errors[0]).toBeInstanceOf(TypeError);
  });
});
