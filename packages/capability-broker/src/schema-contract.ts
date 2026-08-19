import { canonicalHash, jsonValueSchema, type JsonValue } from "@data-elements/runtime";
import { z } from "zod";
import type { JsonSchema, SchemaProfileBinding, SchemaProfileLimits } from "./types";

const ALLOWED_KEYS = new Set([
  "$schema", "$id", "$comment", "$defs", "definitions", "$ref", "type", "enum", "const",
  "anyOf", "oneOf", "allOf", "properties", "required", "additionalProperties",
  "minProperties", "maxProperties", "items", "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "description", "format",
]);
const ALLOWED_FORMATS = new Set(["email", "uri", "uuid", "date-time", "date", "time", "duration", "ipv4", "ipv6"]);
const KNOWN_DIALECTS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft-07/schema#",
]);

export const DEFAULT_SCHEMA_PROFILE_LIMITS: Readonly<SchemaProfileLimits> = Object.freeze({
  maxSchemaDepth: 32,
  maxSchemaNodes: 2_000,
  maxUnionBranches: 64,
  maxStringLength: 256 * 1024,
  maxArrayItems: 10_000,
  maxObjectProperties: 2_000,
});

export class SchemaContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SchemaContractError";
    this.code = code;
  }
}

export type PreparedJsonSchema = {
  schema: JsonSchema;
  schemaHash: string;
  validator: z.ZodType;
};

