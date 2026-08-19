import type { ArtifactTelemetryEvent, ArtifactTelemetrySink } from "./index";

type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

type OtlpKeyValue = { key: string; value: OtlpAnyValue };

export type OtlpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type OtlpHttpTelemetrySinkOptions = {
  endpoint: string;
  serviceName: string;
  serviceVersion?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  fetch?: OtlpFetch;
  allowInsecureLocalhost?: boolean;
};

/**
 * Server-side OTLP/HTTP JSON logs exporter. It serializes the already-redacted
 * Artifact event envelope and deliberately has no retry queue: hosts should use
 * their collector's durable ingestion and never block a user response on
 * telemetry delivery.
 */
export class OtlpHttpTelemetrySink implements ArtifactTelemetrySink {
  readonly id = "otlp-http";
  readonly #endpoint: URL;
  readonly #serviceName: string;
  readonly #serviceVersion: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #fetch: OtlpFetch;

  constructor(options: OtlpHttpTelemetrySinkOptions) {
    this.#endpoint = validateEndpoint(options.endpoint, options.allowInsecureLocalhost ?? false);
    this.#serviceName = requiredValue(options.serviceName, "serviceName");
    this.#serviceVersion = optionalValue(options.serviceVersion);
    this.#headers = Object.freeze({ ...options.headers });
    this.#timeoutMs = boundedTimeout(options.timeoutMs ?? 2_000);
    this.#fetch = options.fetch ?? fetch;
  }

  async emit(event: ArtifactTelemetryEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...this.#headers,
        },
        body: JSON.stringify(otlpLogPayload(event, this.#serviceName, this.#serviceVersion)),
      });
      if (!response.ok) throw new Error(`OTLP collector responded with ${response.status}.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function otlpLogPayload(
  event: ArtifactTelemetryEvent,
  serviceName: string,
  serviceVersion?: string,
): Record<string, unknown> {
  const resourceAttributes: OtlpKeyValue[] = [
    { key: "service.name", value: { stringValue: serviceName } },
    ...(serviceVersion ? [{ key: "service.version", value: { stringValue: serviceVersion } }] : []),
  ];
  return {
    resourceLogs: [{
      resource: { attributes: resourceAttributes },
      scopeLogs: [{
        scope: { name: "@data-elements/observability" },
        logRecords: [{
          timeUnixNano: String(Date.parse(event.timestamp) * 1_000_000),
          severityText: severityFor(event),
          body: { stringValue: event.type },
          attributes: eventAttributes(event),
        }],
      }],
    }],
  };
}

function eventAttributes(event: ArtifactTelemetryEvent): OtlpKeyValue[] {
  const attributes: OtlpKeyValue[] = [
    { key: "artifact.event_id", value: { stringValue: event.eventId } },
    { key: "artifact.run_id", value: { stringValue: event.runId } },
    { key: "artifact.stage", value: { stringValue: event.stage } },
    { key: "artifact.outcome", value: { stringValue: event.outcome ?? "unspecified" } },
    { key: "artifact.diagnostic_codes", value: { arrayValue: { values: event.diagnosticCodes.map((code) => ({ stringValue: code })) } } },
    { key: "artifact.attributes", value: toOtlpValue(event.attributes) },
  ];
  appendString(attributes, "artifact.document_id", event.documentId);
  appendString(attributes, "artifact.revision_id", event.revisionId);
  appendString(attributes, "artifact.transaction_id", event.transactionId);
  appendString(attributes, "artifact.node_id", event.nodeId);
  appendString(attributes, "artifact.invocation_id", event.invocationId);
  appendString(attributes, "artifact.request_id", event.requestId);
  appendString(attributes, "artifact.contract_fingerprint", event.contractFingerprint);
  appendString(attributes, "gen_ai.provider.name", event.provider);
  appendString(attributes, "gen_ai.request.model", event.model);
  if (event.durationMs !== undefined) attributes.push({ key: "artifact.duration_ms", value: { doubleValue: event.durationMs } });
  return attributes;
}

function appendString(attributes: OtlpKeyValue[], key: string, value: string | undefined): void {
  if (value !== undefined) attributes.push({ key, value: { stringValue: value } });
}

function toOtlpValue(value: unknown): OtlpAnyValue {
  if (value === null) return { stringValue: "null" };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toOtlpValue) } };
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => ({ key, value: toOtlpValue(item) })),
      },
    };
  }
  return { stringValue: String(value) };
}

function severityFor(event: ArtifactTelemetryEvent): "INFO" | "WARN" | "ERROR" {
  if (event.outcome === "failed") return "ERROR";
  if (["cancelled", "conflict", "denied"].includes(event.outcome ?? "")) return "WARN";
  return "INFO";
}

function validateEndpoint(input: string, allowInsecureLocalhost: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new TypeError("OTLP endpoint must be an absolute URL.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError("OTLP endpoint must not contain credentials, query parameters, or a fragment.");
  }
  const localhost = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(allowInsecureLocalhost && localhost && endpoint.protocol === "http:")) {
    throw new TypeError("OTLP endpoint must use HTTPS.");
  }
  return endpoint;
}

function requiredValue(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`OTLP ${name} is required.`);
  return trimmed;
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 100 || value > 30_000) throw new TypeError("OTLP timeout must be between 100 and 30000 milliseconds.");
  return Math.floor(value);
}
