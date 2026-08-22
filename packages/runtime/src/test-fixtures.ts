import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  canonicalOperationEnvelopeSchema,
  committedRevisionSchema,
  documentContentSchema,
  hashCanonical,
  hashDocumentContent,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
  surfaceSnapshotSchema,
  type CanonicalEntityOperation,
  type CanonicalOperationEnvelope,
  type CommittedRevision,
  type DocumentContent,
  type OperationId,
  type RevisionId,
  type SurfaceEventEnvelope,
  type SurfaceEventPayload,
  type SurfaceSnapshot,
  type TransactionId,
} from "@open-generative/protocol";
import { computeEntityRevisionIndex } from "./document-operations";
import type { StoredRevision } from "./store";
import type { RuntimeValidationPort } from "./validation";

export function testHash(character = "a") {
  return sha256HashSchema.parse(`sha256:${character.repeat(64)}`);
}

export function createDocumentContent(): DocumentContent {
  return documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [{
        publisher: "open-generative",
        catalogId: "official",
        catalogRevision: "2026-08-22",
        manifestHash: testHash("1"),
      }],
      contractSetHash: testHash("2"),
    },
    requirements: {
      dataClassifications: [],
      evidence: "none",
      placements: [],
      capabilities: [],
    },
    rootNodeId: "root",
    nodes: {
      root: {
        contract: {
          publisher: "open-generative",
          catalogId: "official",
          componentType: "layout.stack",
          revision: 1,
          contractHash: testHash("3"),
        },
        props: { gap: { kind: "literal", value: "md" } },
        slots: {},
        events: {},
        evidence: [],
      },
    },
    stateDefinitions: {},
    actions: {},
    resourceBindings: {},
    evidenceBindings: {},
    claims: {},
    meta: { title: "Test surface", tags: [] },
  });
}

export async function createCommittedRevision(input: {
  revisionId?: string;
  parentRevisionIds?: string[];
  documentId?: string;
  content?: DocumentContent;
} = {}): Promise<CommittedRevision> {
  const content = input.content ?? createDocumentContent();
  return committedRevisionSchema.parse({
    envelope: {
      documentId: input.documentId ?? "document-test",
      revisionId: input.revisionId ?? "revision-base",
      parentRevisionIds: input.parentRevisionIds ?? [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00Z",
      createdBy: "audit-test",
    },
    content,
  });
}

export async function createStoredRevision(input: {
  revisionId?: string;
  parentRevisionIds?: string[];
  documentId?: string;
  content?: DocumentContent;
} = {}): Promise<StoredRevision> {
  const revision = await createCommittedRevision(input);
  return {
    revision,
    entityRevisions: await computeEntityRevisionIndex(revision.content),
  };
}

export async function createOperationEnvelope(input: {
  transactionId?: TransactionId | string;
  operationId: OperationId | string;
  sequence: number;
  dependsOn?: Array<OperationId | string>;
  operation: CanonicalEntityOperation;
}): Promise<CanonicalOperationEnvelope> {
  return canonicalOperationEnvelopeSchema.parse({
    transactionId: input.transactionId ?? "transaction-test",
    operationId: input.operationId,
    sequence: input.sequence,
    dependsOn: input.dependsOn ?? [],
    payloadHash: await hashCanonical(HASH_DOMAINS.operationPayload, input.operation),
    operation: input.operation,
  });
}

export const acceptingValidationPort: RuntimeValidationPort = {
  validateNode: () => [],
  validateDocument: () => [],
  commitPolicy: () => "progressive",
  isNodeReady: () => true,
};

export function createSurfaceSnapshot(revision: CommittedRevision): SurfaceSnapshot {
  return surfaceSnapshotSchema.parse({
    revision,
    state: {},
    resources: {},
    resourceResolutionIdentities: {},
    actions: {},
    approvals: [],
  });
}

export async function createSurfaceEvent(input: {
  payload: SurfaceEventPayload;
  sequence: number;
  committedRevisionId: RevisionId | string;
  eventId?: string;
  epoch?: number;
  streamId?: string;
  surfaceSessionId?: string;
  contractSetHash?: ReturnType<typeof testHash>;
}): Promise<SurfaceEventEnvelope> {
  return surfaceEventEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: input.surfaceSessionId ?? "surface-test",
    streamId: input.streamId ?? "stream-test",
    epoch: input.epoch ?? 1,
    sequence: input.sequence,
    eventId: input.eventId ?? `event-${input.epoch ?? 1}-${input.sequence}`,
    cursor: `cursor-opaque-${String(input.epoch ?? 1).padStart(4, "0")}-${String(input.sequence).padStart(4, "0")}`,
    committedRevisionId: input.committedRevisionId,
    audienceBindingHash: testHash("8"),
    contractSetHash: input.contractSetHash ?? testHash("2"),
    correlationId: "correlation-test",
    payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, input.payload),
    payload: input.payload,
  });
}

export const defaultStreamPolicy = Object.freeze({
  maxSequenceGap: 8,
  maxBufferedBytes: 256_000,
  ackEveryEvents: 1,
  backpressure: "publish-snapshot" as const,
  cursorExpiresAt: "2026-08-23T00:00:00Z",
});
