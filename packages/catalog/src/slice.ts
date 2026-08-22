import {
  actionContractRefSchema,
  catalogManifestRefSchema,
  catalogSliceActionSchema,
  catalogSliceComponentSchema,
  catalogSliceEvidenceSchema,
  catalogSliceResourceSchema,
  columnIdSchema,
  contractRefSchema,
  evidenceIdSchema,
  HASH_DOMAINS,
  isoTimestampSchema,
  jsonObjectSchema,
  jsonSchemaSchema,
  jsonValueSchema,
  offeredEvidenceRefSchema,
  offeredResourceBindingRefSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  sliceActionIdSchema,
  sliceComponentIdSchema,
  sliceEvidenceIdSchema,
  sliceResourceIdSchema,
  type ActionContractRef,
  type CatalogManifestRef,
  type ContractRef,
  type EvidenceId,
  type HashProvider,
  type ResourceBindingId,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  actionContractRefKey,
  contractRefKey,
  resourceKindSchema,
  resourceSelectorPolicySchema,
  sensitivitySchema,
} from "./contracts";
import {
  addCanonicalSetIssues,
  assertHash,
  canonicalSet,
  computeHash,
  deepFreeze,
} from "./internal";
import {
  catalogManifestSchema,
  computeContractSetHash,
  computeDependencyLockHash,
  findActionRef,
  findComponentRef,
  verifyCatalogManifest,
  type CatalogManifest,
} from "./manifest";
import {
  rendererCapabilityNegotiationResultSchema,
  type RendererCapabilityNegotiationResult,
} from "./renderer";

const descriptorTextSchema = z.string().trim().min(1).max(4_096);
const providerSchemaProfileSchema = z.string()
  .min(1)
  .max(192)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const evidenceKindSchema = z.union([
  z.enum(["query", "document", "record", "observation"]),
  z.string().min(8).max(192).regex(/^custom:[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/),
]);

export const modelSafeColumnDescriptorSchema = z.object({
  columnId: columnIdSchema,
  label: descriptorTextSchema,
  valueSchema: jsonSchemaSchema,
  sensitivity: sensitivitySchema,
}).strict();

export const modelSafeResourceDescriptorSchema = z.object({
  kind: resourceKindSchema,
  label: descriptorTextSchema,
  description: descriptorTextSchema.optional(),
  resolvedSchema: jsonSchemaSchema,
  columns: z.array(modelSafeColumnDescriptorSchema).max(1_024),
  estimatedItems: z.number().int().nonnegative().optional(),
  sample: jsonValueSchema.optional(),
  metadata: jsonObjectSchema.optional(),
}).strict().superRefine((descriptor, context) => {
  addCanonicalSetIssues(descriptor.columns, context, "columns");
});

export const modelSafeEvidenceDescriptorSchema = z.object({
  kind: evidenceKindSchema,
  label: descriptorTextSchema,
  summary: descriptorTextSchema,
  observedAt: isoTimestampSchema.optional(),
  excerpt: z.string().max(16_384).optional(),
  metadata: jsonObjectSchema.optional(),
}).strict();

export const modelVisibleResourceOfferSchema = z.object({
  source: offeredResourceBindingRefSchema,
  descriptor: modelSafeResourceDescriptorSchema,
  selectorPolicy: resourceSelectorPolicySchema,
}).strict();

export const modelVisibleEvidenceOfferSchema = z.object({
  source: offeredEvidenceRefSchema,
  descriptor: modelSafeEvidenceDescriptorSchema,
}).strict();

export const generationLimitsSchema = z.object({
  maxNodes: z.number().int().positive().max(100_000),
  maxDepth: z.number().int().positive().max(256),
  maxActions: z.number().int().nonnegative().max(10_000),
  maxResourceBindings: z.number().int().nonnegative().max(10_000),
  maxEvidenceBindings: z.number().int().nonnegative().max(100_000),
  maxTextBytes: z.number().int().positive().max(16 * 1024 * 1024),
  maxOperations: z.number().int().positive().max(100_000),
}).strict();

export const catalogSetSliceResourceSchema = z.object({
  ...catalogSliceResourceSchema.shape,
  descriptor: modelSafeResourceDescriptorSchema,
  selectorPolicy: resourceSelectorPolicySchema,
}).strict();

export const catalogSetSliceEvidenceSchema = z.object({
  ...catalogSliceEvidenceSchema.shape,
  descriptor: modelSafeEvidenceDescriptorSchema,
}).strict();

const catalogSetSliceContentShape = {
  manifests: z.array(catalogManifestRefSchema).min(1).max(512),
  dependencyLockHash: sha256HashSchema,
  contractSetHash: sha256HashSchema,
  components: z.array(catalogSliceComponentSchema).min(1).max(10_000),
  actions: z.array(catalogSliceActionSchema).max(10_000),
  resources: z.array(catalogSetSliceResourceSchema).max(10_000),
  evidence: z.array(catalogSetSliceEvidenceSchema).max(100_000),
  limits: generationLimitsSchema,
  providerSchemaProfile: providerSchemaProfileSchema,
} as const;

function refineCatalogSetSlice(
  slice: {
    manifests: readonly CatalogManifestRef[];
    components: readonly { sliceComponentId: string }[];
    actions: readonly { sliceActionId: string }[];
    resources: readonly { sliceResourceId: string }[];
    evidence: readonly { sliceEvidenceId: string }[];
    limits: {
      maxActions: number;
      maxResourceBindings: number;
      maxEvidenceBindings: number;
    };
  },
  context: z.RefinementCtx,
): void {
  addCanonicalSetIssues(slice.manifests, context, "manifests");
  addCanonicalSetIssues(slice.components, context, "components");
  addCanonicalSetIssues(slice.actions, context, "actions");
  addCanonicalSetIssues(slice.resources, context, "resources");
  addCanonicalSetIssues(slice.evidence, context, "evidence");

  assertAllocatedIds(slice.components.map((entry) => entry.sliceComponentId), "component", context, "components");
  assertAllocatedIds(slice.actions.map((entry) => entry.sliceActionId), "action", context, "actions");
  assertAllocatedIds(slice.resources.map((entry) => entry.sliceResourceId), "resource", context, "resources");
  assertAllocatedIds(slice.evidence.map((entry) => entry.sliceEvidenceId), "evidence", context, "evidence");

  const allIds = [
    ...slice.components.map((entry) => entry.sliceComponentId),
    ...slice.actions.map((entry) => entry.sliceActionId),
    ...slice.resources.map((entry) => entry.sliceResourceId),
    ...slice.evidence.map((entry) => entry.sliceEvidenceId),
  ];
  if (new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: "custom", message: "Slice-local IDs must be globally unique.", path: [] });
  }
  if (slice.actions.length > slice.limits.maxActions) {
    context.addIssue({ code: "custom", message: "Slice actions exceed generation limits.", path: ["actions"] });
  }
  if (slice.resources.length > slice.limits.maxResourceBindings) {
    context.addIssue({ code: "custom", message: "Slice resources exceed generation limits.", path: ["resources"] });
  }
  if (slice.evidence.length > slice.limits.maxEvidenceBindings) {
    context.addIssue({ code: "custom", message: "Slice evidence exceed generation limits.", path: ["evidence"] });
  }
}

