import {
  contractRefSchema,
  HASH_DOMAINS,
  sha256HashSchema,
  type ContractRef,
  type HashProvider,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  componentContractSchema,
  contractRefKey,
  placementConstraintSchema,
  placementKindSchema,
  verifyComponentContract,
  type ComponentContract,
  type PlacementConstraint,
} from "./contracts";
import {
  addCanonicalSetIssues,
  addSortedUniqueStringIssues,
  assertHash,
  canonicalSet,
  computeHash,
  deepFreeze,
  sortedUniqueStrings,
} from "./internal";
import {
  catalogManifestSchema,
  findComponentRef,
  verifyCatalogManifest,
  type CatalogManifest,
} from "./manifest";

const rendererIdSchema = z.string().min(1).max(192).regex(/^[a-z0-9][a-z0-9._-]*$/);
const rendererRevisionSchema = z.string().min(1).max(192).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const featureTokenSchema = z.string().min(1).max(192).regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/);

export const rendererContractCapabilitySchema = z.object({
  contract: contractRefSchema,
  placements: z.array(placementConstraintSchema).min(1).max(64),
  features: z.array(featureTokenSchema).max(512),
  chunkHash: sha256HashSchema,
  assetHashes: z.array(sha256HashSchema).max(2_048),
}).strict().superRefine((capability, context) => {
  addCanonicalSetIssues(capability.placements, context, "placements");
  addSortedUniqueStringIssues(capability.features, context, "features");
  addSortedUniqueStringIssues(capability.assetHashes, context, "assetHashes");
});

const rendererCapabilityManifestContentShape = {
  rendererId: rendererIdSchema,
  rendererRevision: rendererRevisionSchema,
  implementationHash: sha256HashSchema,
  conformanceRevision: rendererRevisionSchema,
  contracts: z.array(rendererContractCapabilitySchema).max(10_000),
} as const;

export const rendererCapabilityManifestDefinitionSchema = z.object({
  ...rendererCapabilityManifestContentShape,
}).strict().superRefine((manifest, context) => {
  addCanonicalSetIssues(manifest.contracts, context, "contracts");
  const identities = new Set<string>();
  for (const [index, capability] of manifest.contracts.entries()) {
    const key = contractRefKey(capability.contract);
    if (identities.has(key)) {
      context.addIssue({ code: "custom", message: "A contract capability may only appear once.", path: ["contracts", index] });
    }
    identities.add(key);
  }
});

export const rendererCapabilityManifestSchema = z.object({
  manifestHash: sha256HashSchema,
  ...rendererCapabilityManifestContentShape,
}).strict().superRefine((manifest, context) => {
  addCanonicalSetIssues(manifest.contracts, context, "contracts");
  const identities = new Set<string>();
  for (const [index, capability] of manifest.contracts.entries()) {
    const key = contractRefKey(capability.contract);
    if (identities.has(key)) {
      context.addIssue({ code: "custom", message: "A contract capability may only appear once.", path: ["contracts", index] });
    }
    identities.add(key);
  }
});

export type RendererContractCapability = z.infer<typeof rendererContractCapabilitySchema>;
export type RendererCapabilityManifestDefinition = z.infer<typeof rendererCapabilityManifestDefinitionSchema>;
export type RendererCapabilityManifest = z.infer<typeof rendererCapabilityManifestSchema>;

export async function computeRendererCapabilityManifestHash(
  input: RendererCapabilityManifestDefinition,
  provider?: HashProvider,
) {
  const definition = rendererCapabilityManifestDefinitionSchema.parse(input);
  return computeHash(HASH_DOMAINS.rendererCapabilityManifest, definition, provider);
}

export async function createRendererCapabilityManifest(
  input: RendererCapabilityManifestDefinition,
  provider?: HashProvider,
): Promise<RendererCapabilityManifest> {
  const normalized = normalizeRendererManifestDefinition(input);
  const manifestHash = await computeRendererCapabilityManifestHash(normalized, provider);
  return deepFreeze(rendererCapabilityManifestSchema.parse({ ...normalized, manifestHash }));
}