export async function prepareJsonSchema(
  schema: JsonSchema,
  expectedHash: string,
  options: { limits?: Partial<SchemaProfileLimits> } = {},
): Promise<PreparedJsonSchema> {
  const limits = { ...DEFAULT_SCHEMA_PROFILE_LIMITS, ...options.limits };
  assertBoundedJsonSchema(schema, limits);
  const schemaHash = await canonicalHash(schema);
  if (schemaHash !== expectedHash) {
    throw new SchemaContractError("schema.hash-mismatch", "JSON Schema hash does not match its declared identity.");
  }
  let validator: z.ZodType;
  try {
    const base = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    const checkBounds = createRuntimeConstraintCheck(schema);
    validator = base.superRefine((value, context) => {
      const failure = checkBounds(value);
      if (failure) context.addIssue({ code: "custom", message: failure });
    });
  } catch (error) {
    throw new SchemaContractError(
      "schema.compile-failed",
      `JSON Schema cannot be compiled by the schema-core profile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { schema: clone(schema), schemaHash, validator };
}

export function assertSchemaProfile(
  actual: SchemaProfileBinding,
  expected: SchemaProfileBinding,
): void {
  if (
    actual.profileId !== expected.profileId
    || actual.profileVersion !== expected.profileVersion
    || actual.profileHash !== expected.profileHash
  ) {
    throw new SchemaContractError("schema.profile-mismatch", "Schema profile identity does not match the broker profile.");
  }
}

export function parseJsonWithSchema(validator: z.ZodType, input: unknown): JsonValue {
  const json = jsonValueSchema.safeParse(input);
  if (!json.success) {
    throw new SchemaContractError("schema.non-json-value", "Value is not finite, prototype-safe JSON.");
  }
  const result = validator.safeParse(json.data);
  if (!result.success) {
    throw new SchemaContractError("schema.value-invalid", result.error.issues.map((issue) => issue.message).join("; "));
  }
  const output = jsonValueSchema.safeParse(result.data);
  if (!output.success) {
    throw new SchemaContractError("schema.output-non-json", "Schema transformation produced a non-JSON value.");
  }
  return output.data;
}

export function assertBoundedJsonSchema(
  schema: JsonSchema,
  limits: SchemaProfileLimits = DEFAULT_SCHEMA_PROFILE_LIMITS,
): void {
  if (schema === true) throw new SchemaContractError("schema.unbounded", "The true JSON Schema is not allowed.");
  if (schema === false) return;
  const root = schema as Record<string, unknown>;
  const seenRefs = new Set<string>();
  let nodes = 0;

  const visit = (candidate: unknown, depth: number, path: string, refStack: readonly string[]): void => {
    nodes += 1;
    if (nodes > limits.maxSchemaNodes) throw new SchemaContractError("schema.node-limit", "JSON Schema is too large.");
    if (depth > limits.maxSchemaDepth) throw new SchemaContractError("schema.depth-limit", "JSON Schema is too deeply nested.");
    if (candidate === false) return;
    if (candidate === true || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new SchemaContractError("schema.invalid-node", `Invalid or unbounded schema node at ${path}.`);
    }
    const node = candidate as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new SchemaContractError("schema.unsupported-keyword", `Unsupported JSON Schema keyword ${key} at ${path}.`);
      }
    }
    if (typeof node.$schema === "string" && !KNOWN_DIALECTS.has(node.$schema)) {
      throw new SchemaContractError("schema.unsupported-dialect", `Unsupported JSON Schema dialect at ${path}.`);
    }
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) {
        throw new SchemaContractError("schema.remote-ref", `Only local JSON Pointer references are allowed at ${path}.`);
      }
      const siblings = Object.keys(node).filter((key) => key !== "$ref" && key !== "$comment" && key !== "description");
      if (siblings.length > 0) throw new SchemaContractError("schema.ref-siblings", `$ref siblings are not allowed at ${path}.`);
      if (refStack.includes(node.$ref)) throw new SchemaContractError("schema.recursive-ref", `Recursive schema reference at ${path}.`);
      const target = resolveLocalRef(root, node.$ref);
      seenRefs.add(node.$ref);
      visit(target, depth + 1, node.$ref, [...refStack, node.$ref]);
      return;
    }

    const variants = [node.anyOf, node.oneOf, node.allOf].filter((value) => value !== undefined);
    if (variants.length > 1) throw new SchemaContractError("schema.ambiguous-composition", `Only one composition keyword is allowed at ${path}.`);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = node[key];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length === 0 || branches.length > limits.maxUnionBranches) {
        throw new SchemaContractError("schema.union-limit", `Invalid ${key} branch count at ${path}.`);
      }
      branches.forEach((branch, index) => visit(branch, depth + 1, `${path}/${key}/${index}`, refStack));
    }

    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > limits.maxUnionBranches) {
        throw new SchemaContractError("schema.enum-limit", `Invalid enum at ${path}.`);
      }
      for (const value of node.enum) {
        if (!jsonValueSchema.safeParse(value).success) throw new SchemaContractError("schema.invalid-enum", `Non-JSON enum at ${path}.`);
      }
    }

    const type = node.type;
    const hasShape = type !== undefined || node.const !== undefined || node.enum !== undefined || variants.length > 0;
    if (!hasShape) throw new SchemaContractError("schema.unbounded", `Schema has no constraining type or composition at ${path}.`);
    if (Array.isArray(type)) throw new SchemaContractError("schema.type-array", `Type arrays are not in the schema-core profile at ${path}.`);
    if (type !== undefined && !["null", "boolean", "number", "integer", "string", "array", "object"].includes(String(type))) {
      throw new SchemaContractError("schema.unsupported-type", `Unsupported type at ${path}.`);
    }
    if (typeof node.format === "string" && !ALLOWED_FORMATS.has(node.format)) {
      throw new SchemaContractError("schema.unsupported-format", `Unsupported string format ${node.format} at ${path}.`);
    }
    if (type === "string" && node.const === undefined && node.enum === undefined) {
      assertBound(node.maxLength, limits.maxStringLength, "maxLength", path);
    }
    if (type === "array") {
      assertBound(node.maxItems, limits.maxArrayItems, "maxItems", path);
      if (node.items === undefined || Array.isArray(node.items)) {
        throw new SchemaContractError("schema.unbounded-items", `Arrays require one bounded items schema at ${path}.`);
      }
      visit(node.items, depth + 1, `${path}/items`, refStack);
    }
    if (type === "object") {
      const properties = node.properties;
      if (properties !== undefined && (properties === null || typeof properties !== "object" || Array.isArray(properties))) {
        throw new SchemaContractError("schema.invalid-properties", `Invalid properties map at ${path}.`);
      }
      const propertyEntries = Object.entries((properties ?? {}) as Record<string, unknown>);
      if (propertyEntries.length > limits.maxObjectProperties) throw new SchemaContractError("schema.property-limit", `Too many properties at ${path}.`);
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string")) {
          throw new SchemaContractError("schema.invalid-required", `required must be a string array at ${path}.`);
        }
        if (new Set(node.required).size !== node.required.length) {
          throw new SchemaContractError("schema.duplicate-required", `required contains duplicates at ${path}.`);
        }
      }
      if (node.minProperties !== undefined) assertBound(node.minProperties, limits.maxObjectProperties, "minProperties", path);
      if (node.maxProperties !== undefined) assertBound(node.maxProperties, limits.maxObjectProperties, "maxProperties", path);
      if (
        typeof node.minProperties === "number"
        && typeof node.maxProperties === "number"
        && node.minProperties > node.maxProperties
      ) throw new SchemaContractError("schema.property-range", `minProperties exceeds maxProperties at ${path}.`);
      for (const [key, value] of propertyEntries) visit(value, depth + 1, `${path}/properties/${escapePointer(key)}`, refStack);
      if (node.additionalProperties !== false) {
        assertBound(node.maxProperties, limits.maxObjectProperties, "maxProperties", path);
        if (node.additionalProperties === undefined || node.additionalProperties === true) {
          throw new SchemaContractError("schema.untyped-properties", `Open objects require a typed additionalProperties schema at ${path}.`);
        }
        visit(node.additionalProperties, depth + 1, `${path}/additionalProperties`, refStack);
      }
    }
  };

  visit(root, 0, "#", []);
  for (const refsKey of ["$defs", "definitions"] as const) {
    const defs = root[refsKey];
    if (defs === undefined) continue;
    if (defs === null || typeof defs !== "object" || Array.isArray(defs)) {
      throw new SchemaContractError("schema.invalid-definitions", `Invalid ${refsKey}.`);
    }
    for (const [key, definition] of Object.entries(defs as Record<string, unknown>)) {
      const pointer = `#/${refsKey}/${escapePointer(key)}`;
      if (!seenRefs.has(pointer)) visit(definition, 1, pointer, []);
    }
  }
}

