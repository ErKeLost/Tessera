import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_PROTOCOL_LIMITS,
  assetRefSchema,
  canonicalEncode,
  columnIdSchema,
  evidenceIdSchema,
  jsonValueSchema,
  opaqueHostResourceKeySchema,
  resolvedResourceSnapshotSchema,
  resourceBindingDeclarationSchema,
  resourceBindingIdSchema,
  resourceGrantIdSchema,
  resourceKindSchema,
  resourceOperationSchema,
  resourceResolutionResultSchema,
  resourceWindowRequestSchema,
  resourceSnapshotIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  sha256HashSchema,
  surfaceResourceGrantSchema,
  surfaceSessionIdSchema,
  type AssetRef,
  type ColumnId,
  type EvidenceId,
  type JsonValue,
  type OpaqueHostResourceKey,
  type OpaqueServerCursor,
  type ResourceBindingDeclaration,
  type ResourceBindingId,
  type ResourceOperation,
  type ResourceResolutionResult,
  type ResourceSchemaConstraint,
  type ResourceSelector,
  type ResourceVersionId,
  type Sha256Hash,
  type StateId,
  type SurfaceResourceGrant,
} from "@open-generative/protocol";
import type { ResourceCursorClaims, ResourceCursorCodec } from "./cursor";
import type { ResourceSchemaRegistry } from "./schema-registry";
import type { ResourceGrantStore, ResourceVersionStore, StoredResourceVersion } from "./store";

export type ModelSafeResourceDescriptor = Readonly<{
  kind: string;
  schemaId: string;
  schemaRevision: number;
  schemaHash: Sha256Hash;
  contentHash: Sha256Hash;
  versionId: ResourceVersionId;
  rowCount?: number;
  columns?: readonly ColumnId[];
}>;

export type PublishedPinnedResource = Readonly<{
  declaration: PinnedResourceBindingDeclaration;
  descriptor: ModelSafeResourceDescriptor;
}>;

export type PinnedResourceBindingDeclaration = ResourceBindingDeclaration & Readonly<{
  resolution: Extract<ResourceBindingDeclaration["resolution"], { mode: "pinned" }>;
}>;

export type ResourceAuthority = Readonly<{
  actorBindingHash: Sha256Hash;
  tenantBindingHash: Sha256Hash;
}>;

export type ResourceProjectionDecision =
  | Readonly<{
    allowed: true;
    allowedColumns?: readonly ColumnId[];
    filterRow?: (row: Readonly<Record<string, JsonValue>>) => boolean;
  }>
  | Readonly<{ allowed: false; reason: "denied" | "revoked" }>;

export interface ResourceProjectionPolicy {
  authorize(input: Readonly<{
    grant: SurfaceResourceGrant;
    declaration: ResourceBindingDeclaration;
    authority: ResourceAuthority;
    stateValues: Readonly<Record<StateId, JsonValue>>;
  }>): Promise<ResourceProjectionDecision>;
}

export type LiveResourceResolver = (input: Readonly<{
  channelId: string;
  resourceKey: OpaqueHostResourceKey;
  schemaConstraint: ResourceSchemaConstraint;
}>) => Promise<Readonly<{
  versionId: ResourceVersionId;
  observedAt: string;
  payload: JsonValue | AssetRef;
  evidenceIds?: readonly EvidenceId[];
}>>;

export type ResourceGatewayOptions = Readonly<{
  versions: ResourceVersionStore;
  grants: ResourceGrantStore;
  schemas: ResourceSchemaRegistry;
  cursorCodec: ResourceCursorCodec;
  projectionPolicy: ResourceProjectionPolicy;
  now?: () => Date;
  versionIdFactory?: () => string;
  snapshotIdFactory?: () => string;
  grantIdFactory?: () => string;
  liveResolvers?: Readonly<Record<string, LiveResourceResolver>>;
}>;

export class ResourceGateway {
  readonly #versions: ResourceVersionStore;
  readonly #grants: ResourceGrantStore;
  readonly #schemas: ResourceSchemaRegistry;
  readonly #cursorCodec: ResourceCursorCodec;
  readonly #projectionPolicy: ResourceProjectionPolicy;
  readonly #now: () => Date;
  readonly #versionIdFactory: () => string;
  readonly #snapshotIdFactory: () => string;
  readonly #grantIdFactory: () => string;
  readonly #liveResolvers: Readonly<Record<string, LiveResourceResolver>>;