export const catalogSetSliceDefinitionSchema = z.object({
  ...catalogSetSliceContentShape,
}).strict().superRefine(refineCatalogSetSlice);

export const catalogSetSliceSchema = z.object({
  sliceHash: sha256HashSchema,
  ...catalogSetSliceContentShape,
}).strict().superRefine(refineCatalogSetSlice);

export const catalogSetSliceInputSchema = z.object({
  catalogs: z.array(catalogManifestSchema).min(1).max(512),
  rendererNegotiation: rendererCapabilityNegotiationResultSchema,
  components: z.array(contractRefSchema).min(1).max(10_000),
  actions: z.array(actionContractRefSchema).max(10_000),
  resources: z.array(modelVisibleResourceOfferSchema).max(10_000),
  evidence: z.array(modelVisibleEvidenceOfferSchema).max(100_000),
  limits: generationLimitsSchema,
  providerSchemaProfile: providerSchemaProfileSchema,
}).strict();

export type ModelSafeColumnDescriptor = z.infer<typeof modelSafeColumnDescriptorSchema>;
export type ModelSafeResourceDescriptor = z.infer<typeof modelSafeResourceDescriptorSchema>;
export type ModelSafeEvidenceDescriptor = z.infer<typeof modelSafeEvidenceDescriptorSchema>;
export type ModelVisibleResourceOffer = z.infer<typeof modelVisibleResourceOfferSchema>;
export type ModelVisibleEvidenceOffer = z.infer<typeof modelVisibleEvidenceOfferSchema>;
export type GenerationLimits = z.infer<typeof generationLimitsSchema>;
export type CatalogSetSliceResource = z.infer<typeof catalogSetSliceResourceSchema>;
export type CatalogSetSliceEvidence = z.infer<typeof catalogSetSliceEvidenceSchema>;
export type CatalogSetSliceDefinition = z.infer<typeof catalogSetSliceDefinitionSchema>;
export type CatalogSetSlice = z.infer<typeof catalogSetSliceSchema>;
export type CatalogSetSliceInput = z.infer<typeof catalogSetSliceInputSchema>;

