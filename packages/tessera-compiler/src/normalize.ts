import { z, ZodError, type ZodType } from "zod";
import { canonicalize, deepFreeze, escapeJsonPointer, utf8Bytes } from "./canonical";
import { CompilerCatalog } from "./catalog";
import { matchesActionContractVersion } from "./contract-version";
import {
  compilerDiagnostic,
  CompilerDiagnosticError,
  diagnosticsFromUnknown,
} from "./diagnostics";
import type {
  ArtifactMeta,
  ArtifactProposal,
  ArtifactValue,
  AuthoringActionPlan,
  AuthoringActionStep,
  AuthoringNavigationTarget,
  AuthoringStateDefinition,
  AuthoringValue,
  CatalogSlice,
  Diagnostic,
  GenerationLimits,
  JSONSchema,
  JsonValue,
  NodeContract,
  NormalizedActionPlan,
  NormalizedActionStep,
  NormalizedArtifactNode,
  NormalizedArtifactProposal,
} from "./types";

export const DEFAULT_GENERATION_LIMITS: Readonly<GenerationLimits> = Object.freeze({
  maxDocumentBytes: 256_000,
  maxNodes: 64,
  maxDepth: 12,
  maxStringBytes: 16_000,
  maxCollectionItems: 2_000,
  maxObjectKeys: 256,
  maxTotalValues: 20_000,
  maxNodeTypes: 12,
  maxExamples: 2,
  maxRepairFragmentBytes: 32_000,
  maxRepairAttempts: 1,
});

const absoluteLimitCeilings: Readonly<GenerationLimits> = Object.freeze({
  maxDocumentBytes: 4_000_000,
  maxNodes: 1_000,
  maxDepth: 64,
  maxStringBytes: 1_000_000,
  maxCollectionItems: 20_000,
  maxObjectKeys: 4_096,
  maxTotalValues: 1_000_000,
  maxNodeTypes: 256,
  maxExamples: 8,
  maxRepairFragmentBytes: 128_000,
  maxRepairAttempts: 3,
});

const identifierPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const authoringPathSchema = z.array(z.union([
  z.string().min(1).refine((value) => !forbiddenKeys.has(value)),
  z.number().int().nonnegative(),
])).max(64);
const propsReferenceSchema = z.union([
  z.object({
    $ref: z.enum(["state", "resource"]),
    id: z.string().regex(identifierPattern),
    path: authoringPathSchema.optional(),
  }).strict(),
  z.object({
    $ref: z.literal("context"),
    key: z.enum(["locale", "timezone"]),
  }).strict(),
]);
const presentationConditionSchema = z.object({
  $condition: z.object({
    op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"]),
    args: z.array(z.unknown()).min(1),
  }).strict(),
}).strict();
const bindingSchemaCache = new WeakMap<NodeContract, ZodType<Record<string, unknown>>>();

export function resolveGenerationLimits(
  overrides: Partial<GenerationLimits> = {},
): Readonly<GenerationLimits> {
  const limits = { ...DEFAULT_GENERATION_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits) as [keyof GenerationLimits, number][]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > absoluteLimitCeilings[name]) {
      throw new TypeError(
        `${name} must be an integer between 0 and ${absoluteLimitCeilings[name]}.`,
      );
    }
  }
  if (limits.maxNodes < 1 || limits.maxDepth < 1 || limits.maxNodeTypes < 1) {
    throw new TypeError("Node, depth, and node-type limits must be positive.");
  }
  return Object.freeze(limits);
}

export type NormalizeSurfaceOptions = {
  catalog?: CompilerCatalog | CatalogSlice;
  limits?: Partial<GenerationLimits>;
  allowedResourceIds?: readonly string[];
  capabilityIds?: readonly string[];
  messageTemplateIds?: readonly string[];
};

type NormalizeContext = {
  contracts: ReadonlyMap<string, NodeContract>;
  limits: Readonly<GenerationLimits>;
  nodes: Record<string, NormalizedArtifactNode>;
  instanceCounts: Map<string, number>;
  stateIds: ReadonlySet<string>;
  resourceIds: ReadonlySet<string>;
  capabilityIds: ReadonlySet<string>;
  messageTemplateIds: ReadonlySet<string>;
};

function fail(input: Parameters<typeof compilerDiagnostic>[0]): never {
  throw new CompilerDiagnosticError([compilerDiagnostic(input)]);
}

function summarize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail({
      phase: "decode",
      code: "authoring.expected_object",
      message: "Expected an object.",
      path,
      actualSummary: summarize(value),
    });
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail({
      phase: "decode",
      code: "authoring.non_plain_object",
      message: "Authoring input must contain only plain JSON objects.",
      path,
      modelCorrectable: false,
      actualSummary: Object.prototype.toString.call(value),
    });
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    fail({
      phase: "validate",
      code: "authoring.unknown_field",
      message: `Unknown field "${unknown.sort()[0]}".`,
      path: `${path}/${escapeJsonPointer(unknown.sort()[0]!)}`,
      hint: "Remove fields that are not declared by the authoring schema.",
    });
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail({
      phase: "decode",
      code: "authoring.expected_string",
      message: "Expected a non-empty string.",
      path,
      actualSummary: summarize(value),
    });
  }
  return value;
}

function identifierAt(value: unknown, path: string): string {
  const id = stringAt(value, path);
  if (!identifierPattern.test(id)) {
    return fail({
      phase: "validate",
      code: "authoring.invalid_identifier",
      message: "Identifiers must be stable ASCII names of at most 128 characters.",
      path,
      hint: "Start with a letter and use letters, numbers, dot, colon, underscore, or hyphen.",
    });
  }
  return id;
}