  constructor(options: ResourceGatewayOptions) {
    this.#versions = options.versions;
    this.#grants = options.grants;
    this.#schemas = options.schemas;
    this.#cursorCodec = options.cursorCodec;
    this.#projectionPolicy = options.projectionPolicy;
    this.#now = options.now ?? (() => new Date());
    this.#versionIdFactory = options.versionIdFactory ?? (() => `resource-version:${randomUUID()}`);
    this.#snapshotIdFactory = options.snapshotIdFactory ?? (() => `resource-snapshot:${randomUUID()}`);
    this.#grantIdFactory = options.grantIdFactory ?? (() => `resource-grant:${randomUUID()}`);
    this.#liveResolvers = options.liveResolvers ?? {};
  }

  async publishPinned(input: Readonly<{
    resourceKey: string;
    kind: string;
    schemaConstraint: ResourceSchemaConstraint;
    payload: JsonValue | AssetRef;
    selector?: ResourceSelector;
    evidenceIds?: readonly EvidenceId[];
    observedAt?: string;
  }>): Promise<PublishedPinnedResource> {
    const resourceKey = opaqueHostResourceKeySchema.parse(input.resourceKey);
    const kind = resourceKindSchema.parse(input.kind);
    const payload = validatePayload(this.#schemas, kind, input.schemaConstraint, input.payload);
    const versionId = resourceVersionIdSchema.parse(this.#versionIdFactory());
    const contentHash = serverHash("open-generative.resource-content\0", payload);
    const observedAt = new Date(input.observedAt ?? this.#now()).toISOString();
    const evidenceIds = [...(input.evidenceIds ?? [])].map((id) => evidenceIdSchema.parse(id));
    await this.#versions.put({
      resourceKey,
      kind,
      schemaConstraint: input.schemaConstraint,
      versionId,
      contentHash,
      observedAt,
      payload,
      evidenceIds,
    });
    const declaration = resourceBindingDeclarationSchema.parse({
      resourceKey,
      kind,
      schemaConstraint: input.schemaConstraint,
      selector: input.selector ?? {},
      resolution: { mode: "pinned", versionId, contentHash },
    });
    if (declaration.resolution.mode !== "pinned") {
      throw new ResourceGatewayError("resource.publication-not-pinned", "Pinned publication produced a non-pinned declaration.");
    }
    const pinnedDeclaration: PinnedResourceBindingDeclaration = {
      ...declaration,
      resolution: declaration.resolution,
    };
    return Object.freeze({ declaration: pinnedDeclaration, descriptor: describePinnedResource(pinnedDeclaration, payload) });
  }

  async createGrant(input: Readonly<{
    bindingId: ResourceBindingId;
    surfaceSessionId: string;
    authority: ResourceAuthority;
    authorityPolicyRevision: string;
    allowedOperations: readonly ResourceOperation[];
    rowPolicyHash: Sha256Hash;
    columnPolicyHash: Sha256Hash;
    expiresAt: string;
  }>): Promise<SurfaceResourceGrant> {
    const allowedOperations = [...new Set(input.allowedOperations)].sort(compareUtf16).map((operation) => resourceOperationSchema.parse(operation));
    const grant = surfaceResourceGrantSchema.parse({
      grantId: resourceGrantIdSchema.parse(this.#grantIdFactory()),
      bindingId: resourceBindingIdSchema.parse(input.bindingId),
      surfaceSessionId: surfaceSessionIdSchema.parse(input.surfaceSessionId),
      actorBindingHash: sha256HashSchema.parse(input.authority.actorBindingHash),
      tenantBindingHash: sha256HashSchema.parse(input.authority.tenantBindingHash),
      authorityPolicyRevision: input.authorityPolicyRevision,
      allowedOperations,
      rowPolicyHash: input.rowPolicyHash,
      columnPolicyHash: input.columnPolicyHash,
      expiresAt: new Date(input.expiresAt).toISOString(),
      revocationEpoch: 0,
    });
    await this.#grants.put(grant);
    return grant;
  }

  async resolve(input: Readonly<{
    request: unknown;
    declaration: ResourceBindingDeclaration;
    authority: ResourceAuthority;
    activeRevisionId: string;
    stateValues?: Readonly<Record<StateId, JsonValue>>;
  }>): Promise<ResourceResolutionResult> {
    const request = resourceWindowRequestSchema.parse(input.request);
    const declaration = resourceBindingDeclarationSchema.parse(input.declaration);
    if (request.expectedRevisionId !== revisionIdSchema.parse(input.activeRevisionId)) {
      return unavailable(request.bindingId, "unavailable", true);
    }
    const grant = await this.#grants.findForBinding({
      bindingId: request.bindingId,
      surfaceSessionId: request.surfaceSessionId,
      actorBindingHash: input.authority.actorBindingHash,
      tenantBindingHash: input.authority.tenantBindingHash,
    });
    if (!grant) return unavailable(request.bindingId, "denied", false);
    if (Date.parse(grant.expiresAt) <= this.#now().getTime()) return unavailable(request.bindingId, "expired", false);
    const revocationEpoch = await this.#grants.currentRevocationEpoch(grant.grantId);
    if (revocationEpoch !== grant.revocationEpoch) return unavailable(request.bindingId, "revoked", false);
    if (!grant.allowedOperations.includes("read") || !grant.allowedOperations.includes("window")) {
      return unavailable(request.bindingId, "denied", false);
    }
    const stateValues = Object.freeze({ ...(input.stateValues ?? {}) });
    if (declaration.selector.filterStateRef && !(declaration.selector.filterStateRef in stateValues)) {
      return unavailable(request.bindingId, "unavailable", true);
    }
    const projection = await this.#projectionPolicy.authorize({
      grant,
      declaration,
      authority: input.authority,
      stateValues,
    });
    if (!projection.allowed) return unavailable(request.bindingId, projection.reason, false);

