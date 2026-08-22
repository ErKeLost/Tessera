export const OPEN_GENERATIVE_PROTOCOL_REVISION = "2026-08-22" as const;
export const OPEN_GENERATIVE_DOCUMENT_PROTOCOL = "open-generative.document" as const;
export const OPEN_GENERATIVE_PROPOSAL_STREAM_PROTOCOL = "open-generative.proposal-stream" as const;
export const OPEN_GENERATIVE_COMMIT_PROTOCOL = "open-generative.commit" as const;
export const OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL = "open-generative.surface-stream" as const;
export const OPEN_GENERATIVE_HOST_COMMAND_PROTOCOL = "open-generative.host-command" as const;

export type ProtocolRevision = typeof OPEN_GENERATIVE_PROTOCOL_REVISION;

export const OPEN_GENERATIVE_HASH_PROFILE_ID = "open-generative.jcs-sha256.2026-08-22" as const;

export const HASH_DOMAINS = Object.freeze({
  documentContent: "open-generative.document-content\0",
  proposalStreamPayload: "open-generative.proposal-stream-payload\0",
  commitCommandPayload: "open-generative.commit-command-payload\0",
  surfaceEventPayload: "open-generative.surface-event-payload\0",
  hostCommandPayload: "open-generative.host-command-payload\0",
  operationPayload: "open-generative.operation-payload\0",
  componentContract: "open-generative.component-contract\0",
  actionContract: "open-generative.action-contract\0",
  catalogManifest: "open-generative.catalog-manifest\0",
  catalogSet: "open-generative.catalog-set\0",
  catalogSlice: "open-generative.catalog-slice\0",
  resourceOffer: "open-generative.resource-offer\0",
  evidenceOffer: "open-generative.evidence-offer\0",
  rendererCapabilityManifest: "open-generative.renderer-capability-manifest\0",
} as const);

export type HashDomain = (typeof HASH_DOMAINS)[keyof typeof HASH_DOMAINS];

export const DEFAULT_PROTOCOL_LIMITS = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxStringBytes: 256 * 1024,
  maxCollectionItems: 10_000,
  maxObjectKeys: 2_000,
  maxTotalValues: 100_000,
  maxNodes: 1_000,
  maxStateDefinitions: 256,
  maxActions: 256,
  maxResourceBindings: 256,
  maxEvidenceBindings: 1_000,
  maxClaims: 1_000,
  maxOperationsPerTransaction: 10_000,
  maxDependenciesPerOperation: 64,
  maxBufferedGapFrames: 64,
  maxBufferedGapBytes: 2 * 1024 * 1024,
  maxResolvedResourceBytes: 2 * 1024 * 1024,
  maxResourceWindowItems: 10_000,
  maxResourceWindowColumns: 256,
} as const);

export type ProtocolLimits = Readonly<{
  [TKey in keyof typeof DEFAULT_PROTOCOL_LIMITS]: number;
}>;

export const FORBIDDEN_OBJECT_KEYS = Object.freeze(new Set([
  "__proto__",
  "constructor",
  "prototype",
]));