export async function verifyRendererCapabilityManifest(
  input: unknown,
  provider?: HashProvider,
): Promise<RendererCapabilityManifest> {
  const manifest = rendererCapabilityManifestSchema.parse(input);
  const definition = rendererCapabilityManifestDefinitionSchema.parse({
    rendererId: manifest.rendererId,
    rendererRevision: manifest.rendererRevision,
    implementationHash: manifest.implementationHash,
    conformanceRevision: manifest.conformanceRevision,
    contracts: manifest.contracts,
  });
  const expected = await computeRendererCapabilityManifestHash(definition, provider);
  assertHash(
    manifest.manifestHash,
    expected,
    "catalog.renderer-capability-manifest-hash",
    "Renderer capability manifest",
  );
  return deepFreeze(manifest);
}

function normalizeRendererManifestDefinition(
  input: RendererCapabilityManifestDefinition,
): RendererCapabilityManifestDefinition {
  return rendererCapabilityManifestDefinitionSchema.parse({
    ...input,
    contracts: canonicalSet(input.contracts.map((capability) => ({
      ...capability,
      placements: canonicalSet(capability.placements),
      features: sortedUniqueStrings(capability.features),
      assetHashes: sortedUniqueStrings(capability.assetHashes),
    }))),
  });
}

export const placementContextSchema = z.object({
  kind: placementKindSchema,
  width: z.number().int().nonnegative().max(100_000),
  height: z.number().int().nonnegative().max(100_000),
}).strict();

export const rendererCapabilityRequirementSchema = z.object({
  contract: componentContractSchema,
  requiredFeatures: z.array(featureTokenSchema).max(512),
}).strict().superRefine((requirement, context) => {
  addSortedUniqueStringIssues(requirement.requiredFeatures, context, "requiredFeatures");
});

export const rendererCapabilityNegotiationInputSchema = z.object({
  catalogs: z.array(catalogManifestSchema).min(1).max(512),
  renderer: rendererCapabilityManifestSchema,
  placement: placementContextSchema,
  requirements: z.array(rendererCapabilityRequirementSchema).max(10_000),
}).strict().superRefine((input, context) => {
  addCanonicalSetIssues(input.catalogs, context, "catalogs");
  addCanonicalSetIssues(input.requirements, context, "requirements");
  const catalogIdentities = new Set<string>();
  for (const [index, catalog] of input.catalogs.entries()) {
    const identity = `${catalog.ref.publisher}/${catalog.ref.catalogId}`;
    if (catalogIdentities.has(identity)) {
      context.addIssue({
        code: "custom",
        message: "A negotiation cannot install multiple revisions of the same catalog identity.",
        path: ["catalogs", index],
      });
    }
    catalogIdentities.add(identity);
  }
});

export const rendererCapabilityRejectionReasonSchema = z.enum([
  "catalog-missing",
  "contract-not-in-manifest",
  "renderer-missing",
  "placement-unsupported",
  "feature-missing",
]);

export const rendererCapabilityNegotiationResultSchema = z.object({
  rendererCapabilityManifestHash: sha256HashSchema,
  supported: z.array(contractRefSchema),
  rejected: z.array(z.object({
    contract: contractRefSchema,
    reason: rendererCapabilityRejectionReasonSchema,
    missingFeatures: z.array(featureTokenSchema),
  }).strict()),
}).strict().superRefine((result, context) => {
  addCanonicalSetIssues(result.supported, context, "supported");
  addCanonicalSetIssues(result.rejected, context, "rejected");
});