    const version = await this.#resolveVersion(declaration);
    if (!version) return unavailable(request.bindingId, "not-found", false);
    if (
      version.resourceKey !== declaration.resourceKey
      || version.kind !== declaration.kind
      || version.schemaConstraint.schemaHash !== declaration.schemaConstraint.schemaHash
    ) return unavailable(request.bindingId, "schema-incompatible", false);
    if (request.expectedResourceVersionId && request.expectedResourceVersionId !== version.versionId) {
      return unavailable(request.bindingId, "unavailable", true);
    }
    const selectedColumns = intersectColumns(declaration.selector.projection, projection.allowedColumns);
    if (selectedColumns && selectedColumns.length > 0 && !grant.allowedOperations.includes("project")) {
      return unavailable(request.bindingId, "denied", false);
    }
    if (declaration.selector.sort && declaration.selector.sort.length > 0 && !grant.allowedOperations.includes("sort")) {
      return unavailable(request.bindingId, "denied", false);
    }
    const projectionHash = serverHash("open-generative.resource-projection\0", {
      selector: declaration.selector,
      selectedColumns: selectedColumns ?? null,
    });
    const policyProjectionHash = serverHash("open-generative.resource-policy-projection\0", {
      rowPolicyHash: grant.rowPolicyHash,
      columnPolicyHash: grant.columnPolicyHash,
      selectedColumns: selectedColumns ?? null,
    });
    const offset = inputOffset(request.serverCursor, {
      bindingId: request.bindingId,
      surfaceSessionId: request.surfaceSessionId,
      resourceVersionId: version.versionId,
      actorBindingHash: input.authority.actorBindingHash,
      projectionHash,
      policyProjectionHash,
    }, this.#cursorCodec, this.#now());
    const windowed = projectWindow(version, declaration.selector, selectedColumns, projection.filterRow, offset);
    const resourceWindow = version.kind === "asset"
      ? { kind: "asset" as const, asset: assetRefSchema.parse(version.payload) }
      : {
        kind: "json" as const,
        value: windowed.value,
        byteLength: canonicalEncode(windowed.value).byteLength,
      };
    if (resourceWindow.kind === "json" && resourceWindow.byteLength > DEFAULT_PROTOCOL_LIMITS.maxResolvedResourceBytes) {
      throw new ResourceGatewayError("resource.window-too-large", "Resolved resource window exceeds the protocol byte limit.");
    }
    const nextCursor = windowed.nextOffset === undefined ? undefined : this.#cursorCodec.encode({
      bindingId: request.bindingId,
      surfaceSessionId: request.surfaceSessionId,
      resourceVersionId: version.versionId,
      actorBindingHash: input.authority.actorBindingHash,
      projectionHash,
      policyProjectionHash,
      offset: windowed.nextOffset,
      expiresAt: new Date(Math.min(Date.parse(grant.expiresAt), this.#now().getTime() + 15 * 60_000)).toISOString(),
    });
    return resourceResolutionResultSchema.parse({
      status: "resolved",
      snapshot: resolvedResourceSnapshotSchema.parse({
        snapshotId: resourceSnapshotIdSchema.parse(this.#snapshotIdFactory()),
        bindingId: request.bindingId,
        resourceVersionId: version.versionId,
        schemaHash: version.schemaConstraint.schemaHash,
        contentHash: version.contentHash,
        observedAt: version.observedAt,
        projectionHash,
        policyProjectionHash,
        payload: resourceWindow,
        ...(nextCursor ? { nextCursor } : {}),
        evidenceIds: version.evidenceIds,
      }),
    });
  }

  async #resolveVersion(declaration: ResourceBindingDeclaration): Promise<StoredResourceVersion | undefined> {
    if (declaration.resolution.mode === "pinned") {
      const version = await this.#versions.get(declaration.resourceKey, declaration.resolution.versionId);
      if (!version || version.contentHash !== declaration.resolution.contentHash) return undefined;
      return version;
    }
    const resolver = this.#liveResolvers[declaration.resolution.channelId];
    if (!resolver) throw new ResourceGatewayError("resource.live-resolver-missing", "No trusted resolver is registered for this live resource channel.");
    const resolved = await resolver({
      channelId: declaration.resolution.channelId,
      resourceKey: declaration.resourceKey,
      schemaConstraint: declaration.schemaConstraint,
    });
    const payload = validatePayload(this.#schemas, declaration.kind, declaration.schemaConstraint, resolved.payload);
    const version: StoredResourceVersion = {
      resourceKey: declaration.resourceKey,
      kind: declaration.kind,
      schemaConstraint: declaration.schemaConstraint,
      versionId: resourceVersionIdSchema.parse(resolved.versionId),
      contentHash: serverHash("open-generative.resource-content\0", payload),
      observedAt: new Date(resolved.observedAt).toISOString(),
      payload,
      evidenceIds: [...(resolved.evidenceIds ?? [])],
    };
    await this.#versions.put(version);
    return version;
  }
}

export class ResourceGatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResourceGatewayError";
  }
}

