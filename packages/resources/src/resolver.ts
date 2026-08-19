import {
  DEFAULT_PROTOCOL_LIMITS,
  RESOURCE_PROTOCOL,
  canonicalBytes,
  canonicalHash,
  canonicalize,
  clientResourceDataEnvelopeSchema,
  clientResourceResolutionReceiptSchema,
  createDiagnostic,
  type ClientResourceBinding,
  type ClientResourceDataEnvelope,
  type ClientResourceResolutionReceipt,
  type Diagnostic,
  type EvidenceReference,
  type ProtocolLimits,
  type ResourceReference,
} from "@data-elements/runtime";
import { z } from "zod";
import { validateEvidenceAndClaims } from "./evidence";
import {
  compileResourceSchema,
  parseResourceValue,
  ResourceSchemaError,
  type ResourceSchemaLimits,
} from "./schema";
import type {
  CommittedResourceContext,
  RegisteredResourceSchema,
  ResourceActorContext,
  ResourceControlResult,
  ResourceDataResult,
  ResourceResolveRequest,
  ResourceResolutionReceipt,
  ResourceResolutionStatus,
  ResourceResolverPorts,
  ResourceSourceOutput,
  SchemaProfileBinding,
  ScopedBindingCacheEntry,
  Sensitivity,
  StoredResourceResolution,
} from "./types";

const identifier = z.string().min(1).max(512);
const requestSchema = z.object({
  requestId: identifier,
  contractFingerprint: identifier,
  documentId: identifier,
  branchId: identifier,
  revisionId: identifier,
  resourceId: identifier,
  expectedSchemaHash: identifier,
  expectedContentHash: identifier,
}).strict();

export type ResourceResolverOptions = {
  ports: ResourceResolverPorts;
  schemaProfile: SchemaProfileBinding;
  schemaLimits?: Partial<ResourceSchemaLimits>;
  limits?: Partial<ProtocolLimits>;
  sourceTimeoutMs?: number;
  now?: () => string;
  idFactory?: (prefix: string) => string;
  auditRefFactory?: (requestId: string) => string;
};

export class ResourceResolverError extends Error {
  readonly diagnostic: Diagnostic;
  readonly retryable: boolean;

  constructor(diagnostic: Diagnostic, retryable = false) {
    super(diagnostic.message);
    this.name = "ResourceResolverError";
    this.diagnostic = diagnostic;
    this.retryable = retryable;
  }
}

type ValidatedResolution = {
  binding: ClientResourceBinding;
  evidenceIds: string[];
};

export class ResourceResolver {
  readonly #ports: ResourceResolverPorts;
  readonly #profile: SchemaProfileBinding;
  readonly #schemaLimits?: Partial<ResourceSchemaLimits>;
  readonly #limits: ProtocolLimits;
  readonly #sourceTimeoutMs: number;
  readonly #now: () => string;
  readonly #id: (prefix: string) => string;
  readonly #audit: (requestId: string) => string;
  readonly #schemas = new Map<string, Promise<z.ZodType>>();
  readonly #schemaIdentities = new Map<string, string>();

  constructor(options: ResourceResolverOptions) {
    this.#ports = options.ports;
    this.#profile = structuredClone(options.schemaProfile);
    this.#schemaLimits = options.schemaLimits;
    this.#limits = { ...DEFAULT_PROTOCOL_LIMITS, ...options.limits };
    this.#sourceTimeoutMs = options.sourceTimeoutMs ?? 30_000;
    this.#now = options.now ?? (() => new Date().toISOString());
    let sequence = 0;
    this.#id = options.idFactory ?? ((prefix) => `${prefix}:${++sequence}`);
    this.#audit = options.auditRefFactory ?? ((requestId) => `audit:resource:${requestId}`);
  }

