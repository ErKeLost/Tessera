import { randomUUID } from "node:crypto";
import {
  createTelemetryEvent,
  OtlpHttpTelemetrySink,
  type ArtifactTelemetrySink,
} from "@data-elements/observability";
import type { BackgroundPerformanceReport } from "@/app/api/background/handler";
import { BACKGROUND_MODEL } from "@/app/background/model";

type Environment = Readonly<Record<string, string | undefined>>;

export type BackgroundPerformanceObserver = (report: BackgroundPerformanceReport) => void;

export type BackgroundPerformanceObserverOptions = {
  env?: Environment;
  sinks?: readonly ArtifactTelemetrySink[];
  onConfigurationError?: (error: unknown) => void;
};

/**
 * Creates an optional, non-blocking exporter for Playground model-turn metrics.
 * The event contains only measured durations and token counts; content never
 * leaves the request path through this observer.
 */
export function createBackgroundPerformanceObserver(
  options: BackgroundPerformanceObserverOptions = {},
): BackgroundPerformanceObserver | undefined {
  const env = options.env ?? process.env;
  const sinks = [...(options.sinks ?? [])];
  const endpoint = nonEmpty(env.ARTIFACT_OTLP_LOGS_ENDPOINT);

  if (endpoint) {
    try {
      sinks.push(new OtlpHttpTelemetrySink({
        endpoint,
        serviceName: nonEmpty(env.OTEL_SERVICE_NAME) ?? "artifact-ui-playground",
        serviceVersion: nonEmpty(env.ARTIFACT_RELEASE_VERSION),
        headers: telemetryHeaders(env),
        timeoutMs: boundedTimeout(env.ARTIFACT_OTLP_TIMEOUT_MS),
        allowInsecureLocalhost: env.NODE_ENV !== "production"
          && env.ARTIFACT_OTLP_ALLOW_INSECURE_LOCALHOST === "1",
      }));
    } catch (error) {
      options.onConfigurationError?.(error);
    }
  }

  const logPerformance = env.BACKGROUND_PERFORMANCE_LOG === "1";
  if (!logPerformance && sinks.length === 0) return undefined;

  return (report) => {
    const event = createTelemetryEvent({
      eventId: randomUUID(),
      type: "background.model_turn",
      stage: "transport",
      timestamp: new Date().toISOString(),
      runId: randomUUID(),
      provider: "openrouter",
      model: BACKGROUND_MODEL.id,
      durationMs: report.totalMs,
      outcome: report.outcome,
      attributes: performanceAttributes(report),
    });

    if (logPerformance) console.info("background.performance", JSON.stringify(event));
    for (const sink of sinks) {
      void Promise.resolve(sink.emit(event)).catch(() => undefined);
    }
  };
}

export const backgroundPerformanceObserver = createBackgroundPerformanceObserver();

function performanceAttributes(report: BackgroundPerformanceReport): Record<string, number> {
  const attributes: Record<string, number> = {};
  setNumber(attributes, "artifact.input_ms", report.inputMs);
  setNumber(attributes, "artifact.compile_ms", report.compileMs);
  setNumber(attributes, "artifact.stream_setup_ms", report.streamSetupMs);
  setNumber(attributes, "artifact.validation_ms", report.artifactValidationMs);
  setNumber(attributes, "gen_ai.provider_start_delay_ms", report.provider?.providerStartDelayMs);
  setNumber(attributes, "gen_ai.response_ms", report.provider?.responseMs);
  setNumber(attributes, "gen_ai.time_to_first_output_ms", report.provider?.timeToFirstOutputMs);
  setNumber(attributes, "gen_ai.output_tokens_per_second", report.provider?.outputTokensPerSecond);
  setNumber(attributes, "gen_ai.usage.input_tokens", report.provider?.inputTokens);
  setNumber(attributes, "gen_ai.usage.output_tokens", report.provider?.outputTokens);
  setNumber(attributes, "gen_ai.usage.reasoning_tokens", report.provider?.reasoningTokens);
  return attributes;
}

function telemetryHeaders(env: Environment): Record<string, string> {
  const authorization = nonEmpty(env.ARTIFACT_OTLP_AUTHORIZATION);
  return authorization ? { Authorization: authorization } : {};
}

function boundedTimeout(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 30_000) return undefined;
  return parsed;
}

function setNumber(target: Record<string, number>, key: string, value: number | undefined): void {
  if (value !== undefined && Number.isFinite(value)) target[key] = value;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