export type PlacementContext = z.infer<typeof placementContextSchema>;
export type RendererCapabilityRequirement = z.infer<typeof rendererCapabilityRequirementSchema>;
export type RendererCapabilityNegotiationInput = z.infer<typeof rendererCapabilityNegotiationInputSchema>;
export type RendererCapabilityNegotiationResult = z.infer<typeof rendererCapabilityNegotiationResultSchema>;

export async function negotiateRendererCapabilities(
  input: RendererCapabilityNegotiationInput,
  provider?: HashProvider,
): Promise<RendererCapabilityNegotiationResult> {
  const parsed = rendererCapabilityNegotiationInputSchema.parse(input);
  const [renderer, catalogs, contracts] = await Promise.all([
    verifyRendererCapabilityManifest(parsed.renderer, provider),
    Promise.all(parsed.catalogs.map((catalog) => verifyCatalogManifest(catalog, provider))),
    Promise.all(parsed.requirements.map((requirement) => verifyComponentContract(requirement.contract, provider))),
  ]);

  const supported: ContractRef[] = [];
  const rejected: Array<{
    contract: ContractRef;
    reason: z.infer<typeof rendererCapabilityRejectionReasonSchema>;
    missingFeatures: string[];
  }> = [];

  for (const [index, contract] of contracts.entries()) {
    const requirement = parsed.requirements[index]!;
    const catalog = catalogs.find((candidate) => (
      candidate.ref.publisher === contract.ref.publisher
      && candidate.ref.catalogId === contract.ref.catalogId
    ));
    if (!catalog) {
      rejected.push({ contract: contract.ref, reason: "catalog-missing", missingFeatures: [] });
      continue;
    }
    if (!findComponentRef(catalog, contract.ref)) {
      rejected.push({ contract: contract.ref, reason: "contract-not-in-manifest", missingFeatures: [] });
      continue;
    }
    const capability = renderer.contracts.find((candidate) => contractRefKey(candidate.contract) === contractRefKey(contract.ref));
    if (!capability) {
      rejected.push({ contract: contract.ref, reason: "renderer-missing", missingFeatures: [] });
      continue;
    }
    if (
      !contract.placements.some((constraint) => placementMatches(constraint, parsed.placement))
      || !capability.placements.some((constraint) => placementMatches(constraint, parsed.placement))
    ) {
      rejected.push({ contract: contract.ref, reason: "placement-unsupported", missingFeatures: [] });
      continue;
    }
    const availableFeatures = new Set(capability.features);
    const missingFeatures = requirement.requiredFeatures.filter((feature) => !availableFeatures.has(feature));
    if (missingFeatures.length > 0) {
      rejected.push({ contract: contract.ref, reason: "feature-missing", missingFeatures });
      continue;
    }
    supported.push(contract.ref);
  }

  return deepFreeze(rendererCapabilityNegotiationResultSchema.parse({
    rendererCapabilityManifestHash: renderer.manifestHash,
    supported: canonicalSet(supported),
    rejected: canonicalSet(rejected),
  }));
}

function placementMatches(constraint: PlacementConstraint, placement: PlacementContext): boolean {
  return constraint.kind === placement.kind
    && (constraint.minWidth === undefined || placement.width >= constraint.minWidth)
    && (constraint.maxWidth === undefined || placement.width <= constraint.maxWidth)
    && (constraint.minHeight === undefined || placement.height >= constraint.minHeight)
    && (constraint.maxHeight === undefined || placement.height <= constraint.maxHeight);
}

export function rendererSupportsContract(
  manifest: RendererCapabilityManifest,
  contract: ContractRef,
): RendererContractCapability | undefined {
  const key = contractRefKey(contract);
  return manifest.contracts.find((candidate) => contractRefKey(candidate.contract) === key);
}

export function catalogForContract(
  manifests: readonly CatalogManifest[],
  contract: ContractRef,
): CatalogManifest | undefined {
  return manifests.find((manifest) => (
    manifest.ref.publisher === contract.publisher
    && manifest.ref.catalogId === contract.catalogId
  ));
}