function resolveLocalRef(root: Record<string, unknown>, ref: string): unknown {
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) {
      throw new SchemaContractError("schema.missing-ref", `Local reference does not exist: ${ref}.`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function assertBound(value: unknown, ceiling: number, keyword: string, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > ceiling) {
    throw new SchemaContractError("schema.unbounded", `${keyword} must be an integer no greater than ${ceiling} at ${path}.`);
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createRuntimeConstraintCheck(schema: JsonSchema): (value: unknown) => string | undefined {
  if (typeof schema === "boolean") return () => undefined;
  const root = schema as Record<string, unknown>;
  const branchValidators = new WeakMap<object, z.ZodType>();

  const matches = (branch: unknown, value: unknown): boolean => {
    if (typeof branch === "boolean") return branch;
    if (branch === null || typeof branch !== "object" || Array.isArray(branch)) return false;
    let validator = branchValidators.get(branch);
    if (!validator) {
      const candidate = {
        ...(branch as Record<string, unknown>),
        ...(root.$defs ? { $defs: root.$defs } : {}),
        ...(root.definitions ? { definitions: root.definitions } : {}),
      };
      validator = z.fromJSONSchema(candidate as Parameters<typeof z.fromJSONSchema>[0]);
      branchValidators.set(branch, validator);
    }
    return validator.safeParse(value).success;
  };

  const inspect = (candidate: unknown, value: unknown, path: string): string | undefined => {
    if (typeof candidate === "boolean") return undefined;
    const node = candidate as Record<string, unknown>;
    if (typeof node.$ref === "string") return inspect(resolveLocalRef(root, node.$ref), value, path);
    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) {
        const failure = inspect(branch, value, path);
        if (failure) return failure;
      }
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = node[key];
      if (!Array.isArray(branches)) continue;
      const eligible = branches.filter((branch) => matches(branch, value));
      if (eligible.length > 0) {
        const failures = eligible.map((branch) => inspect(branch, value, path));
        if (failures.every(Boolean)) return failures[0];
      }
    }
    if (node.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (typeof node.minProperties === "number" && keys.length < node.minProperties) return `${path} has fewer than ${node.minProperties} properties.`;
      if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) return `${path} has more than ${node.maxProperties} properties.`;
      if (Array.isArray(node.required)) {
        for (const key of node.required) if (typeof key === "string" && !Object.hasOwn(record, key)) return `${path} is missing required property ${key}.`;
      }
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        const child = properties[key] ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
        if (child !== undefined) {
          const failure = inspect(child, item, `${path}/${escapePointer(key)}`);
          if (failure) return failure;
        }
      }
    }
    if (node.type === "array" && Array.isArray(value) && node.items !== undefined && !Array.isArray(node.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const failure = inspect(node.items, value[index], `${path}/${index}`);
        if (failure) return failure;
      }
    }
    return undefined;
  };
  return (value) => inspect(root, value, "$");
}
