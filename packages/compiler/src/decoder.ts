import {
  DEFAULT_PROTOCOL_LIMITS,
  HASH_DOMAINS,
  ProtocolError,
  authoringSnapshotProposalSchema,
  canonicalStringify,
  hashCanonical,
  proposalOperationEnvelopeSchema,
  proposalStreamEnvelopeSchema,
  verifyProposalStreamEnvelope,
  type AuthoringSnapshotProposal,
  type HashProvider,
  type ProposalOperationEnvelope,
  type ProposalStreamEnvelope,
  type Sha256Hash,
  type TransactionId,
} from "@open-generative/protocol";
import { diagnostic, utf8Length } from "./internal";
import { schemaIssueSummary, validateJsonSchema } from "./schema";
import type { CompiledPresentUi, DecodedAuthoringProposal } from "./types";

export type ProposalStreamDecoderOptions = Readonly<{
  transactionId: TransactionId;
  catalogSliceHash: Sha256Hash;
  maxFrameBytes?: number;
  maxOperations: number;
  hashProvider?: HashProvider;
}>;

export type ProposalMode =
  | { kind: "snapshot"; proposal: AuthoringSnapshotProposal }
  | { kind: "operations"; operations: ProposalOperationEnvelope[] };

export class ProposalStreamDecoder {
  readonly #options: Required<Pick<ProposalStreamDecoderOptions, "maxFrameBytes" | "maxOperations">>
    & Omit<ProposalStreamDecoderOptions, "maxFrameBytes" | "maxOperations">;
  readonly #messages = new Map<number, ProposalStreamEnvelope>();
  readonly #messageIds = new Map<string, number>();
  #nextSequence = 1;
  #textBuffer = "";
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });
  #byteStreamOpen = false;
  #terminal = false;
  #mode?: ProposalMode;
  #result?: DecodedAuthoringProposal;

  constructor(options: ProposalStreamDecoderOptions) {
    this.#options = {
      ...options,
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_PROTOCOL_LIMITS.maxFrameBytes,
      maxOperations: options.maxOperations,
    };
  }

  async push(input: Uint8Array | string | unknown): Promise<ProposalStreamEnvelope[]> {
    if (input instanceof Uint8Array) {
      this.#byteStreamOpen = true;
      return this.#pushText(this.#textDecoder.decode(input, { stream: true }));
    }
    if (typeof input === "string") {
      if (this.#byteStreamOpen) {
        const flushed = this.#textDecoder.decode();
        this.#byteStreamOpen = false;
        return this.#pushText(`${flushed}${input}`);
      }
      return this.#pushText(input);
    }
    return [await this.#accept(input)].filter((value): value is ProposalStreamEnvelope => value !== undefined);
  }

  async finishInput(): Promise<ProposalStreamEnvelope[]> {
    if (this.#byteStreamOpen) {
      this.#textBuffer += this.#textDecoder.decode();
      this.#byteStreamOpen = false;
    }
    const tail = this.#textBuffer.trim();
    this.#textBuffer = "";
    const output: ProposalStreamEnvelope[] = [];
    if (tail.length > 0) {
      const accepted = await this.#accept(parseFrame(tail, this.#options.maxFrameBytes));
      if (accepted) output.push(accepted);
    }
    if (!this.#terminal) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.missing-terminal",
        message: "Proposal stream ended before finish or abort.",
        recoverable: false,
      }));
    }
    return output;
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  get result(): DecodedAuthoringProposal | undefined {
    return this.#result;
  }

  async #pushText(chunk: string): Promise<ProposalStreamEnvelope[]> {
    this.#textBuffer += chunk;
    const lines = this.#textBuffer.split(/\r?\n/);
    this.#textBuffer = lines.pop() ?? "";
    if (utf8Length(this.#textBuffer) > this.#options.maxFrameBytes) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.frame-too-large",
        message: "Proposal stream frame exceeds the configured byte limit.",
        recoverable: false,
      }));
    }
    const output: ProposalStreamEnvelope[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const accepted = await this.#accept(parseFrame(line, this.#options.maxFrameBytes));
      if (accepted) output.push(accepted);
    }
    return output;
  }

  async #accept(input: unknown): Promise<ProposalStreamEnvelope | undefined> {
    const parsed = proposalStreamEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.invalid-envelope",
        message: "Proposal stream envelope does not match the canonical protocol schema.",
        path: parsed.error.issues[0] ? `/${parsed.error.issues[0]!.path.join("/")}` : "",
      }));
    }
    const envelope = parsed.data;
    if (envelope.transactionId !== this.#options.transactionId) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.transaction-mismatch",
        message: "Proposal stream transaction does not match the active compiler turn.",
        recoverable: false,
        modelCorrectable: false,
      }));
    }
    if (envelope.catalogSliceHash !== this.#options.catalogSliceHash) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.slice-mismatch",
        message: "Proposal stream was generated against a different frozen CatalogSetSlice.",
        recoverable: false,
        modelCorrectable: false,
      }));
    }
    if (!await verifyProposalStreamEnvelope(envelope, this.#options.hashProvider)) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.payload-hash-mismatch",
        message: "Proposal stream payload hash does not match its canonical payload.",
        recoverable: false,
      }));
    }

    const replay = this.#messages.get(envelope.sequence);
    if (replay) {
      if (canonicalStringify(replay) !== canonicalStringify(envelope)) {
        throw new ProtocolError(diagnostic({
          phase: "decode",
          code: "proposal-stream.sequence-conflict",
          message: "Proposal stream sequence was reused with different content.",
          recoverable: false,
        }));
      }
      return undefined;
    }
    if (this.#terminal) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.after-terminal",
        message: "Proposal stream cannot continue after finish or abort.",
        recoverable: false,
      }));
    }
    if (envelope.sequence !== this.#nextSequence) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.sequence-gap",
        message: "Proposal stream sequence must be contiguous and ordered.",
        expected: this.#nextSequence,
      }));
    }
    const priorMessageSequence = this.#messageIds.get(envelope.messageId);
    if (priorMessageSequence !== undefined) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.message-id-conflict",
        message: "Proposal stream message ID was reused at a different sequence.",
        recoverable: false,
      }));
    }

    await this.#acceptPayload(envelope);
    this.#messages.set(envelope.sequence, envelope);
    this.#messageIds.set(envelope.messageId, envelope.sequence);
    this.#nextSequence += 1;
    return envelope;
  }

  async #acceptPayload(envelope: ProposalStreamEnvelope): Promise<void> {
    const payload = envelope.payload;
    if (payload.type === "snapshot") {
      if (this.#mode) throw mixedModeError();
      this.#mode = { kind: "snapshot", proposal: payload.proposal };
      return;
    }
    if (payload.type === "entity-operation") {
      if (this.#mode?.kind === "snapshot") throw mixedModeError();
      const operation = payload.operation;
      const expectedHash = await hashCanonical(HASH_DOMAINS.operationPayload, operation.operation, this.#options.hashProvider);
      if (expectedHash !== operation.payloadHash) {
        throw new ProtocolError(diagnostic({
          phase: "authoring",
          code: "proposal-operation.payload-hash-mismatch",
          message: "Authoring operation payload hash does not match its operation.",
          path: "/payload/operation/payloadHash",
          recoverable: false,
        }));
      }
      const operations = this.#mode?.kind === "operations" ? this.#mode.operations : [];
      if (operations.length >= this.#options.maxOperations) {
        throw new ProtocolError(diagnostic({
          phase: "authoring",
          code: "proposal-operation.limit-exceeded",
          message: "Proposal operation count exceeds the frozen Slice limit.",
          recoverable: false,
        }));
      }
      operations.push(operation);
      this.#mode = { kind: "operations", operations };
      return;
    }
    if (payload.type === "abort") {
      this.#result = { kind: "abort", reason: payload.reason };
      this.#terminal = true;
      return;
    }
    if (!this.#mode) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.empty-finish",
        message: "Proposal stream cannot finish before a snapshot or operation.",
      }));
    }
    const expectedSequence = this.#mode.kind === "snapshot"
      ? 0
      : this.#mode.operations.at(-1)?.sequence ?? 0;
    if (payload.finalOperationSequence !== expectedSequence) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.final-sequence-mismatch",
        message: "Proposal finish sequence does not match the authoring operation stream.",
        expected: expectedSequence,
      }));
    }
    const expectedHash = await computeProposalHash(this.#mode, this.#options.hashProvider);
    if (payload.proposalHash !== expectedHash) {
      throw new ProtocolError(diagnostic({
        phase: "decode",
        code: "proposal-stream.proposal-hash-mismatch",
        message: "Proposal finish hash does not match the complete decoded proposal.",
        recoverable: false,
      }));
    }
    this.#result = this.#mode.kind === "snapshot"
      ? { kind: "snapshot", proposal: this.#mode.proposal }
      : { kind: "operations", operations: [...this.#mode.operations] };
    this.#terminal = true;
  }
}

export async function computeProposalHash(
  input: ProposalMode,
  hashProvider?: HashProvider,
): Promise<Sha256Hash> {
  return hashCanonical(
    HASH_DOMAINS.operationPayload,
    input.kind === "snapshot"
      ? { kind: "snapshot", proposal: input.proposal }
      : { kind: "operations", operations: input.operations },
    hashProvider,
  );
}

export async function decodePresentUiInput(
  compiled: Pick<CompiledPresentUi, "canonicalInputSchema">,
  input: unknown,
  hashProvider?: HashProvider,
): Promise<Exclude<DecodedAuthoringProposal, { kind: "abort" }>> {
  const result = validateJsonSchema(compiled.canonicalInputSchema, input);
  if (!result.success) {
    throw new ProtocolError(diagnostic({
      phase: "authoring",
      code: "present-ui.input-invalid",
      message: schemaIssueSummary(result),
    }));
  }
  if (!input || typeof input !== "object") {
    throw new ProtocolError(diagnostic({
      phase: "authoring",
      code: "present-ui.input-invalid",
      message: "present_ui input must be an object.",
    }));
  }
  const record = input as Record<string, unknown>;
  if (record.kind === "snapshot") {
    return { kind: "snapshot", proposal: authoringSnapshotProposalSchema.parse(input) };
  }
  const operations = (record.operations as unknown[]).map(async (candidate) => {
    const operation = candidate as Record<string, unknown>;
    return proposalOperationEnvelopeSchema.parse({
      operationId: operation.operationId,
      sequence: operation.sequence,
      dependsOn: operation.dependsOn,
      operation: operation.operation,
      payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, operation.operation, hashProvider),
    });
  });
  return { kind: "operations", operations: await Promise.all(operations) };
}

function parseFrame(input: string, maxFrameBytes: number): unknown {
  if (utf8Length(input) > maxFrameBytes) {
    throw new ProtocolError(diagnostic({
      phase: "decode",
      code: "proposal-stream.frame-too-large",
      message: "Proposal stream frame exceeds the configured byte limit.",
      recoverable: false,
    }));
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ProtocolError(diagnostic({
      phase: "decode",
      code: "proposal-stream.invalid-json",
      message: "Proposal stream frame is not valid JSON.",
    }));
  }
}

function mixedModeError(): ProtocolError {
  return new ProtocolError(diagnostic({
    phase: "authoring",
    code: "proposal-stream.mixed-authoring-mode",
    message: "A proposal stream cannot mix snapshot and entity-operation authoring.",
  }));
}