  /** Control plane: returns only an immutable, replayable receipt. */
  async resolveControl(requestInput: ResourceResolveRequest, actorInput: ResourceActorContext): Promise<ResourceControlResult> {
    const request = requestSchema.parse(requestInput) as ResourceResolveRequest;
    const actor = validateActor(actorInput);
    const payloadHash = await canonicalHash(request);
    const pending: StoredResourceResolution = {
      payloadHash,
      actor,
      request,
      status: "pending",
      createdAt: this.#now(),
    };
    const claim = await this.#ports.resolutions.claim(pending);
    if (claim.status === "conflict") throw resolverError("resource.request-conflict", "Resource request identity was reused with different bytes.");
    if (claim.status === "pending") throw resolverError("resource.request-pending", "Resource resolution is already in progress.", true);
    if (claim.status === "replayed") {
      const receipt = claim.record.receipt!;
      if (receipt.status === "resolved") await this.#refreshReplayBinding(claim.record, receipt).catch(() => undefined);
      return { receipt: sanitizeResourceReceipt(receipt), replayed: true };
    }

    const context = await this.#ports.documents.getCommittedResource(request);
    if (!context) return this.#completeFailure(pending, request, "unavailable", "resource.not-found", "Resource is unavailable.");
    const reference = context.reference;
    if (
      context.contractFingerprint !== request.contractFingerprint
      || reference.resourceId !== request.resourceId
      || reference.schemaHash !== request.expectedSchemaHash
      || reference.contentHash !== request.expectedContentHash
    ) return this.#completeFailure(pending, request, "invalid", "resource.binding-mismatch", "Resource request does not match the committed revision.", reference);
    if (isExpired(reference.expiresAt, this.#now())) {
      return this.#completeFailure(pending, request, "expired", "resource.expired", "Resource expired.", reference);
    }
    const authorization = await this.#ports.authorization.authorize({ actor, request, context, phase: "resolve" });
    if (!authorization.allowed) return this.#completeFailure(pending, request, "denied", "resource.denied", "Resource access was denied.", reference);

    const resolutionId = this.#id("resource-resolution");
    try {
      const result = await this.#resolveValue(request, actor, context, resolutionId);
      const receipt: ResourceResolutionReceipt = {
        resolutionId,
        requestId: request.requestId,
        resourceId: reference.resourceId,
        schemaVersion: reference.schemaVersion,
        schemaHash: reference.schemaHash,
        contentHash: reference.contentHash,
        status: "resolved",
        evidenceIds: result.evidenceIds,
        auditRef: this.#audit(request.requestId),
      };
      await this.#cacheBinding(request, actor, reference, result.binding);
      await this.#ports.resolutions.complete(identity(actor, request.requestId), payloadHash, receipt);
      return { receipt: sanitizeResourceReceipt(receipt), replayed: false };
    } catch (error) {
      const classified = classifyResolutionFailure(error);
      return this.#completeFailure(pending, request, classified.status, classified.code, classified.message, reference, resolutionId);
    }
  }

  /** Data plane: returns one bounded transient envelope after fresh authorization. */
  async deliverData(input: {
    request: ResourceResolveRequest;
    resolutionId: string;
    actor: ResourceActorContext;
  }): Promise<ResourceDataResult> {
    const request = requestSchema.parse(input.request) as ResourceResolveRequest;
    const actor = validateActor(input.actor);
    const record = await this.#ports.resolutions.get(identity(actor, request.requestId));
    if (!record || canonicalize(record.request) !== canonicalize(request) || !record.receipt) {
      return unavailableEnvelope(request, undefined, "unavailable", true);
    }
    const receipt = record.receipt;
    if (receipt.resolutionId !== input.resolutionId || receipt.status !== "resolved") {
      return unavailableEnvelope(request, receipt.resolutionId, unavailableReason(receipt.status), receipt.status === "unavailable");
    }
    const context = await this.#ports.documents.getCommittedResource(request);
    if (!context || !matchesCommittedRequest(context, request, receipt)) {
      return unavailableEnvelope(request, receipt.resolutionId, "unavailable", false);
    }
    if (isExpired(context.reference.expiresAt, this.#now())) {
      await this.#ports.cache.delete(resourceBindingCacheKey(actor, request, context.reference));
      return unavailableEnvelope(request, receipt.resolutionId, "expired", false);
    }
    const authorized = await this.#ports.authorization.authorize({ actor, request, context, phase: "deliver" });
    if (!authorized.allowed) {
      await this.#ports.cache.delete(resourceBindingCacheKey(actor, request, context.reference));
      return unavailableEnvelope(request, receipt.resolutionId, "denied", false);
    }
    const key = resourceBindingCacheKey(actor, request, context.reference);
    let entry = await this.#ports.cache.get(key);
    if (!entry) {
      try {
        const refreshed = await this.#resolveValue(request, actor, context, receipt.resolutionId);
        await this.#cacheBinding(request, actor, context.reference, refreshed.binding);
        entry = await this.#ports.cache.get(key);
      } catch {
        return unavailableEnvelope(request, receipt.resolutionId, "unavailable", true);
      }
    }
    if (!entry || !bindingMatches(entry.binding, request, context.reference, receipt)) {
      if (entry) await this.#ports.cache.delete(key);
      return unavailableEnvelope(request, receipt.resolutionId, "unavailable", false);
    }
    return clientResourceDataEnvelopeSchema.parse({
      resourceProtocol: RESOURCE_PROTOCOL,
      type: "resource-data",
      requestId: request.requestId,
      contractFingerprint: request.contractFingerprint,
      documentId: request.documentId,
      branchId: request.branchId,
      revisionId: request.revisionId,
      resourceId: request.resourceId,
      binding: entry.binding,
    }) as ClientResourceDataEnvelope;
  }

  async #resolveValue(
    request: ResourceResolveRequest,
    actor: ResourceActorContext,
    context: CommittedResourceContext,
    resolutionId: string,
  ): Promise<ValidatedResolution> {
    const reference = context.reference;
    const registration = await this.#ports.schemas.get(reference.schemaId, reference.schemaVersion);
    if (!registration || registration.schemaHash !== reference.schemaHash) throw new ResourceSchemaError("resource.schema-identity", "Registered resource schema identity does not match the reference.");
    const validator = await this.#validator(registration);
    const controller = new AbortController();
    const source = await withTimeout(this.#ports.source.resolve({ reference, actor, signal: controller.signal }), this.#sourceTimeoutMs, controller);
    validateSourceIdentity(source, reference, this.#limits.maxResolvedResourceBytes);
    const decoded = await this.#ports.codec.decode(reference.codec, source.bytes);
    const parsed = parseResourceValue(validator, decoded);
    const sanitized = await this.#ports.redaction.sanitize({ value: parsed, reference, source, actor });
    if (sanitized.scopeRef !== reference.scopeRef || sanitized.sensitivity !== reference.sensitivity) {
      throw new ResourceSchemaError("resource.redaction-label", "Sanitized resource labels do not match the committed reference.");
    }
    if (!actor.allowedScopeRefs.includes(sanitized.scopeRef) || !actor.allowedSensitivity.includes(sanitized.sensitivity)) {
      throw new ResourceSchemaError("resource.redaction-scope", "Sanitized resource is outside actor scope.");
    }
    const value = parseResourceValue(validator, sanitized.value);
    const bytes = canonicalBytes(value).byteLength;
    if (bytes > this.#limits.maxResolvedResourceBytes) throw new ResourceSchemaError("resource.value-byte-limit", "Sanitized resource exceeds maxResolvedResourceBytes.");
    if (await canonicalHash(value) !== reference.contentHash) throw new ResourceSchemaError("resource.content-hash", "Sanitized resource content hash does not match the committed reference.");
    const evidenceIds = validateResolutionEvidence(source.evidenceIds, context, actor, this.#now());
    const binding: ClientResourceBinding = {
      resolutionId,
      requestId: request.requestId,
      resourceId: reference.resourceId,
      schemaVersion: reference.schemaVersion,
      schemaHash: reference.schemaHash,
      codec: structuredClone(reference.codec),
      mediaType: reference.mediaType,
      contentHash: reference.contentHash,
      value,
      byteLength: bytes,
      sensitivity: reference.sensitivity,
      expiresAt: reference.expiresAt,
    };
    return { binding, evidenceIds };
  }

  async #validator(registration: RegisteredResourceSchema): Promise<z.ZodType> {
    const identity = `${registration.schemaId}@${registration.schemaVersion}`;
    const prior = this.#schemaIdentities.get(identity);
    if (prior && prior !== registration.schemaHash) throw new ResourceSchemaError("resource.schema-conflict", `Schema identity ${identity} was reused with different bytes.`);
    const key = `${identity}:${registration.schemaHash}`;
    let compiled = this.#schemas.get(key);
    if (!compiled) {
      compiled = compileResourceSchema(registration, this.#profile, { limits: this.#schemaLimits });
      this.#schemas.set(key, compiled);
      compiled.catch(() => this.#schemas.delete(key));
    }
    const result = await compiled;
    this.#schemaIdentities.set(identity, registration.schemaHash);
    return result;
  }

  async #cacheBinding(
    request: ResourceResolveRequest,
    actor: ResourceActorContext,
    reference: ResourceReference,
    binding: ClientResourceBinding,
  ): Promise<void> {
    const entry: ScopedBindingCacheEntry = {
      cacheKey: resourceBindingCacheKey(actor, request, reference),
      binding: structuredClone(binding),
      request: structuredClone(request),
      tenantRef: actor.tenantRef,
      actorRef: actor.actorRef,
      expiresAt: reference.expiresAt,
    };
    await this.#ports.cache.put(entry);
  }

  async #refreshReplayBinding(record: StoredResourceResolution, receipt: ResourceResolutionReceipt): Promise<void> {
    const context = await this.#ports.documents.getCommittedResource(record.request);
    if (!context || !matchesCommittedRequest(context, record.request, receipt) || isExpired(context.reference.expiresAt, this.#now())) return;
    const authorized = await this.#ports.authorization.authorize({ actor: record.actor, request: record.request, context, phase: "deliver" });
    if (!authorized.allowed) return;
    const result = await this.#resolveValue(record.request, record.actor, context, receipt.resolutionId);
    await this.#cacheBinding(record.request, record.actor, context.reference, result.binding);
  }

  async #completeFailure(
    pending: StoredResourceResolution,
    request: ResourceResolveRequest,
    status: Exclude<ResourceResolutionStatus, "resolved">,
    code: string,
    message: string,
    reference?: ResourceReference,
    resolutionId = this.#id("resource-resolution"),
  ): Promise<ResourceControlResult> {
    const receipt: ResourceResolutionReceipt = {
      resolutionId,
      requestId: request.requestId,
      resourceId: request.resourceId,
      schemaVersion: reference?.schemaVersion ?? 1,
      schemaHash: reference?.schemaHash ?? request.expectedSchemaHash,
      contentHash: reference?.contentHash ?? request.expectedContentHash,
      status,
      diagnostic: diagnostic(code, message),
      auditRef: this.#audit(request.requestId),
    };
    await this.#ports.resolutions.complete(identity(pending.actor, request.requestId), pending.payloadHash, receipt);
    return { receipt: sanitizeResourceReceipt(receipt), replayed: false };
  }
}

export function sanitizeResourceReceipt(receipt: ResourceResolutionReceipt): ClientResourceResolutionReceipt {
  return clientResourceResolutionReceiptSchema.parse({
    resolutionId: receipt.resolutionId,
    requestId: receipt.requestId,
    resourceId: receipt.resourceId,
    schemaVersion: receipt.schemaVersion,
    schemaHash: receipt.schemaHash,
    contentHash: receipt.contentHash,
    status: receipt.status,
    evidenceIds: receipt.evidenceIds,
    diagnostic: receipt.diagnostic,
  }) as ClientResourceResolutionReceipt;
}

export function resourceBindingCacheKey(
  actor: Pick<ResourceActorContext, "tenantRef" | "actorRef">,
  request: Pick<ResourceResolveRequest, "documentId" | "revisionId" | "resourceId">,
  reference: Pick<ResourceReference, "schemaHash" | "contentHash">,
): string {
  return [
    actor.tenantRef,
    actor.actorRef,
    request.documentId,
    request.revisionId,
    request.resourceId,
    reference.schemaHash,
    reference.contentHash,
  ].map((value) => `${value.length}:${value}`).join("|");
}

function validateResolutionEvidence(
  evidenceIds: readonly string[],
  context: CommittedResourceContext,
  actor: ResourceActorContext,
  now: string,
): string[] {
  const unique = [...new Set(evidenceIds)];
  const evidence: Record<string, EvidenceReference> = {};
  for (const id of unique) {
    const record = context.evidence[id];
    if (!record) throw new ResourceSchemaError("resource.evidence-missing", "Resource source cited unavailable evidence.");
    if (
      record.scopeRef !== context.reference.scopeRef
      || rank(record.sensitivity) < rank(context.reference.sensitivity)
      || record.contentHash !== context.reference.contentHash
      || !record.sourceRefs.some((source) => source.kind === "resource" && source.id === context.reference.resourceId && source.contentHash === context.reference.contentHash)
    ) throw new ResourceSchemaError("resource.evidence-binding", "Resource evidence does not match the committed reference.");
    evidence[id] = record;
  }
  const validated = validateEvidenceAndClaims({
    resources: { [context.reference.resourceId]: context.reference },
    evidence,
    claims: {},
    nodes: {},
    actor,
    grantedEvidenceIds: unique,
    now,
  });
  if (!validated.valid) throw new ResourceSchemaError("resource.evidence-invalid", "Resource evidence failed provenance validation.");
  return unique;
}

function validateSourceIdentity(source: ResourceSourceOutput, reference: ResourceReference, maxBytes: number): void {
  if (!(source.bytes instanceof Uint8Array)) throw new ResourceSchemaError("resource.source-bytes", "Resource source must return Uint8Array.");
  if (source.bytes.byteLength > maxBytes) throw new ResourceSchemaError("resource.raw-byte-limit", "Resource source exceeds maxResolvedResourceBytes.");
  if (
    source.codec.id !== reference.codec.id
    || source.codec.version !== reference.codec.version
    || source.mediaType !== reference.mediaType
    || source.scopeRef !== reference.scopeRef
    || rank(source.sensitivity) > rank(reference.sensitivity)
  ) throw new ResourceSchemaError("resource.source-binding", "Resource source metadata does not match the committed reference.");
}

function matchesCommittedRequest(
  context: CommittedResourceContext,
  request: ResourceResolveRequest,
  receipt: ResourceResolutionReceipt,
): boolean {
  const reference = context.reference;
  return context.contractFingerprint === request.contractFingerprint
    && reference.resourceId === request.resourceId
    && reference.schemaHash === request.expectedSchemaHash
    && reference.contentHash === request.expectedContentHash
    && receipt.resourceId === reference.resourceId
    && receipt.schemaVersion === reference.schemaVersion
    && receipt.schemaHash === reference.schemaHash
    && receipt.contentHash === reference.contentHash;
}

function bindingMatches(
  binding: ClientResourceBinding,
  request: ResourceResolveRequest,
  reference: ResourceReference,
  receipt: ResourceResolutionReceipt,
): boolean {
  return binding.resolutionId === receipt.resolutionId
    && binding.requestId === request.requestId
    && binding.resourceId === reference.resourceId
    && binding.schemaVersion === reference.schemaVersion
    && binding.schemaHash === reference.schemaHash
    && binding.contentHash === reference.contentHash
    && binding.codec.id === reference.codec.id
    && binding.codec.version === reference.codec.version
    && binding.mediaType === reference.mediaType
    && binding.sensitivity === reference.sensitivity;
}

function unavailableEnvelope(
  request: ResourceResolveRequest,
  resolutionId: string | undefined,
  reason: "expired" | "denied" | "unavailable",
  retryable: boolean,
): ClientResourceDataEnvelope {
  return clientResourceDataEnvelopeSchema.parse({
    resourceProtocol: RESOURCE_PROTOCOL,
    type: "resource-unavailable",
    requestId: request.requestId,
    contractFingerprint: request.contractFingerprint,
    documentId: request.documentId,
    branchId: request.branchId,
    revisionId: request.revisionId,
    resourceId: request.resourceId,
    resolutionId,
    reason,
    retryable,
  }) as ClientResourceDataEnvelope;
}

function unavailableReason(status: ResourceResolutionStatus): "expired" | "denied" | "unavailable" {
  return status === "expired" ? "expired" : status === "denied" ? "denied" : "unavailable";
}

function classifyResolutionFailure(error: unknown): {
  status: Exclude<ResourceResolutionStatus, "resolved">;
  code: string;
  message: string;
} {
  if (error instanceof ResourceSchemaError) return { status: "invalid", code: error.code, message: "Resource validation failed." };
  return { status: "unavailable", code: "resource.source-unavailable", message: "Resource source is unavailable." };
}

function validateActor(actor: ResourceActorContext): ResourceActorContext {
  if (!actor.tenantRef || !actor.actorRef || !actor.actorContextRef) throw resolverError("resource.actor-invalid", "Resource actor context is incomplete.");
  return structuredClone(actor);
}

function identity(actor: ResourceActorContext, requestId: string): { tenantRef: string; actorRef: string; requestId: string } {
  return { tenantRef: actor.tenantRef, actorRef: actor.actorRef, requestId };
}

function rank(value: Sensitivity): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}

function isExpired(value: string | undefined, now: string): boolean {
  return value !== undefined && Date.parse(value) <= Date.parse(now);
}

function diagnostic(code: string, message: string): Diagnostic {
  return createDiagnostic({ phase: "effect", code, severity: "error", recoverable: false, modelCorrectable: false, message });
}

function resolverError(code: string, message: string, retryable = false): ResourceResolverError {
  return new ResourceResolverError(diagnostic(code, message), retryable);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Resource source timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