function inspectJson(value: unknown, limits: GenerationLimits): asserts value is JsonValue {
  let totalValues = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, path: string): void => {
    totalValues += 1;
    if (totalValues > limits.maxTotalValues) {
      fail({
        phase: "decode",
        code: "limit.total_values_exceeded",
        message: "The artifact contains too many values.",
        path,
        expected: limits.maxTotalValues,
      });
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (utf8Bytes(current) > limits.maxStringBytes) {
        fail({
          phase: "decode",
          code: "limit.string_bytes_exceeded",
          message: "A string exceeds the configured UTF-8 byte limit.",
          path,
          expected: limits.maxStringBytes,
        });
      }
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail({
          phase: "decode",
          code: "authoring.non_finite_number",
          message: "Numbers must be finite.",
          path,
        });
      }
      return;
    }
    if (!current || typeof current !== "object") {
      fail({
        phase: "decode",
        code: "authoring.non_json_value",
        message: "The authoring document must contain only JSON values.",
        path,
        modelCorrectable: false,
        actualSummary: summarize(current),
      });
    }
    if (ancestors.has(current)) {
      fail({
        phase: "decode",
        code: "authoring.cyclic_value",
        message: "The authoring document cannot contain cyclic values.",
        path,
        modelCorrectable: false,
      });
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      if (current.length > limits.maxCollectionItems) {
        fail({
          phase: "decode",
          code: "limit.collection_items_exceeded",
          message: "An array exceeds the configured item limit.",
          path,
          expected: limits.maxCollectionItems,
        });
      }
      current.forEach((item, index) => visit(item, `${path}/${index}`));
    } else {
      const object = recordAt(current, path);
      const keys = Object.keys(object);
      if (keys.length > limits.maxObjectKeys) {
        fail({
          phase: "decode",
          code: "limit.object_keys_exceeded",
          message: "An object exceeds the configured key limit.",
          path,
          expected: limits.maxObjectKeys,
        });
      }
      for (const key of keys) {
        if (forbiddenKeys.has(key)) {
          fail({
            phase: "decode",
            code: "authoring.forbidden_object_key",
            message: "The authoring document contains a forbidden object key.",
            path: `${path}/${escapeJsonPointer(key)}`,
            modelCorrectable: false,
          });
        }
        visit(object[key], `${path}/${escapeJsonPointer(key)}`);
      }
    }
    ancestors.delete(current);
  };

  visit(value, "");
  const bytes = utf8Bytes(canonicalize(value as JsonValue));
  if (bytes > limits.maxDocumentBytes) {
    fail({
      phase: "decode",
      code: "limit.document_bytes_exceeded",
      message: "The artifact exceeds the configured document byte limit.",
      path: "",
      expected: limits.maxDocumentBytes,
      actualSummary: `${bytes} UTF-8 bytes`,
    });
  }
}

function matchesPath(path: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => {
    const expected = pattern.split("/");
    const actual = path.split("/");
    return expected.length === actual.length && expected.every(
      (segment, index) => segment === "*" || segment === actual[index],
    );
  });
}

function pathSegments(value: unknown, path: string): (string | number)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return fail({
      phase: "normalize",
      code: "reference.invalid_path",
      message: "A reference path must be an array.",
      path,
    });
  }
  return value.map((segment, index) => {
    if (typeof segment === "string" && segment.length > 0 && !forbiddenKeys.has(segment)) {
      return segment;
    }
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return segment;
    }
    return fail({
      phase: "normalize",
      code: "reference.invalid_path_segment",
      message: "Reference paths accept non-empty property names and non-negative integer indexes.",
      path: `${path}/${index}`,
    });
  });
}

type LowerOptions = {
  context: NormalizeContext;
  path: string;
  bindingPath: string;
  contract?: NodeContract;
  allowEventReference: boolean;
};

