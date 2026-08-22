import type {
  AssetRef,
  EvidenceId,
  JsonValue,
  OpaqueHostResourceKey,
  ResourceKind,
  ResourceSchemaConstraint,
  ResourceVersionId,
  Sha256Hash,
  SurfaceResourceGrant,
} from "@open-generative/protocol";

export type StoredResourceVersion = Readonly<{
  resourceKey: OpaqueHostResourceKey;
  kind: ResourceKind;
  schemaConstraint: ResourceSchemaConstraint;
  versionId: ResourceVersionId;
  contentHash: Sha256Hash;
  observedAt: string;
  payload: JsonValue | AssetRef;
  evidenceIds: readonly EvidenceId[];
}>;

export interface ResourceVersionStore {
  put(version: StoredResourceVersion): Promise<void>;
  get(resourceKey: OpaqueHostResourceKey, versionId: ResourceVersionId): Promise<StoredResourceVersion | undefined>;
  getLatest(resourceKey: OpaqueHostResourceKey): Promise<StoredResourceVersion | undefined>;
}

export interface ResourceGrantStore {
  put(grant: SurfaceResourceGrant): Promise<void>;
  findForBinding(input: Readonly<{
    bindingId: string;
    surfaceSessionId: string;
    actorBindingHash: Sha256Hash;
    tenantBindingHash: Sha256Hash;
  }>): Promise<SurfaceResourceGrant | undefined>;
  revoke(grantId: string, revocationEpoch: number): Promise<void>;
  currentRevocationEpoch(grantId: string): Promise<number | undefined>;
}

export class InMemoryResourceVersionStore implements ResourceVersionStore {
  readonly #versions = new Map<string, StoredResourceVersion>();
  readonly #latest = new Map<OpaqueHostResourceKey, ResourceVersionId>();

  async put(version: StoredResourceVersion): Promise<void> {
    const key = versionKey(version.resourceKey, version.versionId);
    const existing = this.#versions.get(key);
    if (existing && existing.contentHash !== version.contentHash) {
      throw new Error("Resource version identity was reused with different content.");
    }
    if (!existing) this.#versions.set(key, cloneVersion(version));
    this.#latest.set(version.resourceKey, version.versionId);
  }

  async get(resourceKey: OpaqueHostResourceKey, versionId: ResourceVersionId) {
    const value = this.#versions.get(versionKey(resourceKey, versionId));
    return value ? cloneVersion(value) : undefined;
  }

  async getLatest(resourceKey: OpaqueHostResourceKey) {
    const versionId = this.#latest.get(resourceKey);
    return versionId ? this.get(resourceKey, versionId) : undefined;
  }
}

export class InMemoryResourceGrantStore implements ResourceGrantStore {
  readonly #grants = new Map<string, SurfaceResourceGrant>();
  readonly #revocationEpochs = new Map<string, number>();
  readonly #activeByScope = new Map<string, string>();

  async put(grant: SurfaceResourceGrant): Promise<void> {
    const existing = this.#grants.get(grant.grantId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(grant)) {
      throw new Error("Resource grant identity was reused with different content.");
    }
    this.#grants.set(grant.grantId, structuredClone(grant));
    this.#revocationEpochs.set(grant.grantId, grant.revocationEpoch);
    this.#activeByScope.set(grantScope(grant), grant.grantId);
  }

  async findForBinding(input: Readonly<{
    bindingId: string;
    surfaceSessionId: string;
    actorBindingHash: Sha256Hash;
    tenantBindingHash: Sha256Hash;
  }>) {
    const grantId = this.#activeByScope.get(grantScope(input));
    const grant = grantId ? this.#grants.get(grantId) : undefined;
    return grant ? structuredClone(grant) : undefined;
  }

  async revoke(grantId: string, revocationEpoch: number): Promise<void> {
    const current = this.#revocationEpochs.get(grantId);
    if (current === undefined) throw new Error("Cannot revoke an unknown resource grant.");
    if (revocationEpoch <= current) throw new Error("Resource revocation epoch must advance.");
    this.#revocationEpochs.set(grantId, revocationEpoch);
  }

  async currentRevocationEpoch(grantId: string) {
    return this.#revocationEpochs.get(grantId);
  }
}

function grantScope(input: Readonly<{
  bindingId: string;
  surfaceSessionId: string;
  actorBindingHash: Sha256Hash;
  tenantBindingHash: Sha256Hash;
}>): string {
  return `${input.bindingId}\0${input.surfaceSessionId}\0${input.actorBindingHash}\0${input.tenantBindingHash}`;
}

function versionKey(resourceKey: OpaqueHostResourceKey, versionId: ResourceVersionId): string {
  return `${resourceKey}\0${versionId}`;
}

function cloneVersion(version: StoredResourceVersion): StoredResourceVersion {
  return structuredClone(version);
}
