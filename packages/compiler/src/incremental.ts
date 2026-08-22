import {
  DEFAULT_PROTOCOL_LIMITS,
  HASH_DOMAINS,
  ProtocolError,
  canonicalStringify,
  decodeJson,
  hashCanonical,
  jsonObjectSchema,
  proposalOperationEnvelopeSchema,
  type Diagnostic,
  type ProposalOperationEnvelope,
} from "@open-generative/protocol";
import { diagnostic, utf8Length } from "./internal";
import { decodePresentUiInput } from "./decoder";
import type { ProposalCompilerTurn } from "./turn";
import type {
  CompiledPresentUi,
  CompilerTurnOutcome,
  PresentUiAuthoringInput,
} from "./types";

export interface IncrementalPresentUiSession<TResult = CompilerTurnOutcome> {
  start(): Promise<TResult | undefined>;
  pushTextDelta(delta: string): Promise<TResult | undefined>;
  complete(input: PresentUiAuthoringInput): Promise<TResult>;
  abort(reason?: "timeout" | "cancelled"): Promise<TResult>;
}

export type IncrementalPresentUiSessionContext = Readonly<{
  toolCallId: string;
  abortSignal?: AbortSignal;
}>;

export type IncrementalPresentUiSessionFactory<
  TResult,
  TContext extends IncrementalPresentUiSessionContext,
> = (context: TContext) => IncrementalPresentUiSession<TResult> | PromiseLike<IncrementalPresentUiSession<TResult>>;

export class IncrementalPresentUiSessionCoordinator<
  TResult,
  TContext extends IncrementalPresentUiSessionContext,
