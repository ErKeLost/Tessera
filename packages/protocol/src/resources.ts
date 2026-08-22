import { z } from "zod";
import {
  assetIdSchema,
  columnIdSchema,
  evidenceIdSchema,
  opaqueHostResourceKeySchema,
  opaqueServerCursorSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  resourceGrantIdSchema,
  resourceSchemaIdSchema,
  resourceSnapshotIdSchema,
  resourceVersionIdSchema,
  revisionIdSchema,
  stateIdSchema,
  surfaceSessionIdSchema,
} from "./ids";
import { sha256HashSchema } from "./hash";
import { isoTimestampSchema, jsonValueSchema } from "./json";
import { sensitivitySchema } from "./policy";

export const resourceKindSchema = z.union([
  z.enum(["dataset", "record", "document", "asset"]),
  z.string().regex(/^custom:[a-z][a-z0-9.-]{0,127}$/),
]);

export const resourceOperationSchema = z.enum(["read", "window", "project", "filter", "sort"]);

export const resourceSchemaConstraintSchema = z.object({
  schemaId: resourceSchemaIdSchema,
  schemaRevision: z.number().int().positive(),
  schemaHash: sha256HashSchema,
  compatibility: z.enum(["exact", "backward-compatible"]),
}).strict();

export const sortSpecSchema = z.object({
  columnId: columnIdSchema,
  direction: z.enum(["ascending", "descending"]),
  nulls: z.enum(["first", "last"]),
}).strict();

export const freshnessPolicySchema = z.object({
  maxAgeMs: z.number().int().nonnegative(),
  staleIfErrorMs: z.number().int().nonnegative(),
}).strict();

export const resourceSelectorSchema = z.object({
  projection: z.array(columnIdSchema).max(256).optional(),
  filterStateRef: stateIdSchema.optional(),
  sort: z.array(sortSpecSchema).max(16).optional(),
  windowLimit: z.number().int().positive().max(10_000).optional(),
}).strict();

export const resourceSelectorPolicySchema = z.object({
  allowProjection: z.boolean(),
  allowFilterState: z.boolean(),
  allowSort: z.boolean(),
  maxWindowLimit: z.number().int().positive().max(10_000),
  allowedColumns: z.array(columnIdSchema).max(256).optional(),
}).strict();

const resourceResolutionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("pinned"),
    versionId: resourceVersionIdSchema,
    contentHash: sha256HashSchema,
  }).strict(),
  z.object({
    mode: z.literal("live"),
    channelId: z.string().min(1).max(256),
    freshness: freshnessPolicySchema,
    schemaCompatibility: z.enum(["exact", "backward-compatible"]),
  }).strict(),
]);

export const resourceBindingDeclarationSchema = z.object({
  resourceKey: opaqueHostResourceKeySchema,
  kind: resourceKindSchema,
  schemaConstraint: resourceSchemaConstraintSchema,
  selector: resourceSelectorSchema,
  resolution: resourceResolutionSchema,
}).strict();

export const surfaceResourceGrantSchema = z.object({
  grantId: resourceGrantIdSchema,
  bindingId: resourceBindingIdSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  actorBindingHash: sha256HashSchema,
  tenantBindingHash: sha256HashSchema,
  authorityPolicyRevision: z.string().min(1).max(256),
  allowedOperations: z.array(resourceOperationSchema).min(1).max(8),
  rowPolicyHash: sha256HashSchema,
  columnPolicyHash: sha256HashSchema,
  expiresAt: isoTimestampSchema,
  revocationEpoch: z.number().int().nonnegative(),
}).strict();

export const resourceWindowRequestSchema = z.object({
  requestId: requestIdSchema,
  bindingId: resourceBindingIdSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  expectedRevisionId: revisionIdSchema,
  expectedResourceVersionId: resourceVersionIdSchema.optional(),
  serverCursor: opaqueServerCursorSchema.optional(),
}).strict();

export const assetRefSchema = z.object({
  assetId: assetIdSchema,
  mimeType: z.string().min(1).max(256),
  byteLength: z.number().int().nonnegative(),
  integrity: sha256HashSchema,
  disposition: z.enum(["inline", "attachment"]),
  expiresAt: isoTimestampSchema.optional(),
}).strict();

export const resourceWindowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("json"),
    value: jsonValueSchema,
    byteLength: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("asset"),
    asset: assetRefSchema,
  }).strict(),
]);

export const resolvedResourceSnapshotSchema = z.object({
  snapshotId: resourceSnapshotIdSchema,
  bindingId: resourceBindingIdSchema,
  resourceVersionId: resourceVersionIdSchema,
  schemaHash: sha256HashSchema,
  contentHash: sha256HashSchema,
  observedAt: isoTimestampSchema,
  projectionHash: sha256HashSchema,
  policyProjectionHash: sha256HashSchema,
  payload: resourceWindowSchema,
  nextCursor: opaqueServerCursorSchema.optional(),
  evidenceIds: z.array(evidenceIdSchema).max(1_000),
}).strict();

export const unavailableResourceSnapshotSchema = z.object({
  bindingId: resourceBindingIdSchema,
  reason: z.enum(["expired", "revoked", "denied", "not-found", "schema-incompatible", "unavailable"]),
  retryable: z.boolean(),
}).strict();

export const resourceResolutionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), snapshot: resolvedResourceSnapshotSchema }).strict(),
  z.object({ status: z.literal("unavailable"), unavailable: unavailableResourceSnapshotSchema }).strict(),
]);

export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceOperation = z.infer<typeof resourceOperationSchema>;
export type ResourceSchemaConstraint = z.infer<typeof resourceSchemaConstraintSchema>;
export type SortSpec = z.infer<typeof sortSpecSchema>;
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;
export type ResourceSelector = z.infer<typeof resourceSelectorSchema>;
export type ResourceSelectorPolicy = z.infer<typeof resourceSelectorPolicySchema>;
export type ResourceBindingDeclaration = z.infer<typeof resourceBindingDeclarationSchema>;
export type SurfaceResourceGrant = z.infer<typeof surfaceResourceGrantSchema>;
export type ResourceWindowRequest = z.infer<typeof resourceWindowRequestSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type ResourceWindow = z.infer<typeof resourceWindowSchema>;
export type ResolvedResourceSnapshot = z.infer<typeof resolvedResourceSnapshotSchema>;
export type UnavailableResourceSnapshot = z.infer<typeof unavailableResourceSnapshotSchema>;
export type ResourceResolutionResult = z.infer<typeof resourceResolutionResultSchema>;