function lowerValue(value: AuthoringValue, options: LowerOptions): ArtifactValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail({
        phase: "normalize",
        code: "authoring.non_finite_number",
        message: "Numbers must be finite.",
        path: options.path,
      });
    }
    return { kind: "literal", value };
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((item, index) => lowerValue(item, {
        ...options,
        path: `${options.path}/${index}`,
        bindingPath: `${options.bindingPath}/*`,
      })),
    };
  }

  const object = recordAt(value, options.path);
  const dollarKeys = Object.keys(object).filter((key) => key.startsWith("$"));
  if ("$ref" in object) {
    if (
      dollarKeys.length !== 1
      || (!options.allowEventReference && !matchesPath(
        options.bindingPath,
        options.contract?.bindings?.referencePaths,
      ))
    ) {
      return fail({
        phase: "normalize",
        code: "binding.reference_not_allowed",
        message: "This contract field does not allow references.",
        path: options.path,
      });
    }
    const ref = stringAt(object.$ref, `${options.path}/$ref`);
    const path = pathSegments(object.path, `${options.path}/path`);
    if (ref === "state" || ref === "resource") {
      rejectUnknownKeys(object, new Set(["$ref", "id", "path"]), options.path);
      const id = identifierAt(object.id, `${options.path}/id`);
      if (ref === "state" && !options.context.stateIds.has(id)) {
        return fail({
          phase: "validate",
          code: "reference.unknown_state",
          message: `State "${id}" is not declared by this proposal.`,
          path: `${options.path}/id`,
        });
      }
      if (ref === "resource" && !options.context.resourceIds.has(id)) {
        return fail({
          phase: "policy",
          code: "reference.resource_not_granted",
          message: `Resource "${id}" is not in the sealed proposal context.`,
          path: `${options.path}/id`,
          recoverable: false,
          modelCorrectable: false,
        });
      }
      return ref === "state"
        ? { kind: "state-ref", stateId: id, ...(path ? { path } : {}) }
        : { kind: "resource-ref", resourceId: id, ...(path ? { path } : {}) };
    }
    if (ref === "event") {
      if (!options.allowEventReference) {
        return fail({
          phase: "validate",
          code: "reference.event_outside_action",
          message: "Event references are allowed only inside action plans.",
          path: options.path,
        });
      }
      rejectUnknownKeys(object, new Set(["$ref", "port", "path"]), options.path);
      const port = identifierAt(object.port, `${options.path}/port`);
      return { kind: "event-ref", port, ...(path ? { path } : {}) };
    }
    if (ref === "context") {
      rejectUnknownKeys(object, new Set(["$ref", "key"]), options.path);
      if (object.key !== "locale" && object.key !== "timezone") {
        return fail({
          phase: "normalize",
          code: "reference.invalid_context_key",
          message: "Context references are limited to locale and timezone.",
          path: `${options.path}/key`,
        });
      }
      return { kind: "context-ref", key: object.key };
    }
    return fail({
      phase: "normalize",
      code: "reference.invalid_kind",
      message: `Unknown reference kind "${ref}".`,
      path: `${options.path}/$ref`,
    });
  }

  if ("$condition" in object) {
    if (
      dollarKeys.length !== 1
      || (!options.allowEventReference && !matchesPath(
        options.bindingPath,
        options.contract?.bindings?.conditionPaths,
      ))
    ) {
      return fail({
        phase: "normalize",
        code: "binding.condition_not_allowed",
        message: "This contract field does not allow conditions.",
        path: options.path,
      });
    }
    rejectUnknownKeys(object, new Set(["$condition"]), options.path);
    const condition = recordAt(object.$condition, `${options.path}/$condition`);
    rejectUnknownKeys(condition, new Set(["op", "args"]), `${options.path}/$condition`);
    const operator = stringAt(condition.op, `${options.path}/$condition/op`);
    const operators = new Set(["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"]);
    if (!operators.has(operator) || !Array.isArray(condition.args)) {
      return fail({
        phase: "normalize",
        code: "condition.invalid_shape",
        message: "The condition operator or argument list is invalid.",
        path: `${options.path}/$condition`,
      });
    }
    const count = condition.args.length;
    const validArity = operator === "not" ? count === 1
      : operator === "and" || operator === "or" ? count >= 2
      : count === 2;
    if (!validArity) {
      return fail({
        phase: "validate",
        code: "condition.invalid_arity",
        message: `Condition operator "${operator}" received the wrong number of arguments.`,
        path: `${options.path}/$condition/args`,
      });
    }
    if (["lt", "lte", "gt", "gte"].includes(operator)) {
      for (const [index, item] of condition.args.entries()) {
        if (typeof item !== "object" && typeof item !== "number") {
          return fail({
            phase: "validate",
            code: "condition.expected_number",
            message: "Ordered comparisons accept only numbers or numeric references.",
            path: `${options.path}/$condition/args/${index}`,
          });
        }
      }
    }
    return {
      kind: "condition",
      op: operator as "eq",
      args: (condition.args as AuthoringValue[]).map((item, index) => lowerValue(item, {
        ...options,
        path: `${options.path}/$condition/args/${index}`,
      })),
    };
  }

  if (dollarKeys.length) {
    return fail({
      phase: "normalize",
      code: "authoring.reserved_key",
      message: `Unknown reserved authoring key "${dollarKeys.sort()[0]}".`,
      path: `${options.path}/${escapeJsonPointer(dollarKeys.sort()[0]!)}`,
    });
  }

  return {
    kind: "object",
    entries: Object.fromEntries(Object.keys(object).sort().map((key) => [
      key,
      lowerValue(object[key] as AuthoringValue, {
        ...options,
        path: `${options.path}/${escapeJsonPointer(key)}`,
        bindingPath: `${options.bindingPath}/${escapeJsonPointer(key)}`,
      }),
    ])),
  };
}

function lowerRecord(
  value: Record<string, unknown>,
  context: NormalizeContext,
  path: string,
  contract?: NodeContract,
  allowEventReference = false,
): Record<string, ArtifactValue> {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    lowerValue(value[key] as AuthoringValue, {
      context,
      contract,
      allowEventReference,
      path: `${path}/${escapeJsonPointer(key)}`,
      bindingPath: `/${escapeJsonPointer(key)}`,
    }),
  ]));
}

type CloneableZod = ZodType & {
  readonly def: Record<string, unknown> & { type?: string };
  readonly shape?: Readonly<Record<string, ZodType>>;
  readonly element?: ZodType;
  clone(def: Record<string, unknown>): ZodType;
};

function decodeBindingPath(path: string): string[] {
  return path.slice(1).split("/").map((segment) => (
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  ));
}

function patchZodBindingPath(
  schema: ZodType,
  segments: readonly string[],
  bindingSchema: ZodType,
  index = 0,
): ZodType | undefined {
  if (index === segments.length) return z.union([schema, bindingSchema]);

  const candidate = schema as CloneableZod;
  const type = candidate.def.type;
  if (type === "object") {
    const segment = segments[index]!;
    if (segment === "*") return undefined;
    const shape = candidate.shape;
    const property = shape?.[segment];
    if (!shape || !property) return undefined;
    const patched = patchZodBindingPath(property, segments, bindingSchema, index + 1);
    if (!patched) return undefined;
    return candidate.clone({ ...candidate.def, shape: { ...shape, [segment]: patched } });
  }
  if (type === "array") {
    if (segments[index] !== "*" || !candidate.element) return undefined;
    const patched = patchZodBindingPath(candidate.element, segments, bindingSchema, index + 1);
    if (!patched) return undefined;
    return candidate.clone({ ...candidate.def, element: patched });
  }
  if (["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional"].includes(type ?? "")) {
    const innerType = candidate.def.innerType;
    if (!innerType || typeof innerType !== "object") return undefined;
    const patched = patchZodBindingPath(innerType as ZodType, segments, bindingSchema, index);
    if (!patched) return undefined;
    return candidate.clone({ ...candidate.def, innerType: patched });
  }
  return undefined;
}

