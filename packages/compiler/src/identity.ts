import {
  actionIdSchema,
  canonicalStringify,
  claimIdSchema,
  evidenceIdSchema,
  nodeIdSchema,
  resourceBindingIdSchema,
  stateIdSchema,
  toProposalEntityKey,
  transactionIdentityMapSchema,
  transactionIdentityMapDeltaSchema,
  type CanonicalEntityRef,
  type OperationId,
  type ProposalEntityKind,
  type TransactionId,
} from "@open-generative/protocol";
import { cloneCanonical, compareCanonical } from "./internal";
import type {
  IdentityAllocationBatch,
  IdentityAllocationRequest,
  MaybePromise,
  TransactionIdentityAllocatorPort,
} from "./types";

export interface CanonicalIdentityMintPort {
  mint(input: {
    transactionId: TransactionId;
    kind: ProposalEntityKind;
    localId: string;
  }): MaybePromise<string>;
}

type OperationClaim = {
  requestKeys: string[];
  result: IdentityAllocationBatch;
};

export class InMemoryTransactionIdentityAllocator implements TransactionIdentityAllocatorPort {
  readonly #mint: CanonicalIdentityMintPort;
  readonly #transactionMaps = new Map<TransactionId, Record<string, CanonicalEntityRef>>();
  readonly #operationClaims = new Map<string, OperationClaim>();
  readonly #canonicalOwners = new Map<string, string>();
  readonly #retired = new Set<TransactionId>();

  constructor(mint: CanonicalIdentityMintPort) {
    this.#mint = mint;
  }

  async claim(input: {
    transactionId: TransactionId;
    operationId: OperationId;
    entities: readonly IdentityAllocationRequest[];
  }): Promise<IdentityAllocationBatch> {
    if (this.#retired.has(input.transactionId)) {
      throw new Error("Transaction identity namespace is retired.");
    }
    const entities = [...input.entities]
      .sort(compareCanonical)
      .filter((entry, index, values) => (
        index === 0 || entityKey(entry) !== entityKey(values[index - 1]!)
      ));
    const requestKeys = entities.map(entityKey);
    const operationKey = `${input.transactionId}\0${input.operationId}`;
    const replay = this.#operationClaims.get(operationKey);
    if (replay) {
      if (canonicalStringify(replay.requestKeys) !== canonicalStringify(requestKeys)) {
        throw new Error("Operation identity claim was replayed with a different local-ID set.");
      }
      return cloneCanonical(replay.result);
    }

    const identityMap = cloneCanonical(this.#transactionMaps.get(input.transactionId) ?? {});
    const delta: Array<{
      kind: ProposalEntityKind;
      localId: string;
      canonicalId: string;
    }> = [];
    const stagedOwners = new Map<string, string>();
    for (const entity of entities) {
      const key = toProposalEntityKey(entity.kind, entity.localId);
      if (identityMap[key]) continue;
      const canonicalId = parseCanonicalId(
        entity.kind,
        await this.#mint.mint({
          transactionId: input.transactionId,
          kind: entity.kind,
          localId: entity.localId,
        }),
      );
      const ownerKey = `${entity.kind}:${canonicalId}`;
      const localOwner = `${input.transactionId}\0${key}`;
      const owner = this.#canonicalOwners.get(ownerKey) ?? stagedOwners.get(ownerKey);
      if (owner && owner !== localOwner) {
        throw new Error("Canonical entity identity was already allocated to another proposal-local entity.");
      }
      const ref = { kind: entity.kind, id: canonicalId } as CanonicalEntityRef;
      identityMap[key] = ref;
      stagedOwners.set(ownerKey, localOwner);
      delta.push({ kind: entity.kind, localId: entity.localId, canonicalId });
    }
    this.#transactionMaps.set(input.transactionId, identityMap);
    for (const [ownerKey, owner] of stagedOwners) this.#canonicalOwners.set(ownerKey, owner);
    const result: IdentityAllocationBatch = {
      identityMap: transactionIdentityMapSchema.parse(identityMap),
      identityMapDelta: transactionIdentityMapDeltaSchema.parse(delta),
    };
    this.#operationClaims.set(operationKey, {
      requestKeys,
      result: cloneCanonical(result),
    });
    return cloneCanonical(result);
  }

  retire(transactionId: TransactionId): void {
    this.#retired.add(transactionId);
  }
}

function entityKey(input: IdentityAllocationRequest): string {
  return `${input.kind}:${input.localId}`;
}

function parseCanonicalId(kind: ProposalEntityKind, value: string): string {
  switch (kind) {
    case "node": return nodeIdSchema.parse(value);
    case "state": return stateIdSchema.parse(value);
    case "action": return actionIdSchema.parse(value);
    case "resource": return resourceBindingIdSchema.parse(value);
    case "evidence": return evidenceIdSchema.parse(value);
    case "claim": return claimIdSchema.parse(value);
  }
}
