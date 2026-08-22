import {
  HASH_DOMAINS,
  canonicalStringify,
  hashCanonical,
  stateRevisionIdSchema,
  stateValueSnapshotSchema,
  stateWriteReceiptSchema,
  stateWriteRequestSchema,
  type HashProvider,
  type JsonValue,
  type StateDefinition,
  type StateValueSnapshot,
  type StateWriteReceipt,
  type StateWriteRequest,
} from "@open-generative/protocol";
import { z } from "zod";
import type { AuthorityContext } from "./authority";

export type DocumentStatePolicyDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; code: string; message: string }>;

export interface DocumentStatePolicy {
  authorize(input: Readonly<{
    request: StateWriteRequest;
    definition: Extract<StateDefinition, { scope: "document" }>;
    current: StateValueSnapshot;
    authority: AuthorityContext;
  }>): Promise<DocumentStatePolicyDecision>;
}

export type DocumentStateWriteResult =
  | Readonly<{
    status: "written" | "replayed";
    state: StateValueSnapshot;
    receipt: StateWriteReceipt;
  }>
  | Readonly<{
    status: "conflict" | "denied";
    code: string;
    message: string;
  }>;

export interface DocumentStateWriter {
  write(input: Readonly<{
    request: StateWriteRequest;
    definition: Extract<StateDefinition, { scope: "document" }>;
    current: StateValueSnapshot;
    authority: AuthorityContext;
  }>): Promise<DocumentStateWriteResult>;
}

type StoredWrite = Readonly<{
  requestHash: string;
  result: Extract<DocumentStateWriteResult, { status: "written" | "replayed" }>;
}>;

export class InMemoryDocumentStateWriter implements DocumentStateWriter {
  readonly #policy: DocumentStatePolicy;
  readonly #now: () => Date;
  readonly #hashProvider?: HashProvider;
  readonly #state = new Map<string, StateValueSnapshot>();
  readonly #writes = new Map<string, StoredWrite>();

  constructor(input: Readonly<{
    policy: DocumentStatePolicy;
    now?: () => Date;
    hashProvider?: HashProvider;
  }>) {
    this.#policy = input.policy;
    this.#now = input.now ?? (() => new Date());
    this.#hashProvider = input.hashProvider;
  }

  async write(input: Readonly<{
    request: StateWriteRequest;
    definition: Extract<StateDefinition, { scope: "document" }>;
    current: StateValueSnapshot;
    authority: AuthorityContext;
  }>): Promise<DocumentStateWriteResult> {
    const request = stateWriteRequestSchema.parse(input.request);
    const current = stateValueSnapshotSchema.parse(input.current);
    if (
      current.stateId !== request.stateId
      || current.scope !== "document"
      || current.schemaHash !== input.definition.schemaHash
    ) return denied("state.current-mismatch", "Current document state does not match its committed definition.", "conflict");
    const requestHash = await hashCanonical(HASH_DOMAINS.hostCommandPayload, request, this.#hashProvider);
    const writeKey = `${request.surfaceSessionId}\0${request.requestId}`;
    const previousWrite = this.#writes.get(writeKey);
    if (previousWrite) {
      if (previousWrite.requestHash !== requestHash) {
        return denied("state.request-id-reused", "State request ID was reused with different content.", "conflict");
      }
      return {
        status: "replayed",
        state: structuredClone(previousWrite.result.state),
        receipt: structuredClone(previousWrite.result.receipt),
      };
    }
    const key = `${request.documentId}\0${request.stateId}`;
    const stored = this.#state.get(key);
    const authoritative = stored ?? current;
    if (
      request.expectedStateRevisionId !== authoritative.stateRevisionId
      || request.expectedStateRevisionId !== current.stateRevisionId
    ) return denied("state.revision-conflict", "Document state revision precondition does not match.", "conflict");
    const parsedValue = z.fromJSONSchema(input.definition.schema).safeParse(request.value);
    if (!parsedValue.success) return denied("state.value-invalid", "Document state value failed its exact schema.", "denied");
    if (canonicalStringify(parsedValue.data) !== canonicalStringify(request.value)) {
      return denied(
        "state.value-transformation-forbidden",
        "Document state validation must not add defaults, coerce, or transform the canonical request value.",
        "denied",
      );
    }
    const policy = await this.#policy.authorize({ request, definition: input.definition, current, authority: input.authority });
    if (!policy.allowed) return denied(policy.code, policy.message, "denied");

    const raced = this.#state.get(key);
    if (raced && raced.stateRevisionId !== authoritative.stateRevisionId) {
      return denied("state.revision-conflict", "Document state changed during authorization.", "conflict");
    }
    const value = request.value as JsonValue;
    const [stateRevisionId, valueHash] = await Promise.all([
      hashCanonical(HASH_DOMAINS.operationPayload, {
        kind: "document-state-write",
        documentId: request.documentId,
        stateId: request.stateId,
        fromStateRevisionId: authoritative.stateRevisionId,
        requestId: request.requestId,
        value,
      }, this.#hashProvider).then((hash) => stateRevisionIdSchema.parse(hash)),
      hashCanonical(HASH_DOMAINS.operationPayload, value, this.#hashProvider),
    ]);
    const state = stateValueSnapshotSchema.parse({
      stateId: request.stateId,
      stateRevisionId,
      schemaHash: input.definition.schemaHash,
      scope: "document",
      value,
    });
    const receipt = stateWriteReceiptSchema.parse({
      requestId: request.requestId,
      stateId: request.stateId,
      fromStateRevisionId: authoritative.stateRevisionId,
      toStateRevisionId: state.stateRevisionId,
      schemaHash: state.schemaHash,
      valueHash,
      recordedAt: this.#now().toISOString(),
    });
    const result = { status: "written" as const, state, receipt };
    const finalState = this.#state.get(key);
    if (finalState && canonicalStringify(finalState) !== canonicalStringify(authoritative)) {
      return denied("state.revision-conflict", "Document state changed before commit.", "conflict");
    }
    this.#state.set(key, structuredClone(state));
    this.#writes.set(writeKey, { requestHash, result: structuredClone(result) });
    return result;
  }
}

function denied(
  code: string,
  message: string,
  status: "conflict" | "denied",
): Extract<DocumentStateWriteResult, { status: "conflict" | "denied" }> {
  return { status, code, message };
}
