import type { AdapterContext, ArtifactPart, NormalizedArtifactProposal } from "./types";

const artifactPartBrand = Symbol("data-elements.validated-artifact-part");
const brandedParts = new WeakSet<object>();

export function createValidatedArtifactPart(
  snapshot: Readonly<NormalizedArtifactProposal>,
  context: AdapterContext,
): ArtifactPart<Readonly<NormalizedArtifactProposal>> {
  const part = {
    kind: "artifact-snapshot" as const,
    snapshot,
    contractFingerprint: context.contractFingerprint,
    promptBundleHash: context.promptBundleHash,
    generationTaintHash: context.generationTaintHash,
  };
  Object.defineProperty(part, artifactPartBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  brandedParts.add(part);
  return Object.freeze(part) as unknown as ArtifactPart<Readonly<NormalizedArtifactProposal>>;
}

export function isArtifactPart(value: unknown): value is ArtifactPart {
  return Boolean(value && typeof value === "object" && brandedParts.has(value));
}
