import {
  contractRefKey,
  createRendererCapabilityManifest,
  rendererCapabilityManifestSchema,
  verifyRendererCapabilityManifest,
  type RendererCapabilityManifest,
} from "@open-generative/catalog";
import {
  canonicalStringify,
  sha256HashSchema,
  type HashProvider,
  type Sha256Hash,
} from "@open-generative/protocol";
import { z } from "zod";
import { chartCapabilityTokens, officialChartRecipeSource } from "./chart-recipes";
import {
  type OfficialCatalogBundle,
} from "./contracts";
import { officialComponentTypeSchema, officialComponentTypes } from "./fixtures";
import { hashNamespacedCanonical } from "./integrity";
import { deepFreeze } from "./schema";

const artifactPathSchema = z.string().regex(/^[a-z0-9][a-z0-9./_-]*\.[a-z0-9]+$/);
const artifactSchema = z.object({
  path: artifactPathSchema,
  hash: sha256HashSchema,
}).strict();
const contractChunkSchema = z.object({
  componentType: officialComponentTypeSchema,
  path: artifactPathSchema,
}).strict();

export const officialRendererArtifactSetSchema = z.object({
  chunks: z.array(artifactSchema).min(1).max(512),
  assets: z.array(artifactSchema).max(2_048),
  contractChunks: z.array(contractChunkSchema).length(officialComponentTypes.length),
}).strict().superRefine((artifacts, context) => {
  addSortedUniquePathIssues(artifacts.chunks, context, "chunks");
  addSortedUniquePathIssues(artifacts.assets, context, "assets");
  const contractTypes = artifacts.contractChunks.map((binding) => binding.componentType);
  if (new Set(contractTypes).size !== contractTypes.length) {
    context.addIssue({ code: "custom", path: ["contractChunks"], message: "Contract chunk bindings must be unique." });
  }
  if (contractTypes.some((componentType, index) => componentType !== officialComponentTypes[index])) {
    context.addIssue({ code: "custom", path: ["contractChunks"], message: "Contract chunk bindings must use canonical component order." });
  }
  const chunkPaths = new Set(artifacts.chunks.map((chunk) => chunk.path));
  for (const [index, binding] of artifacts.contractChunks.entries()) {
    if (!chunkPaths.has(binding.path)) {
      context.addIssue({ code: "custom", path: ["contractChunks", index, "path"], message: "Contract chunk binding references an unknown chunk." });
    }
  }
});

export type OfficialRendererArtifactSet = z.infer<typeof officialRendererArtifactSetSchema>;
export type OfficialComponentType = z.infer<typeof officialComponentTypeSchema>;

export const officialRendererReleaseSchema = z.object({
  manifest: rendererCapabilityManifestSchema,
  artifacts: officialRendererArtifactSetSchema,
}).strict();

export type OfficialRendererRelease = z.infer<typeof officialRendererReleaseSchema>;

export const officialRendererBuildProfile = deepFreeze({
  rendererId: "open-generative.ui",
  rendererRevision: "0.3.9",
  conformanceRevision: "0.3.9",
  packageName: "@open-generative/ui",
  packageVersion: "0.3.9",
  peerDependencies: {
    react: ">=19.0.0",
    reactDom: ">=19.0.0",
  },
  runtimeDependencies: [
    {
      packageName: "lucide-react",
      version: "1.31.0",
      integrity: "sha512-G8u2eEtoHUnUa9f8lbvqDhCiORMnYLdUEo06EEG9MQvHQrInKcX3Pa2TH39MM5qyzRcWETxB0+aOwAPI1g1kEg==",
    },
    {
      packageName: officialChartRecipeSource.rendererPackages.chartEngine.packageName,
      version: officialChartRecipeSource.rendererPackages.chartEngine.version,
      integrity: officialChartRecipeSource.rendererPackages.chartEngine.integrity,
    },
  ],
} as const);

const baseRendererFeatures = ["accessibility.semantic-html", "projection.read-only-preview"] as const;