export async function createModelVisibleResourceOffer(
  input: {
    bindingId: ResourceBindingId;
    descriptor: ModelSafeResourceDescriptor;
    selectorPolicy: z.infer<typeof resourceSelectorPolicySchema>;
  },
  provider?: HashProvider,
): Promise<ModelVisibleResourceOffer> {
  const bindingId = resourceBindingIdSchema.parse(input.bindingId);
  const descriptor = modelSafeResourceDescriptorSchema.parse({
    ...input.descriptor,
    columns: canonicalSet(input.descriptor.columns),
  });
  const selectorPolicy = resourceSelectorPolicySchema.parse(input.selectorPolicy);
  const offerHash = await computeHash(HASH_DOMAINS.resourceOffer, {
    bindingId,
    descriptor,
    selectorPolicy,
  }, provider);
  return deepFreeze(modelVisibleResourceOfferSchema.parse({
    source: { bindingId, offerHash },
    descriptor,
    selectorPolicy,
  }));
}

export async function verifyModelVisibleResourceOffer(
  input: unknown,
  provider?: HashProvider,
): Promise<ModelVisibleResourceOffer> {
  const offer = modelVisibleResourceOfferSchema.parse(input);
  const expected = await computeHash(HASH_DOMAINS.resourceOffer, {
    bindingId: offer.source.bindingId,
    descriptor: offer.descriptor,
    selectorPolicy: offer.selectorPolicy,
  }, provider);
  assertHash(offer.source.offerHash, expected, "catalog.resource-offer-hash", "Resource offer");
  return deepFreeze(offer);
}

export async function createModelVisibleEvidenceOffer(
  input: { evidenceId: EvidenceId; descriptor: ModelSafeEvidenceDescriptor },
  provider?: HashProvider,
): Promise<ModelVisibleEvidenceOffer> {
  const evidenceId = evidenceIdSchema.parse(input.evidenceId);
  const descriptor = modelSafeEvidenceDescriptorSchema.parse(input.descriptor);
  const offerHash = await computeHash(HASH_DOMAINS.evidenceOffer, { evidenceId, descriptor }, provider);
  return deepFreeze(modelVisibleEvidenceOfferSchema.parse({
    source: { evidenceId, offerHash },
    descriptor,
  }));
}

export async function verifyModelVisibleEvidenceOffer(
  input: unknown,
  provider?: HashProvider,
): Promise<ModelVisibleEvidenceOffer> {
  const offer = modelVisibleEvidenceOfferSchema.parse(input);
  const expected = await computeHash(HASH_DOMAINS.evidenceOffer, {
    evidenceId: offer.source.evidenceId,
    descriptor: offer.descriptor,
  }, provider);
  assertHash(offer.source.offerHash, expected, "catalog.evidence-offer-hash", "Evidence offer");
  return deepFreeze(offer);
}

export async function computeCatalogSetSliceHash(
  input: CatalogSetSliceDefinition,
  provider?: HashProvider,
) {
  const definition = catalogSetSliceDefinitionSchema.parse(input);
  return computeHash(HASH_DOMAINS.catalogSlice, definition, provider);
}

