import {
  contractRefKey,
  placementConstraintSchema,
  type ComponentContract,
  type PlacementConstraint,
  type PlacementContext,
} from "@open-generative/catalog";
import {
  contractRefSchema,
  type ContractRef,
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
    const registration = this.get(contract.ref);
    if (!registration) {
      return Object.freeze({ status: "unsupported", reason: "renderer-missing" });
    }
    if (
      !contract.placements.some((constraint) => placementMatches(constraint, placement))
      || !registration.placements.some((constraint) => placementMatches(constraint, placement))
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
