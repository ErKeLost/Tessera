import { describe, expect, test } from "bun:test";
import {
  ArtifactEventBus,
  InMemoryTelemetrySink,
  OtlpHttpTelemetrySink,
  aggregateTelemetry,
  createTelemetryEvent,
  otlpLogPayload,
} from "./index";

const base = {
  eventId: "event-1",
  type: "transaction.commit",
  stage: "commit" as const,
  timestamp: "2026-08-15T10:00:00.000Z",
  runId: "run-1",
};

describe("artifact observability", () => {
  test("redacts sensitive attribute names and deduplicates diagnostics", () => {
    const event = createTelemetryEvent({
      ...base,
      outcome: "failed",
      diagnosticCodes: ["commit.conflict", "commit.conflict"],
      attributes: {
        profile: "analysis",
        sql: "select secret",
        accessToken: "secret",
        "gen_ai.usage.output_tokens": 42,
        nested: { password: "hidden", note: "Bearer abcdefghijklmnop" },
      },
    });
    expect(event.attributes).toEqual({
      profile: "analysis",
      "gen_ai.usage.output_tokens": 42,
      nested: { note: "[REDACTED]" },
    });
    expect(event.diagnosticCodes).toEqual(["commit.conflict"]);
  });

  test("fans out events and preserves a bounded devtools trace", async () => {
    const errors: string[] = [];
    const bus = new ArtifactEventBus({ maxBufferedEvents: 2, onSinkError: (id) => errors.push(id) });
    const memory = new InMemoryTelemetrySink();
    bus.addSink(memory);
    bus.addSink({ id: "broken", emit: () => { throw new Error("private sink error"); } });
    let observed = 0;
    bus.subscribe(() => { observed += 1; });
    await bus.emit(base);
    await bus.emit({ ...base, eventId: "event-2", type: "render.start" });
    await bus.emit({ ...base, eventId: "event-3", type: "render.finish", durationMs: 12 });
    expect(observed).toBe(3);
    expect(memory.events()).toHaveLength(3);
    expect(bus.events().map(({ eventId }) => eventId)).toEqual(["event-2", "event-3"]);
    expect(errors).toEqual(["broken", "broken", "broken"]);
  });

  test("aggregates failures, latency, and diagnostic codes by stage", () => {
    const events = [
      createTelemetryEvent({ ...base, outcome: "succeeded", durationMs: 4 }),
      createTelemetryEvent({ ...base, eventId: "event-2", outcome: "conflict", durationMs: 7, diagnosticCodes: ["commit.head_conflict"] }),
    ];
    expect(aggregateTelemetry(events)["commit:transaction.commit"]).toEqual({
      count: 2,
      failures: 1,
      totalDurationMs: 11,
      maxDurationMs: 7,
      diagnosticCounts: { "commit.head_conflict": 1 },
    });
  });

  test("exports a redacted event using the OTLP HTTP JSON logs envelope", async () => {
    const event = createTelemetryEvent({
      ...base,
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro-0813",
      durationMs: 12.5,
      attributes: { prompt: "never included", accessToken: "secret", nested: { total: 3 } },
    });
    const payload = otlpLogPayload(event, "artifact-ui", "0.1.0");
    expect(payload).toMatchObject({
      resourceLogs: [{
        resource: { attributes: expect.arrayContaining([{ key: "service.name", value: { stringValue: "artifact-ui" } }]) },
        scopeLogs: [{
          logRecords: [{
            body: { stringValue: "transaction.commit" },
            attributes: expect.arrayContaining([
              { key: "gen_ai.provider.name", value: { stringValue: "openrouter" } },
              { key: "artifact.duration_ms", value: { doubleValue: 12.5 } },
            ]),
          }],
        }],
      }],
    });
    expect(JSON.stringify(payload)).not.toContain("secret");

    let request: Request | undefined;
    const sink = new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.com/v1/logs",
      serviceName: "artifact-ui",
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 200 });
      },
    });
    await sink.emit(event);
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(await request?.json()).toMatchObject({ resourceLogs: expect.any(Array) });
  });

  test("rejects plaintext non-local OTLP collectors", () => {
    expect(() => new OtlpHttpTelemetrySink({
      endpoint: "http://collector.example.com/v1/logs",
      serviceName: "artifact-ui",
    })).toThrow("HTTPS");
  });

  test("rejects OTLP endpoints that embed credentials or query secrets", () => {
    expect(() => new OtlpHttpTelemetrySink({
      endpoint: "https://token@example.com/v1/logs",
      serviceName: "artifact-ui",
    })).toThrow("must not contain credentials");
    expect(() => new OtlpHttpTelemetrySink({
      endpoint: "https://collector.example.com/v1/logs?api_key=private",
      serviceName: "artifact-ui",
    })).toThrow("must not contain credentials");
  });
});
