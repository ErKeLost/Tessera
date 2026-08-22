import {
  verifyActionContract,
  verifyCatalogSetSlice,
  verifyComponentContract,
  type ActionContract,
  type ComponentContract,
} from "@open-generative/catalog";
import type {
  ActionContractRef,
  ContractRef,
  JSONSchema,
} from "@open-generative/protocol";
import { deepFreeze, refKey } from "./internal";
import { createAuthoringPropsSchema } from "./schema";
import type {
  CompilerCatalogInput,
  CompilerCatalogLike,
} from "./types";

export class CompilerCatalog implements CompilerCatalogLike {
  readonly slice: CompilerCatalogLike["slice"];
  readonly components: readonly ComponentContract[];
  readonly actions: readonly ActionContract[];
  readonly #componentSlices: ReadonlyMap<string, ComponentContract>;
  readonly #componentsByRef: ReadonlyMap<string, ComponentContract>;
  readonly #actionSlices: ReadonlyMap<string, ActionContract>;
  readonly #actionsByRef: ReadonlyMap<string, ActionContract>;
  readonly #propsSchemas: ReadonlyMap<string, JSONSchema>;

  constructor(input: {
    slice: CompilerCatalogLike["slice"];
    components: readonly ComponentContract[];
    actions: readonly ActionContract[];
  }) {
    this.slice = input.slice;
    this.components = deepFreeze([...input.components]);
    this.actions = deepFreeze([...input.actions]);
    this.#componentsByRef = new Map(this.components.map((contract) => [refKey(contract.ref), contract]));
    this.#actionsByRef = new Map(this.actions.map((contract) => [refKey(contract.ref), contract]));
    this.#componentSlices = new Map(this.slice.components.map((entry) => {
      const contract = this.#componentsByRef.get(refKey(entry.contract));
      if (!contract) throw new TypeError(`Missing ComponentContract for ${refKey(entry.contract)}.`);
      return [entry.sliceComponentId, contract];
    }));
    this.#actionSlices = new Map(this.slice.actions.map((entry) => {
      const contract = this.#actionsByRef.get(refKey(entry.contract));
      if (!contract) throw new TypeError(`Missing ActionContract for ${refKey(entry.contract)}.`);
      return [entry.sliceActionId, contract];
    }));
    this.#propsSchemas = new Map(this.components.map((contract) => [
      refKey(contract.ref),
      createAuthoringPropsSchema(contract),
    ]));
    Object.freeze(this);
  }

  componentBySliceId(id: string): ComponentContract | undefined {
    return this.#componentSlices.get(id);
  }

  componentByRef(ref: ContractRef): ComponentContract | undefined {
    return this.#componentsByRef.get(refKey(ref));
  }

  actionBySliceId(id: string): ActionContract | undefined {
    return this.#actionSlices.get(id);
  }

  actionByRef(ref: ActionContractRef): ActionContract | undefined {
    return this.#actionsByRef.get(refKey(ref));
  }

  authoringPropsSchema(contract: ContractRef): JSONSchema {
    const schema = this.#propsSchemas.get(refKey(contract));
    if (!schema) throw new TypeError(`Component contract is not in the frozen compiler catalog: ${refKey(contract)}.`);
    return schema;
  }
}

export async function createCompilerCatalog(input: CompilerCatalogInput): Promise<CompilerCatalog> {
  const [slice, components, actions] = await Promise.all([
    verifyCatalogSetSlice(input.slice, input.hashProvider),
    Promise.all(input.components.map((contract) => verifyComponentContract(contract, input.hashProvider))),
    Promise.all(input.actions.map((contract) => verifyActionContract(contract, input.hashProvider))),
  ]);
  assertExactSet(
    "component",
    slice.components.map((entry) => entry.contract),
    components.map((contract) => contract.ref),
  );
  assertExactSet(
    "action",
    slice.actions.map((entry) => entry.contract),
    actions.map((contract) => contract.ref),
  );
  return new CompilerCatalog({ slice, components, actions });
}

function assertExactSet(
  kind: "component" | "action",
  expected: readonly (ContractRef | ActionContractRef)[],
  actual: readonly (ContractRef | ActionContractRef)[],
): void {
  const expectedKeys = expected.map(refKey).sort();
  const actualKeys = actual.map(refKey).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    throw new TypeError(`Compiler ${kind} contracts must exactly match the frozen CatalogSetSlice.`);
  }
}