function validatePayload(
  schemas: ResourceSchemaRegistry,
  kind: string,
  constraint: ResourceSchemaConstraint,
  input: JsonValue | AssetRef,
): JsonValue | AssetRef {
  if (kind === "asset") return assetRefSchema.parse(input);
  const payload = schemas.validate(constraint, jsonValueSchema.parse(input));
  return kind === "dataset" ? datasetPayloadSchema.parse(payload) : payload;
}

function describePinnedResource(
  declaration: PinnedResourceBindingDeclaration,
  payload: JsonValue | AssetRef,
): ModelSafeResourceDescriptor {
  const dataset = isDatasetPayload(payload) ? payload : undefined;
  return Object.freeze({
    kind: declaration.kind,
    schemaId: declaration.schemaConstraint.schemaId,
    schemaRevision: declaration.schemaConstraint.schemaRevision,
    schemaHash: declaration.schemaConstraint.schemaHash,
    contentHash: declaration.resolution.contentHash,
    versionId: declaration.resolution.versionId,
    ...(dataset ? {
      rowCount: dataset.rows.length,
      columns: dataset.columns.map((column) => columnIdSchema.parse(column.id)),
    } : {}),
  });
}

function projectWindow(
  version: StoredResourceVersion,
  selector: ResourceSelector,
  selectedColumns: readonly ColumnId[] | undefined,
  filterRow: ((row: Readonly<Record<string, JsonValue>>) => boolean) | undefined,
  offset: number,
): { value: JsonValue; nextOffset?: number } {
  if (!isDatasetPayload(version.payload)) return { value: version.payload as JsonValue };
  const knownColumns = new Set(version.payload.columns.map((column) => column.id));
  const columns = selectedColumns ?? version.payload.columns.map((column) => columnIdSchema.parse(column.id));
  for (const column of columns) {
    if (!knownColumns.has(column)) throw new ResourceGatewayError("resource.column-not-found", `Column ${column} does not exist in the resource.`);
  }
  let rows = version.payload.rows.filter((row) => filterRow?.(row) ?? true);
  for (const sort of [...(selector.sort ?? [])].reverse()) {
    rows = [...rows].sort((left, right) => compareJson(left[sort.columnId], right[sort.columnId], sort.direction, sort.nulls));
  }
  const limit = Math.min(selector.windowLimit ?? 100, DEFAULT_PROTOCOL_LIMITS.maxResourceWindowItems);
  const page = rows.slice(offset, offset + limit).map((row) => Object.fromEntries(
    columns.map((column) => [column, row[column] ?? null]),
  ));
  const value = {
    columns: version.payload.columns.filter((column) => columns.includes(columnIdSchema.parse(column.id))),
    rows: page,
    totalRows: rows.length,
  } as JsonValue;
  return { value, ...(offset + limit < rows.length ? { nextOffset: offset + limit } : {}) };
}

