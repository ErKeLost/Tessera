import type {
  ClaimBinding,
  ClientResourceBinding,
  ClientResourceDataEnvelope,
  ClientResourceResolutionReceipt,
  Diagnostic,
  EvidenceReference,
  JsonValue,
  ResourceReference,
} from "@data-elements/runtime";

export type JsonSchema = boolean | Record<string, JsonValue>;
export type Sensitivity = ResourceReference["sensitivity"];
export type SchemaProfileBinding = {
  profileId: "data-elements.schema-core";
  profileVersion: number;
  profileHash: string;
};

export type ResourceActorContext = {
  tenantRef: string;
  actorRef: string;
  actorContextRef: string;
  allowedScopeRefs: string[];
  allowedSensitivity: Sensitivity[];
};

export type ResourceResolveRequest = {
  requestId: string;
  contractFingerprint: string;
  documentId: string;
  branchId: string;
  revisionId: string;
  resourceId: string;
  expectedSchemaHash: string;
  expectedContentHash: string;
};

export type ResourceResolutionStatus = "resolved" | "expired" | "denied" | "invalid" | "unavailable";
export type ResourceResolutionReceipt = {
  resolutionId: string;
  requestId: string;
  resourceId: string;
  schemaVersion: number;
  schemaHash: string;
  contentHash: string;
  status: ResourceResolutionStatus;
  evidenceIds?: string[];
  diagnostic?: Diagnostic;
  auditRef: string;
};

export type CommittedResourceContext = {
  contractFingerprint: string;
  reference: ResourceReference;
  evidence: Record<string, EvidenceReference>;
  claims: Record<string, ClaimBinding>;
  nodes: Record<string, { evidence?: string[] }>;
};

export type RegisteredResourceSchema = {
  schemaId: string;
  schemaVersion: number;
  schemaHash: string;
  schemaProfile: SchemaProfileBinding;
  schema: JsonSchema;
};

export type ResourceSourceOutput = {
  bytes: Uint8Array;
  codec: { id: string; version: string };
  mediaType: string;
  scopeRef: string;
  sensitivity: Sensitivity;
  evidenceIds: string[];
};

export interface CommittedResourceStorePort {
  getCommittedResource(input: {
    documentId: string;
    branchId: string;
    revisionId: string;
    resourceId: string;
  }): Promise<CommittedResourceContext | undefined>;
}

export interface ResourceAuthorizationPort {
  authorize(input: {
    actor: ResourceActorContext;
    request: ResourceResolveRequest;
    context: CommittedResourceContext;
    phase: "resolve" | "deliver";
  }): Promise<{ allowed: boolean; reasonCodes: string[] }>;
}

export interface ResourceSchemaRegistryPort {
  get(schemaId: string, schemaVersion: number): Promise<RegisteredResourceSchema | undefined>;
}

export interface ResourceSourcePort {
  resolve(input: {
    reference: ResourceReference;
    actor: ResourceActorContext;
    signal: AbortSignal;
  }): Promise<ResourceSourceOutput>;
}

export interface ResourceCodecPort {
  decode(codec: { id: string; version: string }, bytes: Uint8Array): Promise<unknown>;
}

export interface ResourceRedactionPort {
  sanitize(input: {
    value: JsonValue;
    reference: ResourceReference;
    source: ResourceSourceOutput;
    actor: ResourceActorContext;
  }): Promise<{ value: JsonValue; scopeRef: string; sensitivity: Sensitivity; validationIds: string[] }>;
}

export type StoredResourceResolution = {
  payloadHash: string;
  actor: ResourceActorContext;
  request: ResourceResolveRequest;
  status: "pending" | "completed";
  receipt?: ResourceResolutionReceipt;
  createdAt: string;
};

export type ResourceResolutionClaim =
  | { status: "claimed"; record: StoredResourceResolution }
  | { status: "pending" | "replayed" | "conflict"; record: StoredResourceResolution };

export interface ResourceResolutionStorePort {
  claim(record: StoredResourceResolution): Promise<ResourceResolutionClaim>;
  complete(identity: { tenantRef: string; actorRef: string; requestId: string }, payloadHash: string, receipt: ResourceResolutionReceipt): Promise<void>;
  get(identity: { tenantRef: string; actorRef: string; requestId: string }): Promise<StoredResourceResolution | undefined>;
}

export type ScopedBindingCacheEntry = {
  cacheKey: string;
  binding: ClientResourceBinding;
  request: ResourceResolveRequest;
  tenantRef: string;
  actorRef: string;
  expiresAt?: string;
};

export interface ScopedResourceBindingCachePort {
  get(cacheKey: string): Promise<ScopedBindingCacheEntry | undefined>;
  put(entry: ScopedBindingCacheEntry): Promise<void>;
  delete(cacheKey: string): Promise<void>;
  evictActor(tenantRef: string, actorRef: string): Promise<void>;
  evictRevision(documentId: string, revisionId: string): Promise<void>;
}

export type ResourceResolverPorts = {
  documents: CommittedResourceStorePort;
  authorization: ResourceAuthorizationPort;
  schemas: ResourceSchemaRegistryPort;
  source: ResourceSourcePort;
  codec: ResourceCodecPort;
  redaction: ResourceRedactionPort;
  resolutions: ResourceResolutionStorePort;
  cache: ScopedResourceBindingCachePort;
};

export type ResourceControlResult = {
  receipt: ClientResourceResolutionReceipt;
  replayed: boolean;
};

export type ResourceDataResult = ClientResourceDataEnvelope;

export type EvidenceValidationInput = {
  resources: Record<string, ResourceReference>;
  evidence: Record<string, EvidenceReference>;
  claims: Record<string, ClaimBinding>;
  nodes: Record<string, { evidence?: string[] }>;
  actor?: ResourceActorContext;
  grantedEvidenceIds?: readonly string[];
  causalValidationIds?: readonly string[];
  now?: string;
};

export type EvidenceValidationResult = {
  valid: boolean;
  diagnostics: Diagnostic[];
};
