import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  safeValidateUIMessages,
  streamText,
  type UIMessage,
} from "ai";
import {
  BACKGROUND_MODEL,
  type BackgroundModel,
} from "../../background/model";
import { backgroundSecurity, type BackgroundAdmission } from "@/lib/background-security";
import { backgroundPerformanceObserver } from "@/lib/background-observability";

export const MAX_BACKGROUND_BODY_BYTES = 64 * 1024;
export const MAX_BACKGROUND_MESSAGES = 20;
export const MAX_BACKGROUND_MESSAGE_PARTS = 24;
export const MAX_BACKGROUND_TEXT_PART_BYTES = 8 * 1024;
export const MAX_BACKGROUND_TOTAL_TEXT_BYTES = 32 * 1024;
export const BACKGROUND_STREAM_PROVIDER_OPTIONS = Object.freeze({
  openrouter: Object.freeze({
    // Artifact proposals are independently normalized, validated, and repaired.
    // Hidden chain-of-thought adds latency without changing that trusted boundary.
    reasoning: Object.freeze({ effort: "none" as const, exclude: true }),
    // Keep the requested model fixed while choosing a low-latency upstream
    // that supports every parameter and does not retain request data.
    provider: Object.freeze({
      sort: "latency" as const,
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny" as const,
    }),
  }),
});

type BackgroundTurnMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BackgroundStreamInput = {
  apiKey: string;
  abortSignal: AbortSignal;
  model: BackgroundModel;
  turn: Readonly<{
    messages: readonly BackgroundTurnMessage[];
    system: string;
  }>;
  performance?: BackgroundStreamPerformance;
};

export type BackgroundStreamResult = {
  toResponse(input: Readonly<{
    originalMessages: readonly UIMessage[];
    serverTiming: string;
  }>): Response;
};

export type BackgroundProviderPerformance = {
  providerStartDelayMs?: number;
  responseMs: number;
  timeToFirstOutputMs?: number;
  outputTokensPerSecond?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
};

export type BackgroundPerformanceReport = {
  outcome: "succeeded" | "failed" | "cancelled";
  totalMs: number;
  inputMs?: number;
  compileMs?: number;
  streamSetupMs?: number;
  provider?: BackgroundProviderPerformance;
  artifactValidationMs?: number;
};

export type BackgroundStreamPerformance = {
  markProviderStarted(): void;
  markProviderCompleted(input: BackgroundProviderPerformance): void;
  markArtifactValidated(durationMs: number): void;
  markStreamFailed(): void;
  finish(outcome?: BackgroundPerformanceReport["outcome"]): void;
};

export type BackgroundRouteDependencies = {
  readApiKey(): string | undefined;
  admitRequest?(request: Request): Promise<BackgroundAdmission>;
  startStream(input: BackgroundStreamInput): BackgroundStreamResult | Promise<BackgroundStreamResult>;
  observePerformance?(report: BackgroundPerformanceReport): void;
};

const encoder = new TextEncoder();

const defaultDependencies: BackgroundRouteDependencies = {
  readApiKey: () => process.env.OPENROUTER_API_KEY,
  startStream: ({ apiKey, abortSignal, model, turn, performance: streamPerformance }) => {
    const openrouter = createOpenRouter({ apiKey });
    const result = streamText({
      model: openrouter(model.id),
      messages: [...turn.messages],
      system: turn.system,
      maxOutputTokens: 4_096,
      maxRetries: 1,
      timeout: 45_000,
      abortSignal,
      providerOptions: BACKGROUND_STREAM_PROVIDER_OPTIONS,
      onLanguageModelCallStart: () => streamPerformance?.markProviderStarted(),
      onLanguageModelCallEnd: ({ performance, usage }) => {
        streamPerformance?.markProviderCompleted({
          responseMs: performance.responseTimeMs,
          timeToFirstOutputMs: performance.timeToFirstOutputMs,
          outputTokensPerSecond: performance.outputTokensPerSecond,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.outputTokenDetails.reasoningTokens,
        });
      },
      onEnd: () => streamPerformance?.finish(),
      onAbort: () => streamPerformance?.finish("cancelled"),
      // Provider errors are surfaced through a generic stream error below.
      onError: () => {
        streamPerformance?.markStreamFailed();
        streamPerformance?.finish("failed");
      },
    });
    return {
      toResponse: ({ originalMessages, serverTiming }) => result.toUIMessageStreamResponse({
        originalMessages: [...originalMessages],
        sendReasoning: false,
        sendSources: false,
        headers: {
          "Cache-Control": "no-store",
          "Server-Timing": serverTiming,
        },
        onError: () => "background:model_request_failed",
      }),
    };
  },
  observePerformance: backgroundPerformanceObserver,
};

