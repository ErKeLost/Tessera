import {
  canonicalStringify,
  jsonObjectSchema,
  jsonValueSchema,
  type CanonicalNode,
  type ContractRef,
  type DocumentContent,
  type EventPort,
  type HashProvider,
  type JsonObject,
  type JsonValue,
  type NodeId,
  type Sha256Hash,
} from "@open-generative/protocol";
import {
  computeContractSetHash,
  actionContractRefKey,
  contractRefKey,
  verifyComponentContract,
  type ComponentContract,
} from "@open-generative/catalog";
import type { z } from "zod";

export type ClientValidationIssue = Readonly<{
  code: string;
  message: string;
  path?: readonly PropertyKey[];
}>;

export type ClientValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issues: readonly ClientValidationIssue[] }>;

export type ClientValueValidator<T> = (input: unknown) => ClientValidationResult<T>;

export type BrowserComponentRegistration = Readonly<{
  contract: ComponentContract;
  validateResolvedProps: ClientValueValidator<JsonObject>;
  eventPayloadValidators: Readonly<Record<string, ClientValueValidator<JsonValue>>>;
}>;

export type VerifiedBrowserComponentRegistration = Readonly<{
  contract: ComponentContract;
  validateResolvedProps: ClientValueValidator<JsonObject>;
  eventPayloadValidators: Readonly<Record<string, ClientValueValidator<JsonValue>>>;
}>;

export class BrowserContractRegistry {
  readonly contractSetHash: Sha256Hash;
  readonly #registrations: ReadonlyMap<string, VerifiedBrowserComponentRegistration>;

  private constructor(
    registrations: ReadonlyMap<string, VerifiedBrowserComponentRegistration>,
    contractSetHash: Sha256Hash,
  ) {
    this.#registrations = registrations;
    this.contractSetHash = contractSetHash;
    Object.freeze(this);
  }

  static async create(
    registrationsInput: readonly BrowserComponentRegistration[],
    provider?: HashProvider,
  ): Promise<BrowserContractRegistry> {
    const registrations = new Map<string, VerifiedBrowserComponentRegistration>();
    for (const input of registrationsInput) {
      const contract = await verifyComponentContract(input.contract, provider);
      const key = contractRefKey(contract.ref);
      if (registrations.has(key)) {
        throw new TypeError(`Duplicate browser Contract registration: ${key}.`);
      }
      assertExactEventValidators(contract, input.eventPayloadValidators);
      registrations.set(key, Object.freeze({
        contract,
        validateResolvedProps: input.validateResolvedProps,
        eventPayloadValidators: Object.freeze({ ...input.eventPayloadValidators }),
      }));
    }
    const contractSetHash = await computeContractSetHash(
      [...registrations.values()].map(({ contract }) => contract.ref),
      provider,
    );
    return new BrowserContractRegistry(registrations, contractSetHash);
  }

  get(ref: ContractRef): VerifiedBrowserComponentRegistration | undefined {
    return this.#registrations.get(contractRefKey(ref));
  }

  has(ref: ContractRef): boolean {
    return this.#registrations.has(contractRefKey(ref));
  }