> {
  readonly #createSession: IncrementalPresentUiSessionFactory<TResult, TContext>;
  readonly #maxAttempts: number;
  readonly #sessions = new Map<string, Promise<IncrementalPresentUiSession<TResult>>>();
  #attempts = 0;

  constructor(input: Readonly<{
    createSession: IncrementalPresentUiSessionFactory<TResult, TContext>;
    maxAttempts?: number;
  }>) {
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
      throw new TypeError("present_ui maxAttempts must be an integer between 1 and 8.");
    }
    this.#createSession = input.createSession;
    this.#maxAttempts = maxAttempts;
  }

  get attempts(): number {
    return this.#attempts;
  }

  async start(context: TContext): Promise<TResult | undefined> {
    return (await this.#get(context)).start();
  }

  async pushTextDelta(context: TContext, delta: string): Promise<TResult | undefined> {
    return (await this.#get(context)).pushTextDelta(delta);
  }

  async complete(context: TContext, input: PresentUiAuthoringInput): Promise<TResult> {
    return (await this.#get(context)).complete(input);
  }

  async execute(context: TContext, input: PresentUiAuthoringInput): Promise<TResult> {
    try {
      return await this.complete(context, input);
    } finally {
      this.#sessions.delete(context.toolCallId);
    }
  }

  release(toolCallId: string): void {
    this.#sessions.delete(toolCallId);
  }

  async abort(context: TContext, reason: "timeout" | "cancelled" = "cancelled"): Promise<TResult | undefined> {
    const session = this.#sessions.get(context.toolCallId);
    if (!session) return undefined;
    try {
      return await (await session).abort(reason);
    } finally {
      this.#sessions.delete(context.toolCallId);
    }
  }

  async #get(context: TContext): Promise<IncrementalPresentUiSession<TResult>> {
    if (typeof context.toolCallId !== "string" || context.toolCallId.length === 0) {
      throw new TypeError("present_ui streaming callbacks require a toolCallId.");
    }
    const existing = this.#sessions.get(context.toolCallId);
    if (existing) return existing;
    if (this.#attempts >= this.#maxAttempts) {
      throw new PresentUiRepairBudgetExceededError(this.#maxAttempts);
    }
    this.#attempts += 1;
    const created = Promise.resolve(this.#createSession(context)).then((session) => {
      if (context.abortSignal) {
        const abort = () => { void session.abort("cancelled").catch(() => undefined); };
        if (context.abortSignal.aborted) abort();
        else context.abortSignal.addEventListener("abort", abort, { once: true });
      }
      return session;
    });
    this.#sessions.set(context.toolCallId, created);
    try {
      return await created;
    } catch (error) {
      this.#sessions.delete(context.toolCallId);
      throw error;
    }
  }
}

export class PresentUiRepairBudgetExceededError extends Error {
  readonly code = "present-ui.repair-budget-exhausted";

  constructor(readonly maxAttempts: number) {
    super(`present_ui repair budget is exhausted after ${maxAttempts} attempts.`);
    this.name = "PresentUiRepairBudgetExceededError";
  }
}

export type IncrementalPresentUiCompilerSessionOptions = Readonly<{
  compiled: Pick<CompiledPresentUi, "canonicalInputSchema" | "maxOperations">;
  turn: ProposalCompilerTurn;
  maxInputBytes?: number;
}>;

export class IncrementalPresentUiCompilerSession
implements IncrementalPresentUiSession<CompilerTurnOutcome> {
  readonly #compiled: IncrementalPresentUiCompilerSessionOptions["compiled"];
  readonly #turn: ProposalCompilerTurn;
  readonly #framer: IncrementalOperationArrayFramer;
  readonly #operations: ProposalOperationEnvelope[] = [];
  #deltaCount = 0;
  #outcome?: CompilerTurnOutcome;
  #completionInput?: string;
  #completion?: Promise<CompilerTurnOutcome>;

  constructor(options: IncrementalPresentUiCompilerSessionOptions) {
    this.#compiled = options.compiled;
    this.#turn = options.turn;
    this.#framer = new IncrementalOperationArrayFramer(
      options.maxInputBytes ?? DEFAULT_PROTOCOL_LIMITS.maxDocumentBytes,
      options.compiled.maxOperations,
    );
  }

  async start(): Promise<CompilerTurnOutcome | undefined> {
    if (this.#outcome) return this.#outcome;
    const outcome = await this.#turn.start();
    if (outcome) this.#outcome = outcome;
    return outcome;
  }

  async pushTextDelta(delta: string): Promise<CompilerTurnOutcome | undefined> {
    if (this.#completion) {
      throw new TypeError("present_ui input cannot continue after completion.");
    }
    if (this.#outcome) return this.#outcome;
    this.#deltaCount += 1;
    try {
      const startOutcome = await this.start();
      if (startOutcome) return startOutcome;
      for (const frame of this.#framer.push(delta)) {
        const operation = await decodeStreamedOperation(frame);
        this.#operations.push(operation);
        const outcome = await this.#turn.pushDecodedOperation(operation);
        if (outcome) {
          this.#outcome = outcome;
          return outcome;
        }
      }
      return undefined;
    } catch (error) {
      return this.#reject(error);
    }
  }

  complete(input: PresentUiAuthoringInput): Promise<CompilerTurnOutcome> {
    const inputIdentity = canonicalStringify(input);
    if (this.#completion) {
      if (inputIdentity !== this.#completionInput) {
        return Promise.reject(new TypeError("present_ui completion was replayed with different canonical input."));
      }
      return this.#completion;
    }
    this.#completionInput = inputIdentity;
    this.#completion = this.#completeOnce(input);
    return this.#completion;
  }

  async abort(reason: "timeout" | "cancelled" = "cancelled"): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    this.#outcome = await this.#turn.cancel(reason, diagnostic({
      phase: "decode",
      code: reason === "timeout" ? "present-ui.input-timeout" : "present-ui.input-cancelled",
      message: reason === "timeout" ? "present_ui input timed out." : "present_ui input was cancelled.",
      recoverable: false,
      modelCorrectable: false,
    }));
    return this.#outcome;
  }

  async #completeOnce(input: PresentUiAuthoringInput): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    try {
      const decoded = await decodePresentUiInput(this.#compiled, input);
      if (decoded.kind === "snapshot") {
        if (this.#operations.length > 0) {
          throw streamError(
            "present-ui.mode-mismatch",
            "Streamed entity operations cannot complete as a snapshot proposal.",
          );
        }
        this.#outcome = await this.#turn.runDecoded(decoded);
        return this.#outcome;
      }

      if (this.#deltaCount > 0) this.#framer.assertOperationsComplete();
      if (this.#operations.length > decoded.operations.length) {
        throw streamError("present-ui.operation-mismatch", "Streamed operations exceed the completed proposal.");
      }
      for (const [index, operation] of this.#operations.entries()) {
        if (canonicalStringify(operation) !== canonicalStringify(decoded.operations[index])) {
          throw streamError(
            "present-ui.operation-mismatch",
            `Streamed operation ${index + 1} differs from the completed proposal.`,
          );
        }
      }
      if (this.#deltaCount > 0 && this.#operations.length !== decoded.operations.length) {
        throw streamError(
          "present-ui.partial-tail",
          "The completed proposal contains an operation that was not complete in the tool-input stream.",
        );
      }
      for (const operation of decoded.operations.slice(this.#operations.length)) {
        const outcome = await this.#turn.pushDecodedOperation(operation);
        if (outcome) {
          this.#outcome = outcome;
          return outcome;
        }
      }
      this.#outcome = await this.#turn.finishDecodedOperations();
      return this.#outcome;
    } catch (error) {
      return this.#reject(error);
    }
  }

  async #reject(error: unknown): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    this.#outcome = await this.#turn.cancel("rejected", ...errorDiagnostics(error));
    return this.#outcome;
  }
}

