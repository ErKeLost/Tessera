import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_COMMIT_PROTOCOL,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  ProtocolError,
  commitCommandEnvelopeSchema,
  hashCanonical,
  type CommitCommandEnvelope,
  type CommitCommandPayload,
  type Diagnostic,
  type ProposalStreamEnvelope,
  type Sha256Hash,
  type ValidatedPreview,
} from "@open-generative/protocol";
import { ProposalStreamDecoder } from "./decoder";
import { diagnostic } from "./internal";
import { ProposalNormalizer } from "./normalize";
import type {
  CompilerTurnInput,
  CompilerTurnOutcome,
  DecodedAuthoringProposal,
  NormalizedCompilerOperation,
} from "./types";

export type CompilerTurnChunk = Uint8Array | string | unknown;

export class ProposalCompilerTurn {
  readonly #input: CompilerTurnInput;
  readonly #decoder: ProposalStreamDecoder;
  readonly #normalizer: ProposalNormalizer;
  readonly #commands: CommitCommandEnvelope[] = [];
  #started = false;
  #overlayHash?: Sha256Hash;
  #outcome?: CompilerTurnOutcome;

  constructor(input: CompilerTurnInput) {
    this.#input = input;
    this.#decoder = new ProposalStreamDecoder({
      transactionId: input.begin.transactionId,
      catalogSliceHash: input.catalog.slice.sliceHash,
      maxOperations: input.catalog.slice.limits.maxOperations,
      hashProvider: input.hashProvider,
    });
    this.#normalizer = new ProposalNormalizer({
      catalog: input.catalog,
      authority: input.authority,
      transactionId: input.begin.transactionId,
      baseDocument: input.baseDocument,
      baseEntityRevisions: input.baseEntityRevisions,
      writeScope: input.writeScope,
      identityAllocator: input.identityAllocator,
      hashProvider: input.hashProvider,
    });
  }

  get outcome(): CompilerTurnOutcome | undefined {
    return this.#outcome;
  }

  get commands(): readonly CommitCommandEnvelope[] {
    return [...this.#commands];
  }

  async start(): Promise<CompilerTurnOutcome | undefined> {
    if (this.#started) return this.#outcome;
    this.#started = true;
    const payload: CommitCommandPayload = {
      type: "begin",
      transactionId: this.#input.begin.transactionId,
      documentId: this.#input.begin.documentId,
      branchId: this.#input.begin.branchId,
      baseRevisionId: this.#input.begin.baseRevisionId,
      expectedHeadToken: this.#input.begin.expectedHeadToken,
      contractSetHash: this.#input.catalog.slice.contractSetHash,
      catalogSliceHash: this.#input.catalog.slice.sliceHash,
      authorityContextHash: this.#input.authorityContextHash,
      writeScopeHash: this.#input.writeScopeHash,
      createdBy: this.#input.begin.createdBy,
    };
    await this.#emit(payload);
    const result = await this.#input.runtime.begin(this.#input.begin);
    if ("transaction" in result) {
      this.#overlayHash = result.transaction.overlayHash;
      return undefined;
    }
    if (result.status === "conflict") {
      return this.#reject("conflict", runtimeDiagnostic("commit.begin-conflict", result.message));
    }
    if (result.status === "missing-base" || result.status === "rejected") {
      return this.#reject("rejected", runtimeDiagnostic(
        result.status === "missing-base" ? "commit.base-missing" : "commit.begin-rejected",
        result.message,
      ));
    }
    return this.#reject("rejected", runtimeDiagnostic("commit.begin-rejected", result.message));
  }

  async push(chunk: CompilerTurnChunk): Promise<CompilerTurnOutcome | undefined> {
    if (this.#outcome) return this.#outcome;
    try {
      const startOutcome = await this.start();
      if (startOutcome) return startOutcome;
      const envelopes = await this.#decoder.push(chunk);
      for (const envelope of envelopes) {
        const outcome = await this.#processEnvelope(envelope);
        if (outcome) return outcome;
      }
      return undefined;
    } catch (error) {
      return this.#fail(error);
    }
  }

  async finishInput(): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    try {
      const startOutcome = await this.start();
      if (startOutcome) return startOutcome;
      const envelopes = await this.#decoder.finishInput();
      for (const envelope of envelopes) {
        const outcome = await this.#processEnvelope(envelope);
        if (outcome) return outcome;
      }
      if (!this.#outcome) {
        throw new ProtocolError(diagnostic({
          phase: "commit",
          code: "compiler.turn-no-outcome",
          message: "Proposal stream reached a terminal frame without a compiler outcome.",
          recoverable: false,
        }));
      }
      return this.#outcome;
    } catch (error) {
      return this.#fail(error);
    }
  }

  async runDecoded(proposal: Exclude<DecodedAuthoringProposal, { kind: "abort" }>): Promise<CompilerTurnOutcome> {
    if (this.#outcome) return this.#outcome;
    try {
      const startOutcome = await this.start();
      if (startOutcome) return startOutcome;
      if (proposal.kind === "snapshot") {
        const normalized = await this.#normalizer.normalizeSnapshot(proposal.proposal);
        for (const operation of normalized.operations) {
          const outcome = await this.#apply(operation);
          if (outcome) return outcome;
        }
      } else {
        for (const operation of proposal.operations) {
          const normalized = await this.#normalizer.normalizeOperation(operation);
          const outcome = await this.#apply(normalized);
          if (outcome) return outcome;
        }
      }
      return this.#finalize();
    } catch (error) {
      return this.#fail(error);
    }
  }

  async #processEnvelope(envelope: ProposalStreamEnvelope): Promise<CompilerTurnOutcome | undefined> {
    const payload = envelope.payload;
    if (payload.type === "snapshot") {
      const normalized = await this.#normalizer.normalizeSnapshot(payload.proposal);
      for (const operation of normalized.operations) {
        const outcome = await this.#apply(operation);
        if (outcome) return outcome;
      }
      return undefined;
    }
    if (payload.type === "entity-operation") {
      return this.#apply(await this.#normalizer.normalizeOperation(payload.operation));
    }
    if (payload.type === "abort") {
      return this.#abort(payload.reason === "cancelled" ? "cancelled" : payload.reason === "timeout" ? "timeout" : "rejected");
    }
    return this.#finalize();
  }

  async #apply(operation: NormalizedCompilerOperation): Promise<CompilerTurnOutcome | undefined> {
    await this.#emit({ type: "apply", operation: operation.envelope });
    const result = await this.#input.runtime.apply(operation.envelope, operation.identityMapDelta);
    if (result.status === "rejected") {
      return this.#abort("rejected", runtimeDiagnostic("commit.apply-rejected", result.message));
    }
    if (result.status === "conflict") {
      return this.#abort("conflict", runtimeDiagnostic("commit.apply-conflict", result.message));
    }
    if (result.status === "accepted") {
      for (const preview of result.previews) await this.#publishPreview(preview);
    }
    return undefined;
  }

  async #publishPreview(preview: ValidatedPreview): Promise<void> {
    this.#overlayHash = preview.overlayHash;
    await this.#input.onPreview?.(preview);
  }

  async #finalize(): Promise<CompilerTurnOutcome> {
    const normalized = await this.#normalizer.finalize();
    const payload: CommitCommandPayload = {
      type: "finalize",
      transactionId: this.#input.begin.transactionId,
      finalOperationSequence: normalized.finalOperationSequence,
      ...(this.#overlayHash === undefined ? {} : { expectedOverlayHash: this.#overlayHash }),
      expectedContentHash: normalized.contentHash,
    };
    await this.#emit(payload);
    const result = await this.#input.runtime.finalize({
      transactionId: this.#input.begin.transactionId,
      finalOperationSequence: normalized.finalOperationSequence,
      expectedContentHash: normalized.contentHash,
      ...(this.#overlayHash === undefined ? {} : { expectedOverlayHash: this.#overlayHash }),
    });
    if ("revision" in result) {
      this.#outcome = {
        status: "committed",
        revisionId: result.revision.envelope.revisionId,
        contentHash: result.revision.envelope.contentHash,
        commands: [...this.#commands],
      };
      return this.#outcome;
    }
    const diagnostics = result.issues.map((issue) => runtimeDiagnostic(issue.code, issue.message));
    return this.#reject(result.status === "conflict" ? "conflict" : "rejected", ...diagnostics);
  }

  async #abort(
    reason: "rejected" | "timeout" | "cancelled" | "conflict" | "internal-error",
    ...diagnostics: Diagnostic[]
  ): Promise<CompilerTurnOutcome> {
    if (!this.#outcome) {
      await this.#emit({ type: "abort", transactionId: this.#input.begin.transactionId, reason });
      await this.#input.runtime.abort(this.#input.begin.transactionId, `compiler.${reason}`);
      await this.#input.identityAllocator.retire?.(this.#input.begin.transactionId);
      this.#outcome = {
        status: reason === "conflict" ? "conflict" : "aborted",
        commands: [...this.#commands],
        diagnostics: diagnostics.length > 0
          ? diagnostics
          : [runtimeDiagnostic(`commit.${reason}`, `Compiler transaction ended with ${reason}.`)],
      };
    }
    return this.#outcome;
  }

  async #fail(error: unknown): Promise<CompilerTurnOutcome> {
    const diagnostics = error instanceof ProtocolError
      ? [...error.diagnostics]
      : [diagnostic({
        phase: "commit",
        code: "compiler.internal-error",
        message: error instanceof Error ? error.message : "Unknown compiler failure.",
        recoverable: false,
        modelCorrectable: false,
      })];
    try {
      return await this.#abort(error instanceof ProtocolError ? "rejected" : "internal-error", ...diagnostics);
    } catch (abortError) {
      this.#outcome = {
        status: "rejected",
        commands: [...this.#commands],
        diagnostics: [
          ...diagnostics,
          diagnostic({
            phase: "commit",
            code: "compiler.abort-failed",
            message: abortError instanceof Error ? abortError.message : "Compiler abort failed.",
            recoverable: false,
            modelCorrectable: false,
          }),
        ],
      };
      return this.#outcome;
    }
  }

  #reject(
    status: "rejected" | "conflict",
    ...diagnostics: Diagnostic[]
  ): CompilerTurnOutcome {
    this.#outcome = { status, commands: [...this.#commands], diagnostics };
    return this.#outcome;
  }

  async #emit(payload: CommitCommandPayload): Promise<CommitCommandEnvelope> {
    const payloadHash = await hashCanonical(HASH_DOMAINS.commitCommandPayload, payload, this.#input.hashProvider);
    const envelope = commitCommandEnvelopeSchema.parse({
      protocol: OPEN_GENERATIVE_COMMIT_PROTOCOL,
      protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
      commandId: `commit-${payload.type}-${payloadHash.slice("sha256:".length, "sha256:".length + 32)}`,
      correlationId: this.#input.correlationId,
      payloadHash,
      payload,
    });
    await this.#input.onCommitCommand?.(envelope);
    this.#commands.push(envelope);
    return envelope;
  }
}

export async function compileProposalStream(
  input: CompilerTurnInput,
  chunks: AsyncIterable<CompilerTurnChunk> | Iterable<CompilerTurnChunk>,
): Promise<CompilerTurnOutcome> {
  const turn = new ProposalCompilerTurn(input);
  for await (const chunk of chunks) {
    const outcome = await turn.push(chunk);
    if (outcome) return outcome;
  }
  return turn.finishInput();
}

function runtimeDiagnostic(code: string, message: string): Diagnostic {
  const normalizedCode = code.includes(".") ? code : `commit.${code}`;
  return diagnostic({
    phase: "commit",
    code: normalizedCode,
    message,
    recoverable: false,
    modelCorrectable: false,
  });
}