function inputOffset(
  cursor: OpaqueServerCursor | undefined,
  expected: Omit<ResourceCursorClaims, "offset" | "expiresAt">,
  codec: ResourceCursorCodec,
  now: Date,
): number {
  if (!cursor) return 0;
  const claims = codec.decode(cursor);
  if (
    claims.bindingId !== expected.bindingId
    || claims.surfaceSessionId !== expected.surfaceSessionId
    || claims.resourceVersionId !== expected.resourceVersionId
    || claims.actorBindingHash !== expected.actorBindingHash
    || claims.projectionHash !== expected.projectionHash
    || claims.policyProjectionHash !== expected.policyProjectionHash
    || Date.parse(claims.expiresAt) <= now.getTime()
  ) throw new ResourceGatewayError("resource.cursor-scope-mismatch", "Resource cursor is expired or bound to another window scope.");
  return claims.offset;
}

function unavailable(bindingId: ResourceBindingId, reason: string, retryable: boolean): ResourceResolutionResult {
  return resourceResolutionResultSchema.parse({ status: "unavailable", unavailable: { bindingId, reason, retryable } });
}

function intersectColumns(
  requested: readonly ColumnId[] | undefined,
  allowed: readonly ColumnId[] | undefined,
): readonly ColumnId[] | undefined {
  if (!requested && !allowed) return undefined;
  if (!requested) return allowed;
  if (!allowed) return requested;
  const allowedSet = new Set(allowed);
  return requested.filter((column) => allowedSet.has(column));
}

type DatasetPayload = {
  columns: Array<{ id: string; label?: string; type?: string }>;
  rows: Array<Record<string, JsonValue>>;
  totalRows?: number;
};

export const datasetPayloadSchema = z.object({
  columns: z.array(z.object({
    id: columnIdSchema,
    label: z.string().min(1).max(512).optional(),
    type: z.string().min(1).max(128).optional(),
  }).strict()).max(DEFAULT_PROTOCOL_LIMITS.maxResourceWindowColumns),
  rows: z.array(z.record(z.string(), jsonValueSchema)),
  totalRows: z.number().int().nonnegative().optional(),
}).strict().superRefine((dataset, context) => {
  const columnIds = dataset.columns.map((column) => column.id);
  if (new Set(columnIds).size !== columnIds.length) {
    context.addIssue({ code: "custom", path: ["columns"], message: "Dataset column IDs must be unique." });
  }
  const knownColumns = new Set(columnIds);
  for (const [rowIndex, row] of dataset.rows.entries()) {
    for (const key of Object.keys(row)) {
      const parsedKey = columnIdSchema.safeParse(key);
      if (!parsedKey.success || !knownColumns.has(parsedKey.data)) {
        context.addIssue({ code: "custom", path: ["rows", rowIndex, key], message: "Dataset row key is not declared as a column." });
      }
    }
  }
  if (dataset.totalRows !== undefined && dataset.totalRows < dataset.rows.length) {
    context.addIssue({ code: "custom", path: ["totalRows"], message: "Dataset totalRows cannot be smaller than the included row count." });
  }
});

function isDatasetPayload(value: unknown): value is DatasetPayload {
  return datasetPayloadSchema.safeParse(value).success;
}

function compareJson(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  direction: "ascending" | "descending",
  nulls: "first" | "last",
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    return (leftNull ? -1 : 1) * (nulls === "first" ? 1 : -1);
  }
  const leftValue = typeof left === "number" ? left : String(left);
  const rightValue = typeof right === "number" ? right : String(right);
  const compared = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  return direction === "ascending" ? compared : -compared;
}

function serverHash(domain: string, value: unknown): Sha256Hash {
  const hash = createHash("sha256");
  hash.update(domain, "utf8");
  hash.update(canonicalEncode(value));
  return sha256HashSchema.parse(`sha256:${hash.digest("hex")}`);
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