export const officialRendererFeatures: Readonly<Record<OfficialComponentType, readonly string[]>> = deepFreeze({
  "content.callout": [...baseRendererFeatures, "event.dismiss", "tone.semantic"].sort(),
  "content.empty": [...baseRendererFeatures, "event.retry", "state.empty"].sort(),
  "content.text": [...baseRendererFeatures, "content.code", "content.heading"].sort(),
  "control.filter": [...baseRendererFeatures, "event.apply", "event.change", "event.reset", "filter.date-range", "filter.multi-select"].sort(),
  "control.group": [...baseRendererFeatures, "event.apply", "event.reset", "layout.control-group"].sort(),
  "data.chart": [
    ...baseRendererFeatures,
    "accessibility.equivalent-view",
    ...chartCapabilityTokens,
    "motion.reduced",
    "size.stable",
  ].sort(),
  "data.metric": [...baseRendererFeatures, "event.select", "format.semantic"].sort(),
  "data.query-details": [...baseRendererFeatures, "event.copy", "event.export", "query.evidence", "query.freshness", "query.lineage", "query.sql"].sort(),
  "data.table": [...baseRendererFeatures, "event.export", "event.page-change", "event.row-select", "event.sort-change", "pagination.host-window", "selection.multiple", "selection.single"].sort(),
  "layout.grid": [...baseRendererFeatures, "layout.responsive-grid"].sort(),
  "layout.section": [...baseRendererFeatures, "layout.semantic-section"].sort(),
  "layout.stack": [...baseRendererFeatures, "layout.stack"].sort(),
});

export function createSingleChunkOfficialRendererArtifactSet(input: Readonly<{
  chunkHash: Sha256Hash;
  stylesheetHash: Sha256Hash;
}>): OfficialRendererArtifactSet {
  return deepFreeze(officialRendererArtifactSetSchema.parse({
    chunks: [{ path: "index.mjs", hash: input.chunkHash }],
    assets: [{ path: "styles.css", hash: input.stylesheetHash }],
    contractChunks: officialComponentTypes.map((componentType) => ({ componentType, path: "index.mjs" })),
  }));
}

export async function createOfficialRendererCapabilityManifest(
  catalog: OfficialCatalogBundle,
  artifacts: OfficialRendererArtifactSet,
  provider?: HashProvider,
): Promise<RendererCapabilityManifest> {
  const parsedArtifacts = officialRendererArtifactSetSchema.parse(artifacts);
  assertOfficialCatalogCoverage(catalog);
  const implementationHash = await hashNamespacedCanonical(
    "open-generative.official-renderer-implementation",
    { buildProfile: officialRendererBuildProfile, artifacts: parsedArtifacts },
    provider,
  );
  const chunks = new Map(parsedArtifacts.chunks.map((chunk) => [chunk.path, chunk.hash]));
  const bindings = new Map(parsedArtifacts.contractChunks.map((binding) => [binding.componentType, binding.path]));
  const assetHashes = [...parsedArtifacts.assets.map((asset) => asset.hash)].sort();

  return createRendererCapabilityManifest({
    rendererId: officialRendererBuildProfile.rendererId,
    rendererRevision: officialRendererBuildProfile.rendererRevision,
    implementationHash,
    conformanceRevision: officialRendererBuildProfile.conformanceRevision,
    contracts: catalog.componentContracts.map((contract) => {
      const componentType = officialComponentTypeSchema.parse(contract.ref.componentType);
      const chunkPath = bindings.get(componentType);
      const chunkHash = chunkPath === undefined ? undefined : chunks.get(chunkPath);
      if (chunkHash === undefined) throw new TypeError(`Missing renderer chunk for ${componentType}.`);
      return {
        contract: contract.ref,
        placements: contract.placements,
        features: [...officialRendererFeatures[componentType]],
        chunkHash,
        assetHashes,
      };
    }),
  }, provider);
}

