import type {
  ArtifactEventBus,
  ArtifactTelemetryEvent,
  ArtifactTelemetryStage,
} from "@data-elements/observability";

export type DevtoolsTimelineEntry = Readonly<{
  eventId: string;
  type: string;
  stage: ArtifactTelemetryStage;
  timestamp: string;
  runId: string;
  documentId?: string;
  revisionId?: string;
  transactionId?: string;
  nodeId?: string;
  contractFingerprint?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  outcome?: ArtifactTelemetryEvent["outcome"];
  diagnosticCodes: readonly string[];
  attributes: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type DevtoolsDiagnosticSummary = Readonly<{
  code: string;
  count: number;
  lastSeenAt: string;
  stages: readonly ArtifactTelemetryStage[];
}>;

export type ArtifactDevtoolsSnapshot = Readonly<{
  capturedAt: string;
  droppedEvents: number;
  timeline: readonly DevtoolsTimelineEntry[];
  diagnostics: readonly DevtoolsDiagnosticSummary[];
}>;

export type ArtifactDevtoolsOptions = {
  maxTimelineEvents?: number;
  maxDiagnosticCodes?: number;
  now?: () => string;
};

const sensitiveKey = /(?:authorization|cookie|credential|password|secret|sql|token)/i;
const sensitiveValue = /(?:bearer\s+[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{8,}|\b(?:select|insert|update|delete|drop|alter)\s+.+\b(?:from|into|table|set)\b)/i;

export class ArtifactDevtoolsStore {
  readonly #timeline: DevtoolsTimelineEntry[] = [];
  readonly #diagnostics = new Map<string, { count: number; lastSeenAt: string; stages: Set<ArtifactTelemetryStage> }>();
  readonly #maxTimelineEvents: number;
  readonly #maxDiagnosticCodes: number;
  readonly #now: () => string;
  readonly #unsubscribe: () => void;
  #droppedEvents = 0;

  constructor(bus: ArtifactEventBus, options: ArtifactDevtoolsOptions = {}) {
    this.#maxTimelineEvents = boundedInteger(options.maxTimelineEvents ?? 500, 1, 10_000, "maxTimelineEvents");
    this.#maxDiagnosticCodes = boundedInteger(options.maxDiagnosticCodes ?? 200, 1, 2_000, "maxDiagnosticCodes");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#unsubscribe = bus.subscribe((event) => this.#capture(event));
  }

  dispose(): void {
    this.#unsubscribe();
  }

  clear(): void {
    this.#timeline.length = 0;
    this.#diagnostics.clear();
    this.#droppedEvents = 0;
  }

  snapshot(): ArtifactDevtoolsSnapshot {
    const diagnostics = [...this.#diagnostics.entries()].map(([code, value]) => Object.freeze({
      code,
      count: value.count,
      lastSeenAt: value.lastSeenAt,
      stages: Object.freeze([...value.stages].sort()),
    })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
    return Object.freeze({
      capturedAt: this.#now(),
      droppedEvents: this.#droppedEvents,
      timeline: Object.freeze([...this.#timeline]),
      diagnostics: Object.freeze(diagnostics),
    });
  }

  #capture(event: ArtifactTelemetryEvent): void {
    const entry = projectEvent(event);
    this.#timeline.push(entry);
    if (this.#timeline.length > this.#maxTimelineEvents) {
      const removed = this.#timeline.length - this.#maxTimelineEvents;
      this.#timeline.splice(0, removed);
      this.#droppedEvents += removed;
    }
    for (const code of entry.diagnosticCodes) {
      const current = this.#diagnostics.get(code);
      if (current) {
        current.count += 1;
        current.lastSeenAt = event.timestamp;
        current.stages.add(event.stage);
      } else if (this.#diagnostics.size < this.#maxDiagnosticCodes) {
        this.#diagnostics.set(code, { count: 1, lastSeenAt: event.timestamp, stages: new Set([event.stage]) });
      }
    }
  }
}

export function createArtifactDevtools(
  bus: ArtifactEventBus,
  options?: ArtifactDevtoolsOptions,
): ArtifactDevtoolsStore {
  return new ArtifactDevtoolsStore(bus, options);
}

function projectEvent(event: ArtifactTelemetryEvent): DevtoolsTimelineEntry {
  const attributes: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(event.attributes)) {
    if (sensitiveKey.test(key)) continue;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
    } else if (typeof value === "string") {
      attributes[key] = sensitiveValue.test(value) ? "[REDACTED]" : value.slice(0, 500);
    }
  }
  return Object.freeze({
    eventId: event.eventId,
    type: event.type,
    stage: event.stage,
    timestamp: event.timestamp,
    runId: event.runId,
    ...(event.documentId ? { documentId: event.documentId } : {}),
    ...(event.revisionId ? { revisionId: event.revisionId } : {}),
    ...(event.transactionId ? { transactionId: event.transactionId } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.contractFingerprint ? { contractFingerprint: event.contractFingerprint } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    diagnosticCodes: Object.freeze([...event.diagnosticCodes]),
    attributes: Object.freeze(attributes),
  });
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
