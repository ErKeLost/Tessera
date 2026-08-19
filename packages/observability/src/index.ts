import { jsonValueSchema, type Diagnostic, type JsonValue } from "@data-elements/runtime";
import { z } from "zod";

export {
  OtlpHttpTelemetrySink,
  otlpLogPayload,
  type OtlpFetch,
  type OtlpHttpTelemetrySinkOptions,
} from "./otlp";

export const artifactTelemetryStageSchema = z.enum([
  "adapter",
  "compile",
  "decode",
  "normalize",
  "validate",
  "policy",
  "transaction",
  "commit",
  "render",
  "state",
  "action",
  "effect",
  "resource",
  "transport",
  "migration",
]);

export const artifactTelemetryEventSchema = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  stage: artifactTelemetryStageSchema,
  timestamp: z.iso.datetime(),
  runId: z.string().min(1),
  documentId: z.string().min(1).optional(),
  revisionId: z.string().min(1).optional(),
  transactionId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  contractFingerprint: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  durationMs: z.number().nonnegative().optional(),
  outcome: z.enum(["started", "succeeded", "failed", "cancelled", "conflict", "denied"]).optional(),
  diagnosticCodes: z.array(z.string().min(1)).max(64).default([]),
  attributes: z.record(z.string(), jsonValueSchema).default({}),
}).strict();

export type ArtifactTelemetryStage = z.infer<typeof artifactTelemetryStageSchema>;
export type ArtifactTelemetryEvent = z.infer<typeof artifactTelemetryEventSchema>;
export type ArtifactTelemetryInput = Omit<ArtifactTelemetryEvent, "diagnosticCodes" | "attributes"> & {
  diagnosticCodes?: readonly string[];
  diagnostics?: readonly Pick<Diagnostic, "code">[];
  attributes?: Readonly<Record<string, JsonValue>>;
};

export type ArtifactTelemetrySink = {
  readonly id: string;
  emit(event: ArtifactTelemetryEvent): void | Promise<void>;
};

export type ArtifactTelemetryListener = (event: ArtifactTelemetryEvent) => void;

const SENSITIVE_ATTRIBUTE = /(?:authorization|cookie|credential|password|secret|sql|token)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{8,}|\b(?:select|insert|update|delete|drop|alter)\s+.+\b(?:from|into|table|set)\b)/i;
const SAFE_TOKEN_COUNT_ATTRIBUTE = /^gen_ai\.usage\.(?:input|output|reasoning)_tokens$/;

export function sanitizeTelemetryAttributes(
  attributes: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(attributes)
    .filter(([key]) => !isSensitiveAttribute(key))
    .map(([key, value]) => [key, sanitizeTelemetryValue(jsonValueSchema.parse(value))]));
}

function isSensitiveAttribute(key: string): boolean {
  return SENSITIVE_ATTRIBUTE.test(key) && !SAFE_TOKEN_COUNT_ATTRIBUTE.test(key);
}

export function createTelemetryEvent(input: ArtifactTelemetryInput): ArtifactTelemetryEvent {
  const { diagnostics, ...event } = input;
  return Object.freeze(artifactTelemetryEventSchema.parse({
    ...event,
    diagnosticCodes: [...new Set([
      ...(input.diagnosticCodes ?? []),
      ...(diagnostics ?? []).map(({ code }) => code),
    ])].slice(0, 64),
    attributes: sanitizeTelemetryAttributes(input.attributes),
  }));
}

function sanitizeTelemetryValue(value: JsonValue): JsonValue {
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? "[REDACTED]" : value.slice(0, 2_000);
  if (Array.isArray(value)) return value.map(sanitizeTelemetryValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SENSITIVE_ATTRIBUTE.test(key))
      .map(([key, item]) => [key, sanitizeTelemetryValue(item)]));
  }
  return value;
}

export type ArtifactEventBusOptions = {
  maxBufferedEvents?: number;
  onSinkError?: (sinkId: string, error: unknown) => void;
};

export class ArtifactEventBus {
  readonly #listeners = new Set<ArtifactTelemetryListener>();
  readonly #sinks = new Map<string, ArtifactTelemetrySink>();
  readonly #events: ArtifactTelemetryEvent[] = [];
  readonly #maxBufferedEvents: number;
  readonly #onSinkError?: ArtifactEventBusOptions["onSinkError"];

  constructor(options: ArtifactEventBusOptions = {}) {
    this.#maxBufferedEvents = Math.max(0, Math.floor(options.maxBufferedEvents ?? 500));
    this.#onSinkError = options.onSinkError;
  }

  subscribe(listener: ArtifactTelemetryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addSink(sink: ArtifactTelemetrySink): () => void {
    if (!sink.id.trim()) throw new Error("Telemetry sinks require a stable id.");
    if (this.#sinks.has(sink.id)) throw new Error(`Telemetry sink "${sink.id}" is already registered.`);
    this.#sinks.set(sink.id, sink);
    return () => this.#sinks.delete(sink.id);
  }

  events(): readonly ArtifactTelemetryEvent[] {
    return [...this.#events];
  }

  clear(): void {
    this.#events.length = 0;
  }

  async emit(input: ArtifactTelemetryInput | ArtifactTelemetryEvent): Promise<ArtifactTelemetryEvent> {
    const event = createTelemetryEvent(input);
    if (this.#maxBufferedEvents > 0) {
      this.#events.push(event);
      if (this.#events.length > this.#maxBufferedEvents) {
        this.#events.splice(0, this.#events.length - this.#maxBufferedEvents);
      }
    }
    for (const listener of this.#listeners) listener(event);
    await Promise.all([...this.#sinks.values()].map(async (sink) => {
      try {
        await sink.emit(event);
      } catch (error) {
        this.#onSinkError?.(sink.id, error);
      }
    }));
    return event;
  }
}

export class InMemoryTelemetrySink implements ArtifactTelemetrySink {
  readonly id: string;
  readonly #events: ArtifactTelemetryEvent[] = [];

  constructor(id = "memory") {
    this.id = id;
  }

  emit(event: ArtifactTelemetryEvent): void {
    this.#events.push(event);
  }

  events(): readonly ArtifactTelemetryEvent[] {
    return [...this.#events];
  }

  clear(): void {
    this.#events.length = 0;
  }
}

export type TelemetryAggregate = {
  count: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs: number;
  diagnosticCounts: Record<string, number>;
};

export function aggregateTelemetry(
  events: readonly ArtifactTelemetryEvent[],
): Record<string, TelemetryAggregate> {
  const result: Record<string, TelemetryAggregate> = {};
  for (const event of events) {
    const key = `${event.stage}:${event.type}`;
    const current = result[key] ?? {
      count: 0,
      failures: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      diagnosticCounts: {},
    };
    current.count += 1;
    if (["failed", "conflict", "denied"].includes(event.outcome ?? "")) current.failures += 1;
    current.totalDurationMs += event.durationMs ?? 0;
    current.maxDurationMs = Math.max(current.maxDurationMs, event.durationMs ?? 0);
    for (const code of event.diagnosticCodes) {
      current.diagnosticCounts[code] = (current.diagnosticCounts[code] ?? 0) + 1;
    }
    result[key] = current;
  }
  return result;
}
