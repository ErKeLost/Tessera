export const ARTIFACT_PROTOCOL = "data-elements.artifact" as const;
export const ARTIFACT_PROTOCOL_VERSION = "2.0" as const;
export const BOOTSTRAP_PROTOCOL = "data-elements.bootstrap/1" as const;
export const STREAM_PROTOCOL = "data-elements.stream/2.0" as const;
export const RESOURCE_PROTOCOL = "data-elements.resource/1.0" as const;

export const DEFAULT_PROTOCOL_LIMITS = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxNodes: 1_000,
  maxDepth: 64,
  maxStringBytes: 256 * 1024,
  maxCollectionItems: 10_000,
  maxObjectKeys: 2_000,
  maxTotalValues: 100_000,
  maxResolvedResourceBytes: 2 * 1024 * 1024,
  maxConcurrentResourceRequests: 8,
  maxSnapshotReceipts: 1_000,
  maxOperationsPerTransaction: 10_000,
  maxBufferedGapFrames: 64,
  maxBufferedGapBytes: 2 * 1024 * 1024,
  maxBufferedGapMs: 10_000,
  transactionTimeoutMs: 60_000,
});

export const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