function bindingAwarePropsSchema(contract: NodeContract): ZodType<Record<string, unknown>> {
  const cached = bindingSchemaCache.get(contract);
  if (cached) return cached;

  let schema = contract.propsSchema;
  const bindings = [
    ...(contract.bindings?.referencePaths ?? []).map((path) => ({ path, schema: propsReferenceSchema })),
    ...(contract.bindings?.conditionPaths ?? []).map((path) => ({ path, schema: presentationConditionSchema })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  for (const binding of bindings) {
    const patched = patchZodBindingPath(schema, decodeBindingPath(binding.path), binding.schema);
    if (!patched) {
      throw new TypeError(
        `Node contract "${contract.type}" binding path "${binding.path}" is not present in its props schema.`,
      );
    }
    schema = patched as ZodType<Record<string, unknown>>;
  }
  bindingSchemaCache.set(contract, schema);
  return schema;
}

function assertContractBindingsAllowed(
  value: unknown,
  contract: NodeContract,
  path: string,
  bindingPath = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertContractBindingsAllowed(
      item,
      contract,
      `${path}/${index}`,
      `${bindingPath}/*`,
    ));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if ("$ref" in object) {
    if (!matchesPath(bindingPath, contract.bindings?.referencePaths)) {
      fail({
        phase: "normalize",
        code: "binding.reference_not_allowed",
        message: "This contract field does not allow references.",
        path,
      });
    }
    return;
  }
  if ("$condition" in object) {
    if (!matchesPath(bindingPath, contract.bindings?.conditionPaths)) {
      fail({
        phase: "normalize",
        code: "binding.condition_not_allowed",
        message: "This contract field does not allow conditions.",
        path,
      });
    }
    return;
  }
  for (const [key, child] of Object.entries(object)) {
    assertContractBindingsAllowed(
      child,
      contract,
      `${path}/${escapeJsonPointer(key)}`,
      `${bindingPath}/${escapeJsonPointer(key)}`,
    );
  }
}

function parseContractProps(
  contract: NodeContract,
  value: unknown,
  path: string,
): Record<string, unknown> {
  assertContractBindingsAllowed(value, contract, path);
  try {
    return bindingAwarePropsSchema(contract).parse(value);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const diagnostics = error.issues.slice(0, 20).map((issue) => compilerDiagnostic({
      phase: "validate",
      code: "node.invalid_props",
      message: issue.message,
      path: `${path}${issue.path.map((segment) => `/${escapeJsonPointer(String(segment))}`).join("")}`,
      actualSummary: issue.code,
      hint: `Use the generated props schema for "${contract.type}@${contract.version}".`,
    }));
    throw new CompilerDiagnosticError(diagnostics);
  }
}

function contractMap(catalog: CompilerCatalog | CatalogSlice | undefined): ReadonlyMap<string, NodeContract> {
  const contracts = catalog instanceof CompilerCatalog
    ? catalog.contracts()
    : catalog?.contracts ?? [];
  return new Map(contracts.map((contract) => [contract.type, contract]));
}

function normalizeStates(
  raw: unknown,
): Record<string, AuthoringStateDefinition> {
  if (raw === undefined) return {};
  const states = recordAt(raw, "/state");
  return Object.fromEntries(Object.keys(states).sort().map((stateId) => {
    identifierAt(stateId, `/state/${escapeJsonPointer(stateId)}`);
    const state = recordAt(states[stateId], `/state/${escapeJsonPointer(stateId)}`);
    rejectUnknownKeys(state, new Set(["schema", "initial"]), `/state/${escapeJsonPointer(stateId)}`);
    const schema = recordAt(state.schema, `/state/${escapeJsonPointer(stateId)}/schema`);
    const initial = state.initial as JsonValue;
    rejectReservedPlainKeys(initial, `/state/${escapeJsonPointer(stateId)}/initial`);
    return [stateId, {
      schema: cloneJson(schema as unknown as JsonValue) as AuthoringStateDefinition["schema"],
      initial: cloneJson(initial),
    }];
  }));
}

function rejectReservedPlainKeys(value: JsonValue, path: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectReservedPlainKeys(item, `${path}/${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("$")) {
      fail({
        phase: "normalize",
        code: "authoring.reserved_key",
        message: `Reserved key "${key}" is not allowed in a literal value.`,
        path: `${path}/${escapeJsonPointer(key)}`,
      });
    }
    rejectReservedPlainKeys(child, `${path}/${escapeJsonPointer(key)}`);
  }
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function normalizeActionStep(
  raw: unknown,
  path: string,
  context: NormalizeContext,
): NormalizedActionStep {
  const step = recordAt(raw, path);
  const stepId = identifierAt(step.stepId, `${path}/stepId`);
  const type = stringAt(step.type, `${path}/type`) as AuthoringActionStep["type"];
  const common = { stepId, type };

  if (type === "state.set") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "stateId", "value"]), path);
    const stateId = identifierAt(step.stateId, `${path}/stateId`);
    if (!context.stateIds.has(stateId)) {
      return fail({
        phase: "validate",
        code: "action.unknown_state",
        message: `State "${stateId}" is not declared.`,
        path: `${path}/stateId`,
      });
    }
    return {
      ...common,
      type,
      stateId,
      value: lowerValue(step.value as AuthoringValue, {
        context,
        allowEventReference: true,
        path: `${path}/value`,
        bindingPath: "/value",
      }),
    };
  }
  if (type === "state.reset") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "stateIds"]), path);
    if (!Array.isArray(step.stateIds) || step.stateIds.length === 0) {
      return fail({
        phase: "validate",
        code: "action.invalid_state_reset",
        message: "state.reset requires at least one state id.",
        path: `${path}/stateIds`,
      });
    }
    const stateIds = step.stateIds.map((id, index) => identifierAt(id, `${path}/stateIds/${index}`));
    if (stateIds.some((id) => !context.stateIds.has(id))) {
      return fail({
        phase: "validate",
        code: "action.unknown_state",
        message: "state.reset references an undeclared state.",
        path: `${path}/stateIds`,
      });
    }
    return { ...common, type, stateIds };
  }
  if (type === "node.focus") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "nodeId"]), path);
    return { ...common, type, nodeId: identifierAt(step.nodeId, `${path}/nodeId`) };
  }
  if (type === "agent.message") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "templateGrantId", "values"]), path);
    const templateGrantId = identifierAt(step.templateGrantId, `${path}/templateGrantId`);
    if (!context.messageTemplateIds.has(templateGrantId)) {
      return fail({
        phase: "policy",
        code: "action.message_template_not_granted",
        message: "The message template is not in the sealed proposal context.",
        path: `${path}/templateGrantId`,
        recoverable: false,
        modelCorrectable: false,
      });
    }
    return {
      ...common,
      type,
      templateGrantId,
      values: lowerRecord(recordAt(step.values ?? {}, `${path}/values`), context, `${path}/values`, undefined, true),
    };
  }
  if (type === "capability.request") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "capabilityId", "input"]), path);
    const capabilityId = identifierAt(step.capabilityId, `${path}/capabilityId`);
    assertCapability(context, capabilityId, `${path}/capabilityId`);
    return {
      ...common,
      type,
      capabilityId,
      input: lowerRecord(recordAt(step.input, `${path}/input`), context, `${path}/input`, undefined, true),
    };
  }
  if (type === "navigation.request") {
    rejectUnknownKeys(step, new Set(["stepId", "type", "target"]), path);
    return {
      ...common,
      type,
      target: normalizeNavigationTarget(step.target as AuthoringNavigationTarget, `${path}/target`, context),
    };
  }
  return fail({
    phase: "validate",
    code: "action.unknown_step_type",
    message: `Unknown action step type "${String(type)}".`,
    path: `${path}/type`,
  });
}

function assertCapability(context: NormalizeContext, id: string, path: string): void {
  if (!context.capabilityIds.has(id)) {
    fail({
      phase: "policy",
      code: "action.capability_not_granted",
      message: "The capability is not in the sealed proposal context.",
      path,
      recoverable: false,
      modelCorrectable: false,
    });
  }
}

function normalizeNavigationTarget(
  raw: AuthoringNavigationTarget,
  path: string,
  context: NormalizeContext,
): Extract<NormalizedActionStep, { type: "navigation.request" }>["target"] {
  const target = recordAt(raw, path);
  const kind = stringAt(target.kind, `${path}/kind`);
  const capabilityId = identifierAt(target.capabilityId, `${path}/capabilityId`);
  assertCapability(context, capabilityId, `${path}/capabilityId`);
  if (kind === "route") {
    rejectUnknownKeys(target, new Set(["kind", "capabilityId", "routeId", "params"]), path);
    return {
      kind,
      capabilityId,
      routeId: identifierAt(target.routeId, `${path}/routeId`),
      params: lowerRecord(recordAt(target.params ?? {}, `${path}/params`), context, `${path}/params`, undefined, true),
    };
  }
  if (kind === "resource") {
    rejectUnknownKeys(target, new Set(["kind", "capabilityId", "resourceId"]), path);
    const resourceId = identifierAt(target.resourceId, `${path}/resourceId`);
    if (!context.resourceIds.has(resourceId)) {
      return fail({
        phase: "policy",
        code: "reference.resource_not_granted",
        message: "The navigation target resource is not in the sealed context.",
        path: `${path}/resourceId`,
        recoverable: false,
        modelCorrectable: false,
      });
    }
    return { kind, capabilityId, resourceId };
  }
  if (kind === "external") {
    rejectUnknownKeys(target, new Set(["kind", "capabilityId", "input"]), path);
    return {
      kind,
      capabilityId,
      input: lowerRecord(recordAt(target.input, `${path}/input`), context, `${path}/input`, undefined, true),
    };
  }
  return fail({
    phase: "validate",
    code: "action.invalid_navigation_target",
    message: "Unknown navigation target kind.",
    path: `${path}/kind`,
  });
}

function normalizeActions(raw: unknown, context: NormalizeContext): Record<string, NormalizedActionPlan> {
  if (raw === undefined) return {};
  const actions = recordAt(raw, "/actions");
  return Object.fromEntries(Object.keys(actions).sort().map((actionId) => {
    identifierAt(actionId, `/actions/${escapeJsonPointer(actionId)}`);
    const path = `/actions/${escapeJsonPointer(actionId)}`;
    const action = recordAt(actions[actionId], path) as AuthoringActionPlan & Record<string, unknown>;
    rejectUnknownKeys(action, new Set(["contractId", "contractVersion", "steps", "onError"]), path);
    const contractId = identifierAt(action.contractId, `${path}/contractId`);
    const contractVersion = action.contractVersion ?? 1;
    if (!Number.isSafeInteger(contractVersion) || contractVersion < 1) {
      return fail({
        phase: "validate",
        code: "action.invalid_contract_version",
        message: "Action contract versions must be positive integers.",
        path: `${path}/contractVersion`,
      });
    }
    if (!Array.isArray(action.steps) || action.steps.length === 0) {
      return fail({
        phase: "validate",
        code: "action.empty_plan",
        message: "An action plan needs at least one step.",
        path: `${path}/steps`,
      });
    }
    const steps = action.steps.map((step, index) => normalizeActionStep(step, `${path}/steps/${index}`, context));
    const stepIds = new Set<string>();
    for (const step of steps) {
      if (stepIds.has(step.stepId)) {
        return fail({
          phase: "validate",
          code: "action.duplicate_step_id",
          message: `Step id "${step.stepId}" is duplicated in one action plan.`,
          path: `${path}/steps`,
        });
      }
      stepIds.add(step.stepId);
    }
    if (action.onError !== undefined && action.onError !== "halt" && action.onError !== "continue") {
      return fail({
        phase: "validate",
        code: "action.invalid_error_policy",
        message: "onError must be halt or continue.",
        path: `${path}/onError`,
      });
    }
    return [actionId, {
      contractId,
      contractVersion,
      steps,
      onError: action.onError ?? "halt",
    }];
  }));
}

function slotAccepts(parent: NodeContract, slotName: string, child: NodeContract): boolean {
  const slot = parent.slots[slotName]!;
  return Boolean(
    slot.accepts?.includes(child.type)
    || slot.categories?.includes(child.category)
    || (child.category.startsWith("extension:") && slot.categories?.includes("extension:*")),
  );
}

function normalizeNode(
  raw: unknown,
  path: string,
  depth: number,
  context: NormalizeContext,
): string {
  if (depth > context.limits.maxDepth) {
    return fail({
      phase: "normalize",
      code: "limit.node_depth_exceeded",
      message: "The nested surface exceeds the configured depth limit.",
      path,
      expected: context.limits.maxDepth,
    });
  }
  const node = recordAt(raw, path);
  rejectUnknownKeys(node, new Set(["id", "type", "typeVersion", "props", "slots", "events", "evidence"]), path);
  const id = identifierAt(node.id, `${path}/id`);
  if (context.nodes[id]) {
    return fail({
      phase: "normalize",
      code: "node.duplicate_id",
      message: `Node id "${id}" is duplicated.`,
      path: `${path}/id`,
    });
  }
  if (Object.keys(context.nodes).length >= context.limits.maxNodes) {
    return fail({
      phase: "normalize",
      code: "limit.node_count_exceeded",
      message: "The surface exceeds the configured node limit.",
      path,
      expected: context.limits.maxNodes,
    });
  }
  const type = stringAt(node.type, `${path}/type`);
  const contract = context.contracts.get(type);
  if (!contract) {
    return fail({
      phase: "validate",
      code: "catalog.node_not_in_slice",
      message: `Node type "${type}" is not in the active catalog slice.`,
      path: `${path}/type`,
      hint: "Choose a type from the provider schema for this turn.",
    });
  }
  const typeVersion = node.typeVersion ?? contract.version;
  if (typeVersion !== contract.version) {
    return fail({
      phase: "validate",
      code: "catalog.node_version_mismatch",
      message: `Node type "${type}" requires version ${contract.version}.`,
      path: `${path}/typeVersion`,
      expected: contract.version,
    });
  }
  const count = (context.instanceCounts.get(type) ?? 0) + 1;
  if (contract.maxInstances !== undefined && count > contract.maxInstances) {
    return fail({
      phase: "validate",
      code: "limit.node_instances_exceeded",
      message: `Node type "${type}" exceeds its instance limit.`,
      path,
      expected: contract.maxInstances,
    });
  }
  context.instanceCounts.set(type, count);

  const parsedProps = parseContractProps(contract, node.props ?? {}, `${path}/props`);
  const normalized: NormalizedArtifactNode = {
    type,
    typeVersion,
    props: lowerRecord(parsedProps, context, `${path}/props`, contract),
  };
  context.nodes[id] = normalized;

  const rawSlots = node.slots === undefined ? {} : recordAt(node.slots, `${path}/slots`);
  const unknownSlots = Object.keys(rawSlots).filter((name) => !contract.slots[name]);
  if (unknownSlots.length) {
    return fail({
      phase: "validate",
      code: "slot.unknown",
      message: `Slot "${unknownSlots.sort()[0]}" is not declared by "${type}".`,
      path: `${path}/slots/${escapeJsonPointer(unknownSlots.sort()[0]!)}`,
    });
  }
  const slots: Record<string, string[]> = {};
  for (const [slotName, slotContract] of Object.entries(contract.slots).sort(([left], [right]) => left.localeCompare(right))) {
    const children = rawSlots[slotName] ?? [];
    if (!Array.isArray(children)) {
      return fail({
        phase: "validate",
        code: "slot.expected_array",
        message: `Slot "${slotName}" must be an array of nested nodes.`,
        path: `${path}/slots/${escapeJsonPointer(slotName)}`,
      });
    }
    if (children.length < (slotContract.min ?? 0) || children.length > (slotContract.max ?? Number.MAX_SAFE_INTEGER)) {
      return fail({
        phase: "validate",
        code: "slot.cardinality",
        message: `Slot "${slotName}" has an invalid number of children.`,
        path: `${path}/slots/${escapeJsonPointer(slotName)}`,
        expected: { min: slotContract.min ?? 0, max: slotContract.max ?? null },
      });
    }
    const childIds = children.map((child, index) => {
      const childPath = `${path}/slots/${escapeJsonPointer(slotName)}/${index}`;
      const childRecord = recordAt(child, childPath);
      const childType = stringAt(childRecord.type, `${childPath}/type`);
      const childContract = context.contracts.get(childType);
      if (!childContract || !slotAccepts(contract, slotName, childContract)) {
        return fail({
          phase: "validate",
          code: "slot.child_not_allowed",
          message: `Node type "${childType}" is not allowed in "${type}.${slotName}".`,
          path: `${childPath}/type`,
        });
      }
      return normalizeNode(child, childPath, depth + 1, context);
    });
    if (childIds.length) slots[slotName] = childIds;
  }
  if (Object.keys(slots).length) normalized.slots = slots;

  if (node.events !== undefined) {
    const events = recordAt(node.events, `${path}/events`);
    const normalizedEvents: Record<string, string> = {};
    for (const port of Object.keys(events).sort()) {
      if (!contract.events?.[port]) {
        return fail({
          phase: "validate",
          code: "event.unknown_port",
          message: `Event port "${port}" is not declared by "${type}".`,
          path: `${path}/events/${escapeJsonPointer(port)}`,
        });
      }
      normalizedEvents[port] = identifierAt(events[port], `${path}/events/${escapeJsonPointer(port)}`);
    }
    if (Object.keys(normalizedEvents).length) normalized.events = normalizedEvents;
  }

  if (node.evidence !== undefined) {
    if (!Array.isArray(node.evidence)) {
      return fail({
        phase: "validate",
        code: "evidence.expected_array",
        message: "Evidence bindings must be an array of ids.",
        path: `${path}/evidence`,
      });
    }
    const evidence = node.evidence.map((value, index) => identifierAt(value, `${path}/evidence/${index}`));
    if (new Set(evidence).size !== evidence.length) {
      return fail({
        phase: "validate",
        code: "evidence.duplicate_id",
        message: "A node cannot bind the same evidence more than once.",
        path: `${path}/evidence`,
      });
    }
    if (evidence.length) normalized.evidence = evidence;
  }
  return id;
}

function validateActionReferences(
  nodes: Record<string, NormalizedArtifactNode>,
  actions: Record<string, NormalizedActionPlan>,
  contracts: ReadonlyMap<string, NodeContract>,
): void {
  const boundActions = new Set<string>();
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const [port, actionId] of Object.entries(node.events ?? {})) {
      const action = actions[actionId];
      if (!action) {
        fail({
          phase: "validate",
          code: "event.unknown_action",
          message: `Event "${nodeId}.${port}" references undeclared action "${actionId}".`,
          path: `/nodes/${escapeJsonPointer(nodeId)}/events/${escapeJsonPointer(port)}`,
        });
      }
      boundActions.add(actionId);
      const eventContract = contracts.get(node.type)?.events?.[port];
      if (!eventContract) {
        fail({
          phase: "validate",
          code: "event.unknown_port",
          message: `Event port "${port}" is not declared by "${node.type}".`,
          path: `/nodes/${escapeJsonPointer(nodeId)}/events/${escapeJsonPointer(port)}`,
        });
      }
      const versionRange = eventContract.actionContracts[action.contractId];
      if (!versionRange) {
        fail({
          phase: "validate",
          code: "event.action_contract_not_allowed",
          message: `Event "${nodeId}.${port}" does not accept action contract "${action.contractId}".`,
          path: `/actions/${escapeJsonPointer(actionId)}/contractId`,
        });
      }
      if (!matchesActionContractVersion(action.contractVersion, versionRange)) {
        fail({
          phase: "validate",
          code: "event.action_contract_version_mismatch",
          message: `Event "${nodeId}.${port}" does not accept action contract version ${action.contractVersion}.`,
          path: `/actions/${escapeJsonPointer(actionId)}/contractVersion`,
        });
      }
      visitActionEventReferences(actionId, action, (reference, path) => {
        if (reference.port !== port) {
          fail({
            phase: "validate",
            code: "event.reference_port_mismatch",
            message: `Action "${actionId}" must reference its bound event port "${port}".`,
            path: `${path}/port`,
          });
        }
        if (!eventPayloadPathExists(eventContract.payloadSchema, reference.path ?? [])) {
          fail({
            phase: "validate",
            code: "event.reference_path_not_found",
            message: `Event payload path is not declared by "${node.type}.${port}".`,
            path: `${path}/path`,
          });
        }
      });
    }
  }
  for (const [actionId, action] of Object.entries(actions)) {
    for (const [index, step] of action.steps.entries()) {
      if (step.type === "node.focus" && !nodes[step.nodeId]) {
        fail({
          phase: "validate",
          code: "action.unknown_node",
          message: `Action "${actionId}" focuses undeclared node "${step.nodeId}".`,
          path: `/actions/${escapeJsonPointer(actionId)}/steps/${index}/nodeId`,
        });
      }
    }
    if (!boundActions.has(actionId)) {
      visitActionEventReferences(actionId, action, (_reference, path) => {
        fail({
          phase: "validate",
          code: "event.reference_unbound_action",
          message: `Action "${actionId}" cannot read an event payload unless a node binds it.`,
          path,
        });
      });
    }
  }
}

function visitActionEventReferences(
  actionId: string,
  action: NormalizedActionPlan,
  visit: (reference: Extract<ArtifactValue, { kind: "event-ref" }>, path: string) => void,
): void {
  const actionPath = `/actions/${escapeJsonPointer(actionId)}`;
  for (const [index, step] of action.steps.entries()) {
    const path = `${actionPath}/steps/${index}`;
    if (step.type === "state.set") {
      visitEventReferences(step.value, `${path}/value`, visit);
    } else if (step.type === "agent.message") {
      for (const [key, value] of Object.entries(step.values)) {
        visitEventReferences(value, `${path}/values/${escapeJsonPointer(key)}`, visit);
      }
    } else if (step.type === "capability.request") {
      for (const [key, value] of Object.entries(step.input)) {
        visitEventReferences(value, `${path}/input/${escapeJsonPointer(key)}`, visit);
      }
    } else if (step.type === "navigation.request") {
      const values = step.target.kind === "route"
        ? step.target.params
        : step.target.kind === "external" ? step.target.input : undefined;
      for (const [key, value] of Object.entries(values ?? {})) {
        visitEventReferences(value, `${path}/target/${step.target.kind === "route" ? "params" : "input"}/${escapeJsonPointer(key)}`, visit);
      }
    }
  }
}

function visitEventReferences(
  value: ArtifactValue,
  path: string,
  visit: (reference: Extract<ArtifactValue, { kind: "event-ref" }>, path: string) => void,
): void {
  if (value.kind === "event-ref") {
    visit(value, path);
  } else if (value.kind === "array") {
    value.items.forEach((item, index) => visitEventReferences(item, `${path}/${index}`, visit));
  } else if (value.kind === "object") {
    for (const [key, item] of Object.entries(value.entries)) {
      visitEventReferences(item, `${path}/${escapeJsonPointer(key)}`, visit);
    }
  } else if (value.kind === "condition") {
    value.args.forEach((item, index) => visitEventReferences(item, `${path}/args/${index}`, visit));
  }
}

function eventPayloadPathExists(payloadSchema: ZodType<unknown>, path: readonly (string | number)[]): boolean {
  const schema = z.toJSONSchema(payloadSchema, {
    target: "draft-2020-12",
    reused: "inline",
  }) as unknown as JSONSchema;
  return jsonSchemaPathExists(schema, path, schema, new Set());
}

function jsonSchemaPathExists(
  schema: JSONSchema,
  path: readonly (string | number)[],
  root: JSONSchema,
  seenRefs: Set<string>,
): boolean {
  if (path.length === 0) return true;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
    if (seenRefs.has(schema.$ref)) return false;
    const key = schema.$ref.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~");
    const definitions = root.$defs;
    if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return false;
    const target = definitions[key];
    if (!target || typeof target !== "object" || Array.isArray(target)) return false;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(schema.$ref);
    return jsonSchemaPathExists(target as JSONSchema, path, root, nextSeen);
  }

  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.length > 0) {
      return branches.every((branch) => (
        branch !== null && typeof branch === "object" && !Array.isArray(branch)
          && jsonSchemaPathExists(branch as JSONSchema, path, root, new Set(seenRefs))
      ));
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.some((branch) => (
      branch !== null && typeof branch === "object" && !Array.isArray(branch)
        && jsonSchemaPathExists(branch as JSONSchema, path, root, new Set(seenRefs))
    ));
  }

  const [segment, ...remaining] = path;
  if (typeof segment === "string") {
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      const property = properties[segment];
      if (property && typeof property === "object" && !Array.isArray(property)) {
        return jsonSchemaPathExists(property as JSONSchema, remaining, root, seenRefs);
      }
    }
    const additional = schema.additionalProperties;
    return additional !== null && typeof additional === "object" && !Array.isArray(additional)
      ? jsonSchemaPathExists(additional as JSONSchema, remaining, root, seenRefs)
      : false;
  }
  const items = schema.items;
  return items !== null && typeof items === "object" && !Array.isArray(items)
    ? jsonSchemaPathExists(items as JSONSchema, remaining, root, seenRefs)
    : false;
}

function normalizeStringArray(raw: unknown, path: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return fail({
      phase: "validate",
      code: "authoring.expected_array",
      message: "Expected an array of identifiers.",
      path,
    });
  }
  const result = raw.map((item, index) => identifierAt(item, `${path}/${index}`));
  if (new Set(result).size !== result.length) {
    return fail({
      phase: "validate",
      code: "authoring.duplicate_identifier",
      message: "Identifier arrays cannot contain duplicates.",
      path,
    });
  }
  return result.sort();
}

function normalizeMeta(raw: unknown): ArtifactMeta {
  if (raw === undefined) return {};
  const meta = recordAt(raw, "/meta");
  rejectUnknownKeys(meta, new Set(["title", "description", "locale", "tags"]), "/meta");
  const output: ArtifactMeta = {};
  if (meta.title !== undefined) output.title = stringAt(meta.title, "/meta/title");
  if (meta.description !== undefined) output.description = stringAt(meta.description, "/meta/description");
  if (meta.locale !== undefined) output.locale = stringAt(meta.locale, "/meta/locale");
  if (meta.tags !== undefined) output.tags = normalizeStringArray(meta.tags, "/meta/tags");
  return output;
}

export function normalizeSurface(
  input: unknown,
  options: NormalizeSurfaceOptions = {},
): Readonly<NormalizedArtifactProposal> {
  const limits = resolveGenerationLimits(options.limits);
  inspectJson(input, limits);
  const proposal = recordAt(input, "") as ArtifactProposal & Record<string, unknown>;
  rejectUnknownKeys(proposal, new Set(["root", "state", "actions", "claims", "resourceIds", "meta"]), "");

  const contracts = contractMap(options.catalog);
  if (contracts.size === 0) {
    return fail({
      phase: "validate",
      code: "catalog.empty",
      message: "Normalization requires a non-empty compiler catalog or catalog slice.",
      path: "/root/type",
      modelCorrectable: false,
    });
  }
  const state = normalizeStates(proposal.state);
  const declaredResources = normalizeStringArray(proposal.resourceIds, "/resourceIds");
  const grantedResources = options.allowedResourceIds
    ? new Set(options.allowedResourceIds)
    : new Set(declaredResources);
  for (const resourceId of declaredResources) {
    if (!grantedResources.has(resourceId)) {
      return fail({
        phase: "policy",
        code: "reference.resource_not_granted",
        message: `Resource "${resourceId}" is not in the sealed proposal context.`,
        path: "/resourceIds",
        recoverable: false,
        modelCorrectable: false,
      });
    }
  }

  const context: NormalizeContext = {
    contracts,
    limits,
    nodes: {},
    instanceCounts: new Map(),
    stateIds: new Set(Object.keys(state)),
    resourceIds: new Set(declaredResources),
    capabilityIds: new Set(options.capabilityIds ?? []),
    messageTemplateIds: new Set(options.messageTemplateIds ?? []),
  };
  const root = normalizeNode(proposal.root, "/root", 1, context);
  const actions = normalizeActions(proposal.actions, context);
  validateActionReferences(context.nodes, actions, context.contracts);

  const claims = proposal.claims === undefined
    ? {}
    : cloneJson(recordAt(proposal.claims, "/claims") as unknown as JsonValue) as Record<string, JsonValue>;
  const result: NormalizedArtifactProposal = {
    root,
    nodes: context.nodes,
    state,
    actions,
    claims,
    resourceIds: declaredResources,
    meta: normalizeMeta(proposal.meta),
  };
  return deepFreeze(result);
}

export function safeNormalizeSurface(
  input: unknown,
  options: NormalizeSurfaceOptions = {},
):
  | { success: true; data: Readonly<NormalizedArtifactProposal> }
  | { success: false; diagnostics: readonly Diagnostic[] } {
  try {
    return { success: true, data: normalizeSurface(input, options) };
  } catch (error) {
    return { success: false, diagnostics: diagnosticsFromUnknown(error) };
  }
}