export function createIncrementalPresentUiCompilerSession(
  options: IncrementalPresentUiCompilerSessionOptions,
): IncrementalPresentUiCompilerSession {
  return new IncrementalPresentUiCompilerSession(options);
}

class IncrementalOperationArrayFramer {
  readonly #maxInputBytes: number;
  readonly #maxOperations: number;
  readonly #containers: Array<"array" | "object"> = [];
  #buffer = "";
  #position = 0;
  #inputBytes = 0;
  #inString = false;
  #escaped = false;
  #stringStart = -1;
  #rootStringCandidate?: string;
  #awaitingOperationsArray = false;
  #operationsArrayDepth?: number;
  #operationsArrayState: "value-or-end" | "value-after-comma" | "comma-or-end" = "value-or-end";
  #operationStart?: number;
  #operationsClosed = false;
  #operationCount = 0;

  constructor(maxInputBytes: number, maxOperations: number) {
    this.#maxInputBytes = maxInputBytes;
    this.#maxOperations = maxOperations;
  }

  push(delta: string): string[] {
    this.#inputBytes += utf8Length(delta);
    if (this.#inputBytes > this.#maxInputBytes) {
      throw streamError("present-ui.input-too-large", "Streamed present_ui input exceeds the byte limit.");
    }
    this.#buffer += delta;
    const frames: string[] = [];
    while (this.#position < this.#buffer.length) {
      const character = this.#buffer[this.#position]!;
      if (this.#inString) {
        if (this.#escaped) {
          this.#escaped = false;
        } else if (character === "\\") {
          this.#escaped = true;
        } else if (character === "\"") {
          this.#inString = false;
          if (
            this.#containers.length === 1
            && this.#containers[0] === "object"
            && this.#operationStart === undefined
          ) {
            this.#rootStringCandidate = decodeRootString(
              this.#buffer.slice(this.#stringStart, this.#position + 1),
            );
          }
        }
        this.#position += 1;
        continue;
      }

      if (this.#rootStringCandidate !== undefined && !isWhitespace(character)) {
        const candidate = this.#rootStringCandidate;
        this.#rootStringCandidate = undefined;
        if (character === ":") {
          if (candidate === "operations") {
            if (this.#operationsArrayDepth !== undefined || this.#operationsClosed || this.#awaitingOperationsArray) {
              throw streamError("present-ui.duplicate-operations", "present_ui input contains duplicate operations keys.");
            }
            this.#awaitingOperationsArray = true;
          }
          this.#position += 1;
          continue;
        }
      }

      if (this.#awaitingOperationsArray) {
        if (isWhitespace(character)) {
          this.#position += 1;
          continue;
        }
        if (character !== "[") {
          throw streamError("present-ui.operations-not-array", "present_ui operations must be a JSON array.");
        }
        this.#containers.push("array");
        this.#operationsArrayDepth = this.#containers.length;
        this.#awaitingOperationsArray = false;
        this.#position += 1;
        continue;
      }

      if (character === "\"") {
        this.#inString = true;
        this.#escaped = false;
        this.#stringStart = this.#position;
        this.#position += 1;
        continue;
      }

      if (
        this.#operationsArrayDepth !== undefined
        && !this.#operationsClosed
        && this.#containers.length === this.#operationsArrayDepth
      ) {
        if (isWhitespace(character)) {
          this.#position += 1;
          continue;
        }
        if (character === ",") {
          if (this.#operationsArrayState !== "comma-or-end") {
            throw streamError("present-ui.operations-comma-invalid", "present_ui operations contains an invalid comma.");
          }
          this.#operationsArrayState = "value-after-comma";
          this.#position += 1;
          continue;
        }
        if (character === "]") {
          if (this.#operationsArrayState === "value-after-comma") {
            throw streamError("present-ui.operations-trailing-comma", "present_ui operations cannot end with a trailing comma.");
          }
          this.#closeContainer("array");
          this.#operationsClosed = true;
          this.#position += 1;
          continue;
        }
        if (character !== "{" || this.#operationsArrayState === "comma-or-end") {
          throw streamError("present-ui.operation-frame-invalid", "Every present_ui operation must be a JSON object.");
        }
        this.#operationStart = this.#position;
        this.#containers.push("object");
        this.#position += 1;
        continue;
      }

      if (character === "{") {
        this.#containers.push("object");
        this.#assertDepth();
      } else if (character === "[") {
        this.#containers.push("array");
        this.#assertDepth();
      } else if (character === "}" || character === "]") {
        this.#closeContainer(character === "}" ? "object" : "array");
        if (
          character === "}"
          && this.#operationStart !== undefined
          && this.#operationsArrayDepth !== undefined
          && this.#containers.length === this.#operationsArrayDepth
        ) {
          frames.push(this.#buffer.slice(this.#operationStart, this.#position + 1));
          this.#operationStart = undefined;
          this.#operationCount += 1;
          if (this.#operationCount > this.#maxOperations) {
            throw streamError("present-ui.operation-limit", "present_ui operation count exceeds the frozen limit.");
          }
          this.#operationsArrayState = "comma-or-end";
        }
      }
      this.#position += 1;
    }
    return frames;
  }