export function createBackgroundPostHandler(
  dependencies: BackgroundRouteDependencies = defaultDependencies,
) {
  return async function handleBackgroundPost(request: Request): Promise<Response> {
    const performance = new BackgroundPerformanceTrace(dependencies.observePerformance);
    let release: (() => void) | undefined;
    try {
      const admission = await (dependencies.admitRequest ?? backgroundSecurity.admit.bind(backgroundSecurity))(request);
      if (!admission.allowed) return backgroundSecurityError(admission);
      release = admission.release;
      assertJsonContentType(request);
      const inputStartedAt = performance.now();
      const payload = await readBoundedJson(request);
      const messages = await validateBackgroundMessages(payload);
      performance.markInputCompleted(performance.now() - inputStartedAt);
      const apiKey = dependencies.readApiKey()?.trim();

      if (!apiKey) {
        return jsonError(
          503,
          "background_unavailable",
          "Background demo is unavailable because OPENROUTER_API_KEY is not configured.",
        );
      }

      const model = BACKGROUND_MODEL;
      const modelMessages = toBackgroundTurnMessages(messages);
      const compileStartedAt = performance.now();
      const turn = Object.freeze({
        messages: modelMessages,
        system: [
          "You are the Tessera Agent documentation playground.",
          "Answer data-analysis questions concisely.",
          "This route does not publish Generative UI until the trusted Surface pipeline is connected.",
        ].join(" "),
      });
      performance.markCompileCompleted(performance.now() - compileStartedAt);
      const streamSetupStartedAt = performance.now();
      const result = await dependencies.startStream({
        apiKey,
        abortSignal: request.signal,
        model,
        turn,
        performance,
      });
      performance.markStreamSetupCompleted(performance.now() - streamSetupStartedAt);

      const response = result.toResponse({
        originalMessages: messages,
        serverTiming: performance.toServerTiming(),
      });
      return releaseOnResponseCompletion(response, release);
    } catch (error) {
      performance.finish("failed");
      release?.();
      if (error instanceof BackgroundRequestError) {
        return jsonError(error.status, error.code, error.publicMessage);
      }
      return jsonError(502, "model_request_failed", "The model request failed.");
    }
  };
}

class BackgroundPerformanceTrace implements BackgroundStreamPerformance {
  readonly #startedAt = globalThis.performance.now();
  readonly #observer?: BackgroundRouteDependencies["observePerformance"];
  #inputMs: number | undefined;
  #compileMs: number | undefined;
  #streamSetupMs: number | undefined;
  #providerStartedAt: number | undefined;
  #provider: BackgroundProviderPerformance | undefined;
  #artifactValidationMs: number | undefined;
  #failed = false;
  #finished = false;

  constructor(observer?: BackgroundRouteDependencies["observePerformance"]) {
    this.#observer = observer;
  }

  now(): number {
    return globalThis.performance.now();
  }

  markInputCompleted(durationMs: number): void {
    this.#inputMs = toDuration(durationMs);
  }

  markCompileCompleted(durationMs: number): void {
    this.#compileMs = toDuration(durationMs);
  }

  markStreamSetupCompleted(durationMs: number): void {
    this.#streamSetupMs = toDuration(durationMs);
  }

  markProviderStarted(): void {
    this.#providerStartedAt ??= this.now();
  }

