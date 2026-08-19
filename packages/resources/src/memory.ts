import { canonicalize, type JsonValue } from "@data-elements/runtime";
import type {
  CommittedResourceContext,
  CommittedResourceStorePort,
  RegisteredResourceSchema,
  ResourceActorContext,
  ResourceAuthorizationPort,
  ResourceCodecPort,
  ResourceRedactionPort,
  ResourceResolveRequest,
  ResourceResolutionClaim,
  ResourceResolutionReceipt,
  ResourceResolutionStorePort,
  ResourceSchemaRegistryPort,
  ResourceSourceOutput,
  ResourceSourcePort,
  ScopedBindingCacheEntry,
  ScopedResourceBindingCachePort,
  Sensitivity,
  StoredResourceResolution,
} from "./types";

export class InMemoryCommittedResourceStore implements CommittedResourceStorePort {
  readonly #records = new Map<string, CommittedResourceContext>();

  constructor(input: { records?: ReadonlyArray<[string, CommittedResourceContext]> } = {}) {
    for (const [key, value] of input.records ?? []) putImmutable(this.#records, key, value);
  }

  set(input: { documentId: string; branchId: string; revisionId: string; context: CommittedResourceContext }): void {
    const key = documentKey(input.documentId, input.branchId, input.revisionId, input.context.reference.resourceId);
    putImmutable(this.#records, key, input.context);
  }

  async getCommittedResource(input: {
    documentId: string;
    branchId: string;
    revisionId: string;
    resourceId: string;
  }): Promise<CommittedResourceContext | undefined> {
    return cloneOptional(this.#records.get(documentKey(input.documentId, input.branchId, input.revisionId, input.resourceId)));
  }

  exportState(): { records: Array<[string, CommittedResourceContext]> } {
    return { records: [...this.#records.entries()].map(([key, value]) => [key, clone(value)]) };
  }
}

export class InMemoryResourceSchemaRegistry implements ResourceSchemaRegistryPort {
  readonly #records = new Map<string, RegisteredResourceSchema>();

  constructor(input: readonly RegisteredResourceSchema[] | { records?: ReadonlyArray<[string, RegisteredResourceSchema]> } = []) {
    if (Array.isArray(input)) {
      for (const record of input as readonly RegisteredResourceSchema[]) this.set(record);
      return;
    }
    for (const [key, value] of (input as { records?: ReadonlyArray<[string, RegisteredResourceSchema]> }).records ?? []) {
      putImmutable(this.#records, key, value);
    }
  }

  set(record: RegisteredResourceSchema): void {
    putImmutable(this.#records, schemaKey(record.schemaId, record.schemaVersion), record);
  }

  async get(schemaId: string, schemaVersion: number): Promise<RegisteredResourceSchema | undefined> {
    return cloneOptional(this.#records.get(schemaKey(schemaId, schemaVersion)));
  }

  exportState(): { records: Array<[string, RegisteredResourceSchema]> } {
    return { records: [...this.#records.entries()].map(([key, value]) => [key, clone(value)]) };
  }
}

export type ResourceSourceHandler = (input: {
  actor: ResourceActorContext;
  signal: AbortSignal;
}) => ResourceSourceOutput | Promise<ResourceSourceOutput>;

export class InMemoryResourceSource implements ResourceSourcePort {
  readonly #handlers = new Map<string, ResourceSourceHandler>();

  set(resourceId: string, handler: ResourceSourceHandler): void {
    this.#handlers.set(resourceId, handler);
  }

  delete(resourceId: string): void {
    this.#handlers.delete(resourceId);
  }

  async resolve(input: {
    reference: { resourceId: string };
    actor: ResourceActorContext;
    signal: AbortSignal;
  }): Promise<ResourceSourceOutput> {
    const handler = this.#handlers.get(input.reference.resourceId);
    if (!handler) throw new Error("Resource source is unavailable.");
    return clone(await handler({ actor: clone(input.actor), signal: input.signal }));
  }
}

type ResourceScopeAuthority = {
  scopeRef: string;
  tenantRef: string;
  actorRefs: string[];
  revoked?: boolean;
};

export class InMemoryResourceAuthorization implements ResourceAuthorizationPort {
  readonly #scopes = new Map<string, ResourceScopeAuthority>();

  constructor(scopes: readonly ResourceScopeAuthority[] = []) {
    for (const scope of scopes) this.set(scope);
  }

  set(scope: ResourceScopeAuthority): void {
    this.#scopes.set(scope.scopeRef, clone(scope));
  }

  revoke(scopeRef: string): void {
    const current = this.#scopes.get(scopeRef);
    if (current) this.#scopes.set(scopeRef, { ...current, revoked: true });
  }

  async authorize(input: {
    actor: ResourceActorContext;
    request: ResourceResolveRequest;
    context: CommittedResourceContext;
    phase: "resolve" | "deliver";
  }): Promise<{ allowed: boolean; reasonCodes: string[] }> {
    const reference = input.context.reference;
    const scope = this.#scopes.get(reference.scopeRef);
    const reasons: string[] = [];
    if (!scope || scope.revoked) reasons.push("resource.scope-revoked");
    if (scope && scope.tenantRef !== input.actor.tenantRef) reasons.push("resource.tenant-denied");
    if (scope && !scope.actorRefs.includes(input.actor.actorRef)) reasons.push("resource.actor-denied");
    if (!input.actor.allowedScopeRefs.includes(reference.scopeRef)) reasons.push("resource.actor-scope-denied");
    if (!input.actor.allowedSensitivity.includes(reference.sensitivity)) reasons.push("resource.actor-sensitivity-denied");
    return { allowed: reasons.length === 0, reasonCodes: reasons };
  }
}

export class JsonResourceCodec implements ResourceCodecPort {
  async decode(codec: { id: string; version: string }, bytes: Uint8Array): Promise<unknown> {
    if (codec.id !== "json" || codec.version !== "1") throw new Error(`Unsupported resource codec ${codec.id}@${codec.version}.`);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  }
}

export type ResourceRedactor = (input: {
  value: JsonValue;
  reference: CommittedResourceContext["reference"];
  source: ResourceSourceOutput;
  actor: ResourceActorContext;
}) => JsonValue | Promise<JsonValue>;

export class DefaultResourceRedaction implements ResourceRedactionPort {
  readonly #redact: ResourceRedactor;

  constructor(redact: ResourceRedactor = ({ value }) => value) {
    this.#redact = redact;
  }

  async sanitize(input: {
    value: JsonValue;
    reference: CommittedResourceContext["reference"];
    source: ResourceSourceOutput;
    actor: ResourceActorContext;
  }): Promise<{ value: JsonValue; scopeRef: string; sensitivity: Sensitivity; validationIds: string[] }> {
    if (input.source.scopeRef !== input.reference.scopeRef) throw new Error("Resource source scope does not match the committed reference.");
    if (rank(input.source.sensitivity) > rank(input.reference.sensitivity)) throw new Error("Committed resource reference lowers source sensitivity.");
    return {
      value: await this.#redact({ ...input, value: clone(input.value) }),
      scopeRef: input.reference.scopeRef,
      sensitivity: input.reference.sensitivity,
      validationIds: ["resource.redaction-applied", "resource.scope-authorized"],
    };
  }
}

export class InMemoryResourceResolutionStore implements ResourceResolutionStorePort {
  readonly #records = new Map<string, StoredResourceResolution>();

  constructor(input: { records?: ReadonlyArray<[string, StoredResourceResolution]> } = {}) {
    for (const [key, value] of input.records ?? []) this.#records.set(key, clone(value));
  }

  async claim(record: StoredResourceResolution): Promise<ResourceResolutionClaim> {
    const key = resolutionKey(record.actor.tenantRef, record.actor.actorRef, record.request.requestId);
    const prior = this.#records.get(key);
    if (prior) {
      if (prior.payloadHash !== record.payloadHash || canonicalize(prior.request) !== canonicalize(record.request)) {
        return { status: "conflict", record: clone(prior) };
      }
      return { status: prior.status === "completed" ? "replayed" : "pending", record: clone(prior) };
    }
    this.#records.set(key, clone(record));
    return { status: "claimed", record: clone(record) };
  }

  async complete(
    identity: { tenantRef: string; actorRef: string; requestId: string },
    payloadHash: string,
    receipt: ResourceResolutionReceipt,
  ): Promise<void> {
    const key = resolutionKey(identity.tenantRef, identity.actorRef, identity.requestId);
    const current = this.#records.get(key);
    if (!current || current.payloadHash !== payloadHash) throw new Error("Cannot complete an unknown or conflicting resource request.");
    if (receipt.requestId !== identity.requestId || receipt.resourceId !== current.request.resourceId) {
      throw new Error("Resource receipt identity does not match its request.");
    }
    if (current.receipt && canonicalize(current.receipt) !== canonicalize(receipt)) throw new Error("Resource receipt is immutable.");
    if (!current.receipt) this.#records.set(key, { ...current, status: "completed", receipt: clone(receipt) });
  }

  async get(identity: { tenantRef: string; actorRef: string; requestId: string }): Promise<StoredResourceResolution | undefined> {
    return cloneOptional(this.#records.get(resolutionKey(identity.tenantRef, identity.actorRef, identity.requestId)));
  }

  exportState(): { records: Array<[string, StoredResourceResolution]> } {
    return { records: [...this.#records.entries()].map(([key, value]) => [key, clone(value)]) };
  }
}

export class InMemoryScopedResourceBindingCache implements ScopedResourceBindingCachePort {
  readonly #entries = new Map<string, ScopedBindingCacheEntry>();
  readonly #now: () => string;

  constructor(options: { now?: () => string; entries?: ReadonlyArray<[string, ScopedBindingCacheEntry]> } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const [key, value] of options.entries ?? []) this.#entries.set(key, clone(value));
  }

  async get(cacheKey: string): Promise<ScopedBindingCacheEntry | undefined> {
    const entry = this.#entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.parse(this.#now())) {
      this.#entries.delete(cacheKey);
      return undefined;
    }
    return clone(entry);
  }

  async put(entry: ScopedBindingCacheEntry): Promise<void> {
    this.#entries.set(entry.cacheKey, clone(entry));
  }

  async delete(cacheKey: string): Promise<void> {
    this.#entries.delete(cacheKey);
  }

  async evictActor(tenantRef: string, actorRef: string): Promise<void> {
    for (const [key, entry] of this.#entries) {
      if (entry.tenantRef === tenantRef && entry.actorRef === actorRef) this.#entries.delete(key);
    }
  }

  async evictRevision(documentId: string, revisionId: string): Promise<void> {
    for (const [key, entry] of this.#entries) {
      if (entry.request.documentId === documentId && entry.request.revisionId === revisionId) this.#entries.delete(key);
    }
  }

  exportState(): { entries: Array<[string, ScopedBindingCacheEntry]> } {
    return { entries: [...this.#entries.entries()].map(([key, value]) => [key, clone(value)]) };
  }
}

function documentKey(documentId: string, branchId: string, revisionId: string, resourceId: string): string {
  return `${documentId}\u0000${branchId}\u0000${revisionId}\u0000${resourceId}`;
}

function schemaKey(schemaId: string, version: number): string {
  return `${schemaId}@${version}`;
}

function resolutionKey(tenantRef: string, actorRef: string, requestId: string): string {
  return `${tenantRef}\u0000${actorRef}\u0000${requestId}`;
}

function rank(value: Sensitivity): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}

function putImmutable<T>(map: Map<string, T>, key: string, value: T): void {
  const prior = map.get(key);
  if (prior && canonicalize(prior) !== canonicalize(value)) throw new Error(`Immutable identity conflict: ${key}.`);
  if (!prior) map.set(key, clone(value));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
