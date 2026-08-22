import {
  contractRefKey,
  placementConstraintSchema,
  placementContextSchema,
  verifyRendererCapabilityManifest,
  type ComponentContract,
  type PlacementConstraint,
  type PlacementContext,
  type RendererCapabilityManifest,
} from "@open-generative/catalog";
import {
  canonicalStringify,
  contractRefSchema,
  sha256HashSchema,
  type ContractRef,
  type HashProvider,
} from "@open-generative/protocol";
import type {
  RendererRegistration,
  RendererResolution,
} from "./types";

export class RendererRegistry {
  readonly #byContract: ReadonlyMap<string, RendererRegistration>;
  readonly #registrations: readonly RendererRegistration[];

  constructor(registrations: readonly RendererRegistration[] = []) {
    const byContract = new Map<string, RendererRegistration>();
    const normalized: RendererRegistration[] = [];

    for (const candidate of registrations) {
      const contract = freezeContractRef(contractRefSchema.parse(candidate.contract));
      if (candidate.placements.length === 0) {
        throw new TypeError(`Renderer ${contractRefKey(contract)} must support at least one placement.`);
      }
      const placements = Object.freeze(candidate.placements.map((placement) => (
        Object.freeze(placementConstraintSchema.parse(placement))
      )));
      const registration = Object.freeze({
        contract,
        placements,
        renderer: candidate.renderer,
        ...(candidate.integrity === undefined ? {} : { integrity: freezeIntegrity(candidate.integrity) }),
      });
      const key = contractRefKey(contract);
      if (byContract.has(key)) {
        throw new TypeError(`Renderer ${key} is registered more than once.`);
      }
      byContract.set(key, registration);
      normalized.push(registration);
    }

    this.#byContract = byContract;
    this.#registrations = Object.freeze(normalized);
    Object.freeze(this);
  }

  get size(): number {
    return this.#registrations.length;
  }

  get(contract: ContractRef): RendererRegistration | undefined {
    return this.#byContract.get(contractRefKey(contract));
  }

  entries(): readonly RendererRegistration[] {
    return this.#registrations;
  }

  resolve(
    contract: ComponentContract,
    placement: PlacementContext,
  ): RendererResolution {
    const parsedPlacement = placementContextSchema.parse(placement);
    const registration = this.get(contract.ref);
    if (!registration) {
      return Object.freeze({ status: "unsupported", reason: "renderer-missing" });
    }
    if (
      !contract.placements.some((constraint) => placementMatches(constraint, parsedPlacement))
      || !registration.placements.some((constraint) => placementMatches(constraint, parsedPlacement))
    ) {
      return Object.freeze({ status: "unsupported", reason: "placement-unsupported" });
    }
    return Object.freeze({ status: "ready", registration });
  }
}

export function createRendererRegistry(
  registrations: readonly RendererRegistration[] = [],
): RendererRegistry {
  return new RendererRegistry(registrations);
}

export async function createVerifiedRendererRegistry(
  registrations: readonly RendererRegistration[],
  manifest: RendererCapabilityManifest,
  provider?: HashProvider,
): Promise<RendererRegistry> {
  const verified = await verifyRendererCapabilityManifest(manifest, provider);
  if (registrations.length !== verified.contracts.length) {
    throw new TypeError("Verified renderer registrations must exactly cover the capability manifest.");
  }
  const byContract = new Map(registrations.map((registration) => [contractRefKey(registration.contract), registration]));
  const bound = verified.contracts.map((capability) => {
    const registration = byContract.get(contractRefKey(capability.contract));
    if (registration === undefined) {
      throw new TypeError(`Renderer registration is missing ${contractRefKey(capability.contract)}.`);
    }
    if (canonicalStringify(registration.placements) !== canonicalStringify(capability.placements)) {
      throw new TypeError(`Renderer placement binding does not match ${contractRefKey(capability.contract)}.`);
    }
    return {
      ...registration,
      integrity: {
        rendererCapabilityManifestHash: verified.manifestHash,
        implementationHash: verified.implementationHash,
        chunkHash: capability.chunkHash,
        assetHashes: capability.assetHashes,
      },
    } satisfies RendererRegistration;
  });
  return new RendererRegistry(bound);
}

function placementMatches(
  constraint: PlacementConstraint,
  placement: PlacementContext,
): boolean {
  return constraint.kind === placement.kind
    && (constraint.minWidth === undefined || placement.width >= constraint.minWidth)
    && (constraint.maxWidth === undefined || placement.width <= constraint.maxWidth)
    && (constraint.minHeight === undefined || placement.height >= constraint.minHeight)
    && (constraint.maxHeight === undefined || placement.height <= constraint.maxHeight);
}

function freezeContractRef(contract: ContractRef): ContractRef {
  return Object.freeze({ ...contract });
}

function freezeIntegrity(
  integrity: NonNullable<RendererRegistration["integrity"]>,
): NonNullable<RendererRegistration["integrity"]> {
  const assetHashes = integrity.assetHashes.map((hash) => sha256HashSchema.parse(hash));
  const sorted = [...assetHashes].sort();
  if (new Set(assetHashes).size !== assetHashes.length || assetHashes.some((hash, index) => hash !== sorted[index])) {
    throw new TypeError("Renderer asset hashes must be sorted and unique.");
  }
  return Object.freeze({
    rendererCapabilityManifestHash: sha256HashSchema.parse(integrity.rendererCapabilityManifestHash),
    implementationHash: sha256HashSchema.parse(integrity.implementationHash),
    chunkHash: sha256HashSchema.parse(integrity.chunkHash),
    assetHashes: Object.freeze(assetHashes),
  });
}