  assertOperationsComplete(): void {
    if (
      this.#operationsArrayDepth === undefined
      || !this.#operationsClosed
      || this.#operationStart !== undefined
      || this.#inString
    ) {
      throw streamError("present-ui.partial-tail", "present_ui tool-input ended with an incomplete operations tail.");
    }
  }

  #closeContainer(expected: "array" | "object"): void {
    if (this.#containers.pop() !== expected) {
      throw streamError("present-ui.json-structure-invalid", "present_ui tool-input has mismatched JSON containers.");
    }
  }

  #assertDepth(): void {
    if (this.#containers.length > DEFAULT_PROTOCOL_LIMITS.maxDepth) {
      throw streamError("present-ui.max-depth", "present_ui tool-input exceeds the maximum JSON depth.");
    }
  }
}

async function decodeStreamedOperation(frame: string): Promise<ProposalOperationEnvelope> {
  const value = decodeJson(frame, jsonObjectSchema, { maxBytes: DEFAULT_PROTOCOL_LIMITS.maxFrameBytes });
  const keys = Object.keys(value).sort();
  if (canonicalStringify(keys) !== canonicalStringify(["dependsOn", "operation", "operationId", "sequence"])) {
    throw streamError(
      "present-ui.operation-shape-invalid",
      "A streamed operation must contain exactly operationId, sequence, dependsOn, and operation.",
    );
  }
  const payloadHash = await hashCanonical(HASH_DOMAINS.operationPayload, value.operation);
  const parsed = proposalOperationEnvelopeSchema.safeParse({ ...value, payloadHash });
  if (!parsed.success) {
    throw streamError("present-ui.operation-invalid", parsed.error.issues[0]?.message ?? "Streamed operation is invalid.");
  }
  const authoring = {
    operationId: parsed.data.operationId,
    sequence: parsed.data.sequence,
    dependsOn: parsed.data.dependsOn,
    operation: parsed.data.operation,
  };
  if (canonicalStringify(authoring) !== canonicalStringify(value)) {
    throw streamError(
      "present-ui.operation-transformation-forbidden",
      "Streamed operation validation must not add defaults, coerce, or transform canonical input.",
    );
  }
  return parsed.data;
}

function decodeRootString(input: string): string {
  try {
    const value = JSON.parse(input) as unknown;
    if (typeof value === "string") return value;
  } catch {
    // The strict full decoder will provide the final diagnostic.
  }
  throw streamError("present-ui.root-key-invalid", "present_ui contains an invalid root object key.");
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}

function streamError(code: string, message: string): ProtocolError {
  return new ProtocolError(diagnostic({
    phase: "decode",
    code,
    message,
    recoverable: false,
    modelCorrectable: true,
  }));
}

function errorDiagnostics(error: unknown): Diagnostic[] {
  if (error instanceof ProtocolError) return [...error.diagnostics];
  return [diagnostic({
    phase: "decode",
    code: "present-ui.incremental-input-failed",
    message: error instanceof Error ? error.message : "Incremental present_ui input failed.",
    recoverable: false,
    modelCorrectable: false,
  })];
}