export async function createCatalogSetSlice(
  input: CatalogSetSliceInput,
  provider?: HashProvider,
): Promise<CatalogSetSlice> {
  const parsed = catalogSetSliceInputSchema.parse(input);
  const catalogs = canonicalSet(await Promise.all(parsed.catalogs.map((catalog) => verifyCatalogManifest(catalog, provider))));
  const manifests = catalogs.map((catalog) => catalog.ref);
  const components = canonicalSet(parsed.components);
  const actions = canonicalSet(parsed.actions);
  const resources = canonicalSet(await Promise.all(parsed.resources.map((offer) => verifyModelVisibleResourceOffer(offer, provider))));
  const evidence = canonicalSet(await Promise.all(parsed.evidence.map((offer) => verifyModelVisibleEvidenceOffer(offer, provider))));
  assertCatalogMembership(catalogs, components, actions);
  assertRendererNegotiation(parsed.rendererNegotiation, components);

  const [dependencyLockHash, contractSetHash] = await Promise.all([
    computeDependencyLockHash(manifests, provider),
    computeContractSetHash(components, provider),
  ]);
  const definition = catalogSetSliceDefinitionSchema.parse({
    manifests,
    dependencyLockHash,
    contractSetHash,
    components: components.map((contract, index) => ({
      sliceComponentId: sliceComponentIdSchema.parse(allocatedId("component", index)),
      contract,
    })),
    actions: actions.map((contract, index) => ({
      sliceActionId: sliceActionIdSchema.parse(allocatedId("action", index)),
      contract,
    })),
    resources: resources.map((offer, index) => ({
      sliceResourceId: sliceResourceIdSchema.parse(allocatedId("resource", index)),
      source: offer.source,
      descriptor: offer.descriptor,
      selectorPolicy: offer.selectorPolicy,
    })),
    evidence: evidence.map((offer, index) => ({
      sliceEvidenceId: sliceEvidenceIdSchema.parse(allocatedId("evidence", index)),
      source: offer.source,
      descriptor: offer.descriptor,
    })),
    limits: parsed.limits,
    providerSchemaProfile: parsed.providerSchemaProfile,
  });
  const sliceHash = await computeCatalogSetSliceHash(definition, provider);
  return deepFreeze(catalogSetSliceSchema.parse({ ...definition, sliceHash }));
}

export async function verifyCatalogSetSlice(
  input: unknown,
  provider?: HashProvider,
): Promise<CatalogSetSlice> {
  const slice = catalogSetSliceSchema.parse(input);
  await Promise.all([
    ...slice.resources.map((entry) => verifyModelVisibleResourceOffer({
      source: entry.source,
      descriptor: entry.descriptor,
      selectorPolicy: entry.selectorPolicy,
    }, provider)),
    ...slice.evidence.map((entry) => verifyModelVisibleEvidenceOffer({
      source: entry.source,
      descriptor: entry.descriptor,
    }, provider)),
  ]);
  const [dependencyLockHash, contractSetHash] = await Promise.all([
    computeDependencyLockHash(slice.manifests, provider),
    computeContractSetHash(slice.components.map((entry) => entry.contract), provider),
  ]);
  assertHash(slice.dependencyLockHash, dependencyLockHash, "catalog.slice-dependency-lock-hash", "Slice dependency lock");
  assertHash(slice.contractSetHash, contractSetHash, "catalog.slice-contract-set-hash", "Slice contract set");
  const definition = catalogSetSliceDefinitionSchema.parse({
    manifests: slice.manifests,
    dependencyLockHash: slice.dependencyLockHash,
    contractSetHash: slice.contractSetHash,
    components: slice.components,
    actions: slice.actions,
    resources: slice.resources,
    evidence: slice.evidence,
    limits: slice.limits,
    providerSchemaProfile: slice.providerSchemaProfile,
  });
  const expected = await computeCatalogSetSliceHash(definition, provider);
  assertHash(slice.sliceHash, expected, "catalog.slice-hash", "Catalog slice");
  return deepFreeze(slice);
}

function allocatedId(kind: "component" | "action" | "resource" | "evidence", index: number): string {
  return `${kind}-${String(index + 1).padStart(6, "0")}`;
}

function assertAllocatedIds(
  ids: readonly string[],
  kind: "component" | "action" | "resource" | "evidence",
  context: z.RefinementCtx,
  path: PropertyKey,
): void {
  for (const [index, id] of ids.entries()) {
    if (id !== allocatedId(kind, index)) {
      context.addIssue({
        code: "custom",
        message: `Expected deterministic ${kind} Slice ID ${allocatedId(kind, index)}.`,
        path: [path, index],
      });
    }
  }
}

function assertCatalogMembership(
  catalogs: readonly CatalogManifest[],
  components: readonly ContractRef[],
  actions: readonly ActionContractRef[],
): void {
  for (const contract of components) {
    if (!catalogs.some((catalog) => findComponentRef(catalog, contract))) {
      throw new Error(`Component ${contractRefKey(contract)} is not present in the frozen catalog set.`);
    }
  }
  for (const contract of actions) {
    if (!catalogs.some((catalog) => findActionRef(catalog, contract))) {
      throw new Error(`Action ${actionContractRefKey(contract)} is not present in the frozen catalog set.`);
    }
  }
}

function assertRendererNegotiation(
  negotiation: RendererCapabilityNegotiationResult,
  components: readonly ContractRef[],
): void {
  const supported = new Set(negotiation.supported.map(contractRefKey));
  for (const contract of components) {
    if (!supported.has(contractRefKey(contract))) {
      throw new Error(`Component ${contractRefKey(contract)} was not accepted by renderer capability negotiation.`);
    }
  }
}
