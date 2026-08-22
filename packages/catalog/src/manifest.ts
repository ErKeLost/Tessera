import {
  actionContractRefSchema,
  catalogManifestRefSchema,
  contractRefSchema,
  HASH_DOMAINS,
  hashProfileIdSchema,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  sha256HashSchema,
  type ActionContractRef,
  type CatalogManifestRef,
  type ContractRef,
  type HashProvider,
} from "@open-generative/protocol";
import { z } from "zod";
import { actionContractRefKey, contractRefKey } from "./contracts";
import {
  addCanonicalSetIssues,
  assertHash,
  canonicalSet,
  computeHash,
  deepFreeze,
} from "./internal";

const catalogManifestIdentitySchema = catalogManifestRefSchema.omit({ manifestHash: true });

const catalogManifestContentShape = {
  protocolRevision: z.literal(OPEN_GENERATIVE_PROTOCOL_REVISION),
  hashProfile: hashProfileIdSchema,
  dependencyLockHash: sha256HashSchema,
  contractSetHash: sha256HashSchema,
  dependencies: z.array(catalogManifestRefSchema).max(512),
  components: z.array(contractRefSchema).max(10_000),
  actions: z.array(actionContractRefSchema).max(10_000),
} as const;

function refineCatalogManifest(
  manifest: {
    ref: { publisher: string; catalogId: string; catalogRevision: string };
    dependencies: readonly CatalogManifestRef[];
    components: readonly ContractRef[];
    actions: readonly ActionContractRef[];
  },
  context: z.RefinementCtx,
): void {
  addCanonicalSetIssues(manifest.dependencies, context, "dependencies");
  addCanonicalSetIssues(manifest.components, context, "components");
  addCanonicalSetIssues(manifest.actions, context, "actions");

  for (const [index, contract] of manifest.components.entries()) {
    if (contract.publisher !== manifest.ref.publisher || contract.catalogId !== manifest.ref.catalogId) {
      context.addIssue({
        code: "custom",
        message: "A manifest may only own component contracts in its publisher/catalog identity.",
        path: ["components", index],
      });
    }
  }
  for (const [index, contract] of manifest.actions.entries()) {
    if (contract.publisher !== manifest.ref.publisher || contract.catalogId !== manifest.ref.catalogId) {
      context.addIssue({
        code: "custom",
        message: "A manifest may only own action contracts in its publisher/catalog identity.",
        path: ["actions", index],
      });
    }
  }
  for (const [index, dependency] of manifest.dependencies.entries()) {
    if (
      dependency.publisher === manifest.ref.publisher
      && dependency.catalogId === manifest.ref.catalogId
      && dependency.catalogRevision === manifest.ref.catalogRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "A catalog manifest cannot depend on itself.",
        path: ["dependencies", index],
      });
    }
  }
}

export const catalogManifestDefinitionSchema = z.object({
  ref: catalogManifestIdentitySchema,
  ...catalogManifestContentShape,
}).strict().superRefine(refineCatalogManifest);

export const catalogManifestSchema = z.object({
  ref: catalogManifestRefSchema,
  ...catalogManifestContentShape,
}).strict().superRefine(refineCatalogManifest);

export const catalogManifestInputSchema = z.object({
  ref: catalogManifestIdentitySchema,
  dependencies: z.array(catalogManifestRefSchema).max(512),
  components: z.array(contractRefSchema).max(10_000),
  actions: z.array(actionContractRefSchema).max(10_000),
}).strict();

export type CatalogManifestDefinition = z.infer<typeof catalogManifestDefinitionSchema>;
export type CatalogManifest = z.infer<typeof catalogManifestSchema>;
export type CatalogManifestInput = z.infer<typeof catalogManifestInputSchema>;

export async function computeContractSetHash(
  contracts: readonly ContractRef[],
  provider?: HashProvider,
) {
  const canonicalContracts = canonicalSet(contracts.map((contract) => contractRefSchema.parse(contract)));
  return computeHash(HASH_DOMAINS.catalogSet, {
    kind: "component-contract-set",
    contracts: canonicalContracts,
  }, provider);
}

export async function computeDependencyLockHash(
  manifests: readonly CatalogManifestRef[],
  provider?: HashProvider,
) {
  const canonicalManifests = canonicalSet(manifests.map((manifest) => catalogManifestRefSchema.parse(manifest)));
  return computeHash(HASH_DOMAINS.catalogSet, {
    kind: "catalog-dependency-lock",
    manifests: canonicalManifests,
  }, provider);
}

export async function computeCatalogManifestHash(
  input: CatalogManifestDefinition,
  provider?: HashProvider,
) {
  const definition = catalogManifestDefinitionSchema.parse(input);
  return computeHash(HASH_DOMAINS.catalogManifest, definition, provider);
}

export async function createCatalogManifest(
  input: CatalogManifestInput,
  provider?: HashProvider,
): Promise<CatalogManifest> {
  const parsed = catalogManifestInputSchema.parse(input);
  const dependencies = canonicalSet(parsed.dependencies);
  const components = canonicalSet(parsed.components);
  const actions = canonicalSet(parsed.actions);
  const [dependencyLockHash, contractSetHash] = await Promise.all([
    computeDependencyLockHash(dependencies, provider),
    computeContractSetHash(components, provider),
  ]);
  const definition = catalogManifestDefinitionSchema.parse({
    ref: parsed.ref,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
    dependencyLockHash,
    contractSetHash,
    dependencies,
    components,
    actions,
  });
  const manifestHash = await computeCatalogManifestHash(definition, provider);
  return deepFreeze(catalogManifestSchema.parse({
    ...definition,
    ref: { ...definition.ref, manifestHash },
  }));
}

export async function verifyCatalogManifest(
  input: unknown,
  provider?: HashProvider,
): Promise<CatalogManifest> {
  const manifest = catalogManifestSchema.parse(input);
  const [dependencyLockHash, contractSetHash] = await Promise.all([
    computeDependencyLockHash(manifest.dependencies, provider),
    computeContractSetHash(manifest.components, provider),
  ]);
  assertHash(
    manifest.dependencyLockHash,
    dependencyLockHash,
    "catalog.dependency-lock-hash",
    "Catalog dependency lock",
  );
  assertHash(manifest.contractSetHash, contractSetHash, "catalog.contract-set-hash", "Contract set");
  const definition = catalogManifestDefinitionSchema.parse({
    ...manifest,
    ref: {
      publisher: manifest.ref.publisher,
      catalogId: manifest.ref.catalogId,
      catalogRevision: manifest.ref.catalogRevision,
      ...(manifest.ref.signatureRef === undefined ? {} : { signatureRef: manifest.ref.signatureRef }),
    },
  });
  const manifestHash = await computeCatalogManifestHash(definition, provider);
  assertHash(manifest.ref.manifestHash, manifestHash, "catalog.manifest-hash", "Catalog manifest");
  return deepFreeze(manifest);
}

export function findComponentRef(manifest: CatalogManifest, ref: ContractRef): ContractRef | undefined {
  const key = contractRefKey(ref);
  return manifest.components.find((candidate) => contractRefKey(candidate) === key);
}

export function findActionRef(manifest: CatalogManifest, ref: ActionContractRef): ActionContractRef | undefined {
  const key = actionContractRefKey(ref);
  return manifest.actions.find((candidate) => actionContractRefKey(candidate) === key);
}