  markProviderCompleted(input: BackgroundProviderPerformance): void {
    this.#provider = {
      ...(this.#providerStartedAt === undefined
        ? {}
        : { providerStartDelayMs: toDuration(this.#providerStartedAt - this.#startedAt) }),
      responseMs: toDuration(input.responseMs),
      ...(optionalDuration("timeToFirstOutputMs", input.timeToFirstOutputMs)),
      ...(optionalNumber("outputTokensPerSecond", input.outputTokensPerSecond)),
      ...(optionalNumber("inputTokens", input.inputTokens)),
      ...(optionalNumber("outputTokens", input.outputTokens)),
      ...(optionalNumber("reasoningTokens", input.reasoningTokens)),
    };
  }

  markArtifactValidated(durationMs: number): void {
    this.#artifactValidationMs = toDuration(durationMs);
  }

  markStreamFailed(): void {
    this.#failed = true;
  }

  finish(outcome?: BackgroundPerformanceReport["outcome"]): void {
    if (this.#finished) return;
    this.#finished = true;

    const report: BackgroundPerformanceReport = Object.freeze({
      outcome: outcome ?? (this.#failed ? "failed" : "succeeded"),
      totalMs: toDuration(this.now() - this.#startedAt),
      ...(optionalDuration("inputMs", this.#inputMs)),
      ...(optionalDuration("compileMs", this.#compileMs)),
      ...(optionalDuration("streamSetupMs", this.#streamSetupMs)),
      ...(this.#provider ? { provider: Object.freeze({ ...this.#provider }) } : {}),
      ...(optionalDuration("artifactValidationMs", this.#artifactValidationMs)),
    });
    try {
      this.#observer?.(report);
    } catch {
      // Telemetry is never allowed to affect a model response.
    }
  }

  toServerTiming(): string {
    return [
      timingMetric("input", this.#inputMs),
      timingMetric("compile", this.#compileMs),
      timingMetric("stream-init", this.#streamSetupMs),
    ].filter((value): value is string => value !== undefined).join(", ");
  }
}

function timingMetric(name: string, durationMs: number | undefined): string | undefined {
  return durationMs === undefined ? undefined : `${name};dur=${durationMs}`;
}

function optionalDuration<Key extends string>(
  key: Key,
  value: number | undefined,
): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: toDuration(value) } as Record<Key, number>;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): Partial<Record<Key, number>> {
  return value === undefined || !Number.isFinite(value) ? {} : { [key]: value } as Record<Key, number>;
}

function toDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0;
}

function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BackgroundRequestError(
      415,
      "unsupported_media_type",
      "The request must use application/json.",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_BACKGROUND_BODY_BYTES) {
      throw requestTooLarge();
    }
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) {
    throw invalidRequest();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BACKGROUND_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is the user-facing error even if cancellation races the transport.
        }
        throw requestTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest();
  }
}

async function validateBackgroundMessages(payload: unknown): Promise<UIMessage[]> {
  if (!isRecord(payload) || !("messages" in payload)) throw invalidRequest();
  validateTransportMetadata(payload);

  const validation = await safeValidateUIMessages({ messages: payload.messages });
  if (!validation.success) throw invalidRequest();
  const messages = validation.data;

  if (messages.length === 0 || messages.length > MAX_BACKGROUND_MESSAGES) {
    throw invalidRequest();
  }

  let totalTextBytes = 0;
  for (const message of messages) {
    if (message.role === "system" || message.id.length === 0 || message.id.length > 128) {
      throw invalidRequest();
    }
    if (message.parts.length === 0 || message.parts.length > MAX_BACKGROUND_MESSAGE_PARTS) {
      throw invalidRequest();
    }

    for (const part of message.parts) {
      if (part.type === "text") {
        const partBytes = encoder.encode(part.text).byteLength;
        if (partBytes > MAX_BACKGROUND_TEXT_PART_BYTES) throw invalidRequest();
        totalTextBytes += partBytes;
        continue;
      }

      const allowedServerPart = message.role === "assistant"
        && (part.type === "data-artifact" || part.type === "step-start");
      if (!allowedServerPart) throw invalidRequest();
    }
  }

  if (totalTextBytes === 0 || totalTextBytes > MAX_BACKGROUND_TOTAL_TEXT_BYTES) {
    throw invalidRequest();
  }

  const last = messages.at(-1);
  if (last?.role !== "user" || !last.parts.some((part) => (
    part.type === "text" && part.text.trim().length > 0
  ))) {
    throw invalidRequest();
  }

  return messages;
}

function validateTransportMetadata(payload: Record<string, unknown>): void {
  if ("id" in payload && (typeof payload.id !== "string" || payload.id.length > 128)) {
    throw invalidRequest();
  }
  if ("trigger" in payload && payload.trigger !== "submit-message" && payload.trigger !== "regenerate-message") {
    throw invalidRequest();
  }
  if ("messageId" in payload && payload.messageId !== null && payload.messageId !== undefined
    && (typeof payload.messageId !== "string" || payload.messageId.length > 128)) {
    throw invalidRequest();
  }
}

function toBackgroundTurnMessages(messages: UIMessage[]): BackgroundTurnMessage[] {
  return messages.flatMap((message) => {
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    return content ? [{ role: message.role as "user" | "assistant", content }] : [];
  });
}

function backgroundSecurityError(admission: Extract<BackgroundAdmission, { allowed: false }>): Response {
  return admission.retryAfterSeconds === undefined
    ? jsonError(admission.status, admission.code, admission.message)
    : jsonError(admission.status, admission.code, admission.message, {
        "Retry-After": String(admission.retryAfterSeconds),
      });
}

function releaseOnResponseCompletion(
  response: Response,
  release: (() => void) | undefined,
): Response {
  if (!response.body) {
    release?.();
    return response;
  }
  const reader = response.body.getReader();
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    release?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          settle();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle();
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers: HeadersInit = {},
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

function invalidRequest(): BackgroundRequestError {
  return new BackgroundRequestError(
    400,
    "invalid_request",
    "The request contains invalid or unsupported chat messages.",
  );
}

function requestTooLarge(): BackgroundRequestError {
  return new BackgroundRequestError(
    413,
    "request_too_large",
    `The request body must not exceed ${MAX_BACKGROUND_BODY_BYTES} bytes.`,
  );
}

class BackgroundRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "BackgroundRequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