export async function verifyOfficialRendererCapabilityManifest(
  input: unknown,
  catalog: OfficialCatalogBundle,
  provider?: HashProvider,
): Promise<RendererCapabilityManifest> {
  const manifest = await verifyRendererCapabilityManifest(input, provider);
  assertOfficialCatalogCoverage(catalog);
  if (
    manifest.rendererId !== officialRendererBuildProfile.rendererId
    || manifest.rendererRevision !== officialRendererBuildProfile.rendererRevision
    || manifest.conformanceRevision !== officialRendererBuildProfile.conformanceRevision
  ) {
    throw new Error("Renderer capability manifest does not identify the official UI renderer.");
  }

  const expectedContracts = new Map(catalog.componentContracts.map((contract) => [contractRefKey(contract.ref), contract]));
  if (manifest.contracts.length !== expectedContracts.size) {
    throw new Error("Renderer capability manifest does not cover the exact official catalog.");
  }
  for (const capability of manifest.contracts) {
    const contract = expectedContracts.get(contractRefKey(capability.contract));
    if (contract === undefined) throw new Error("Renderer capability manifest contains a non-official contract.");
    const componentType = officialComponentTypeSchema.parse(contract.ref.componentType);
    if (canonicalStringify(capability.placements) !== canonicalStringify(contract.placements)) {
      throw new Error(`Renderer placement binding mismatch for ${componentType}.`);
    }
    if (canonicalStringify(capability.features) !== canonicalStringify(officialRendererFeatures[componentType])) {
      throw new Error(`Renderer feature binding mismatch for ${componentType}.`);
    }
  }
  return manifest;
}

export async function verifyOfficialRendererArtifacts(
  input: unknown,
  catalog: OfficialCatalogBundle,
  artifacts: OfficialRendererArtifactSet,
  provider?: HashProvider,
): Promise<RendererCapabilityManifest> {
  const [manifest, expected] = await Promise.all([
    verifyOfficialRendererCapabilityManifest(input, catalog, provider),
    createOfficialRendererCapabilityManifest(catalog, artifacts, provider),
  ]);
  if (canonicalStringify(manifest) !== canonicalStringify(expected)) {
    throw new Error("Renderer capability manifest does not match the supplied release artifacts.");
  }
  return manifest;
}

export async function createOfficialRendererRelease(
  catalog: OfficialCatalogBundle,
  artifacts: OfficialRendererArtifactSet,
  provider?: HashProvider,
): Promise<OfficialRendererRelease> {
  const parsedArtifacts = officialRendererArtifactSetSchema.parse(artifacts);
  const manifest = await createOfficialRendererCapabilityManifest(catalog, parsedArtifacts, provider);
  return deepFreeze(officialRendererReleaseSchema.parse({ manifest, artifacts: parsedArtifacts }));
}

export async function verifyOfficialRendererRelease(
  input: unknown,
  catalog: OfficialCatalogBundle,
  provider?: HashProvider,
): Promise<OfficialRendererRelease> {
  const release = officialRendererReleaseSchema.parse(input);
  const manifest = await verifyOfficialRendererArtifacts(
    release.manifest,
    catalog,
    release.artifacts,
    provider,
  );
  return deepFreeze(officialRendererReleaseSchema.parse({ manifest, artifacts: release.artifacts }));
}

function assertOfficialCatalogCoverage(catalog: OfficialCatalogBundle): void {
  const actual = catalog.componentContracts.map((contract) => contract.ref.componentType).sort();
  if (canonicalStringify(actual) !== canonicalStringify([...officialComponentTypes])) {
    throw new TypeError("Official renderer integrity requires the exact official component catalog.");
  }
}

function addSortedUniquePathIssues(
  artifacts: readonly Readonly<{ path: string }>[],
  context: z.RefinementCtx,
  path: "assets" | "chunks",
): void {
  const paths = artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: [path], message: "Artifact paths must be unique." });
  }
  const sorted = [...paths].sort();
  if (paths.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: "custom", path: [path], message: "Artifact paths must use canonical order." });
  }
}