  refs(): readonly ContractRef[] {
    return Object.freeze([...this.#registrations.values()].map(({ contract }) => contract.ref));
  }

  validateResolvedProps(ref: ContractRef, input: unknown): ClientValidationResult<JsonObject> {
    const registration = this.get(ref);
    if (!registration) return missingContract(ref);
    const json = jsonObjectSchema.safeParse(input);
    if (!json.success) {
      return invalidJson("client.resolved-props-json-invalid", json.error.message);
    }
    return validateExactJson(registration.validateResolvedProps, json.data, jsonObjectSchema);
  }

  validateEventPayload(
    ref: ContractRef,
    port: EventPort,
    input: unknown,
  ): ClientValidationResult<JsonValue> {
    const registration = this.get(ref);
    if (!registration) return missingContract(ref);
    const validator = registration.eventPayloadValidators[port];
    if (!validator) {
      return invalidJson(
        "client.event-port-unsupported",
        `Contract ${contractRefKey(ref)} does not expose event port ${port}.`,
      );
    }
    const json = jsonValueSchema.safeParse(input);
    if (!json.success) return invalidJson("client.event-payload-json-invalid", json.error.message);
    return validateExactJson(validator, json.data, jsonValueSchema);
  }

  validateNodeStructure(
    nodeId: NodeId,
    node: CanonicalNode,
    document: DocumentContent,
  ): ClientValidationResult<CanonicalNode> {
    const registration = this.get(node.contract);
    if (!registration) return missingContract(node.contract);
    const issues: ClientValidationIssue[] = [];
    const contract = registration.contract;

    for (const name of Object.keys(node.slots)) {
      if (!Object.keys(contract.slots).includes(name)) {
        issues.push({
          code: "client.slot-unknown",
          message: `Node ${nodeId} uses undeclared slot ${name}.`,
          path: ["slots", name],
        });
      }
    }
    for (const [name, slot] of Object.entries(contract.slots)) {
      const children = Object.entries(node.slots).find(([candidate]) => candidate === name)?.[1] ?? [];
      if (children.length < slot.min || children.length > slot.max) {
        issues.push({
          code: "client.slot-cardinality",
          message: `Node ${nodeId} slot ${name} violates its exact cardinality.`,
          path: ["slots", name],
        });
      }
      const accepts = new Set(slot.accepts.map((selector) => contractRefKey(selector.contract)));
      for (const [index, childId] of children.entries()) {
        const child = document.nodes[childId];
        if (!child || !accepts.has(contractRefKey(child.contract))) {
          issues.push({
            code: "client.slot-contract-mismatch",
            message: `Node ${nodeId} slot ${name} contains an unsupported child Contract.`,
            path: ["slots", name, index],
          });
        }
      }
    }

    for (const [port, actionId] of Object.entries(node.events)) {
      const event = Object.entries(contract.events).find(([name]) => name === port)?.[1];
      if (!event) {
        issues.push({
          code: "client.event-port-unsupported",
          message: `Node ${nodeId} uses undeclared event port ${port}.`,
          path: ["events", port],
        });
        continue;
      }
      const action = Object.entries(document.actions).find(([id]) => id === actionId)?.[1];
      if (action?.kind === "host-intent") {
        const accepted = new Set(event.actionContracts.map(actionContractRefKey));
        if (!accepted.has(actionContractRefKey(action.contract))) {
          issues.push({
            code: "client.event-action-mismatch",
            message: `Node ${nodeId} event ${port} targets an unauthorized Action Contract.`,
            path: ["events", port],
          });
        }
      }
    }

    return issues.length === 0 ? { ok: true, value: node } : { ok: false, issues };
  }
}

export function createBrowserContractRegistry(
  registrations: readonly BrowserComponentRegistration[],
  provider?: HashProvider,
): Promise<BrowserContractRegistry> {
  return BrowserContractRegistry.create(registrations, provider);
}

export function createZodClientValidator<T extends JsonValue>(
  schema: z.ZodType<T>,
): ClientValueValidator<T> {
  return (input) => {
    const result = schema.safeParse(input);
    if (!result.success) {
      return {
        ok: false,
        issues: result.error.issues.map((issue) => ({
          code: "client.schema-invalid",
          message: issue.message,
          path: issue.path,
        })),
      };
    }
    if (canonicalStringify(result.data) !== canonicalStringify(input)) {
      return invalidJson(
        "client.schema-transformation-forbidden",
        "Browser validators must validate exact canonical data without defaults, coercion, or transforms.",
      );
    }
    return { ok: true, value: result.data };
  };
}

export function createJsonObjectClientValidator(
  schema: z.ZodType<JsonObject>,
): ClientValueValidator<JsonObject> {
  return createZodClientValidator(schema);
}

function assertExactEventValidators(
  contract: ComponentContract,
  validators: Readonly<Record<string, ClientValueValidator<JsonValue>>>,
): void {
  const declared = Object.keys(contract.events).sort();
  const provided = Object.keys(validators).sort();
  if (canonicalStringify(declared) !== canonicalStringify(provided)) {
    throw new TypeError(
      `Browser event validators for ${contractRefKey(contract.ref)} must exactly match Contract event ports.`,
    );
  }
}

function missingContract<T>(ref: ContractRef): ClientValidationResult<T> {
  return {
    ok: false,
    issues: [{
      code: "client.contract-unsupported",
      message: `No verified browser Contract is registered for ${contractRefKey(ref)}.`,
    }],
  };
}

function invalidJson<T>(code: string, message: string): ClientValidationResult<T> {
  return { ok: false, issues: [{ code, message }] };
}

function validateExactJson<T extends JsonValue>(
  validator: ClientValueValidator<T>,
  input: T,
  schema: z.ZodType<T>,
): ClientValidationResult<T> {
  const result = validator(input);
  if (!result.ok) return result;
  const output = schema.safeParse(result.value);
  if (!output.success) {
    return invalidJson("client.validator-output-invalid", output.error.message);
  }
  if (canonicalStringify(output.data) !== canonicalStringify(input)) {
    return invalidJson(
      "client.schema-transformation-forbidden",
      "Browser validators must validate exact canonical data without defaults, coercion, or transforms.",
    );
  }
  return { ok: true, value: output.data };
}
