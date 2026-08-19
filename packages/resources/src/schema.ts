import { canonicalHash, jsonValueSchema, type JsonValue } from "@data-elements/runtime";
import { z } from "zod";
import type { JsonSchema, RegisteredResourceSchema, SchemaProfileBinding } from "./types";

const ALLOWED_KEYS = new Set([
  "$schema", "$id", "$comment", "$defs", "definitions", "$ref", "type", "enum", "const",
  "anyOf", "oneOf", "allOf", "properties", "required", "additionalProperties", "minProperties",
  "maxProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "description", "format",
]);
const ALLOWED_FORMATS = new Set(["email", "uri", "uuid", "date-time", "date", "time", "duration", "ipv4", "ipv6"]);

export type ResourceSchemaLimits = {
  maxSchemaDepth: number;
  maxSchemaNodes: number;
  maxBranches: number;
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectProperties: number;
};

export const DEFAULT_RESOURCE_SCHEMA_LIMITS: Readonly<ResourceSchemaLimits> = Object.freeze({
  maxSchemaDepth: 32,
  maxSchemaNodes: 2_000,
  maxBranches: 64,
  maxStringLength: 256 * 1024,
  maxArrayItems: 10_000,
  maxObjectProperties: 2_000,
});

export class ResourceSchemaError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceSchemaError";
    this.code = code;
  }
}

export async function compileResourceSchema(
  registration: RegisteredResourceSchema,
  expectedProfile: SchemaProfileBinding,
  options: { limits?: Partial<ResourceSchemaLimits> } = {},
): Promise<z.ZodType> {
  if (
    registration.schemaProfile.profileId !== expectedProfile.profileId
    || registration.schemaProfile.profileVersion !== expectedProfile.profileVersion
    || registration.schemaProfile.profileHash !== expectedProfile.profileHash
  ) throw new ResourceSchemaError("resource.schema-profile", "Resource schema profile does not match the resolver profile.");
  assertBoundedResourceSchema(registration.schema, { ...DEFAULT_RESOURCE_SCHEMA_LIMITS, ...options.limits });
  if (await canonicalHash(registration.schema) !== registration.schemaHash) {
    throw new ResourceSchemaError("resource.schema-hash", "Resource schema hash does not match the registered identity.");
  }
  try {
    const base = z.fromJSONSchema(registration.schema as Parameters<typeof z.fromJSONSchema>[0]);
    const checkBounds = createRuntimeConstraintCheck(registration.schema);
    return base.superRefine((value, context) => {
      const failure = checkBounds(value);
      if (failure) context.addIssue({ code: "custom", message: failure });
    });
  } catch (error) {
    throw new ResourceSchemaError("resource.schema-compile", `Resource schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseResourceValue(validator: z.ZodType, input: unknown): JsonValue {
  const json = jsonValueSchema.safeParse(input);
  if (!json.success) throw new ResourceSchemaError("resource.non-json", "Resource value is not finite, prototype-safe JSON.");
  const parsed = validator.safeParse(json.data);
  if (!parsed.success) throw new ResourceSchemaError("resource.schema-invalid", parsed.error.issues.map((issue) => issue.message).join("; "));
  const output = jsonValueSchema.safeParse(parsed.data);
  if (!output.success) throw new ResourceSchemaError("resource.schema-output", "Resource schema produced a non-JSON value.");
  return output.data;
}

export function assertBoundedResourceSchema(
  schema: JsonSchema,
  limits: ResourceSchemaLimits = DEFAULT_RESOURCE_SCHEMA_LIMITS,
): void {
  if (schema === true) throw new ResourceSchemaError("resource.schema-unbounded", "The true JSON Schema is forbidden.");
  if (schema === false) return;
  const root = schema as Record<string, unknown>;
  let nodes = 0;
  const refsSeen = new Set<string>();

  const visit = (value: unknown, depth: number, path: string, stack: readonly string[]): void => {
    nodes += 1;
    if (nodes > limits.maxSchemaNodes) throw new ResourceSchemaError("resource.schema-node-limit", "Resource schema is too large.");
    if (depth > limits.maxSchemaDepth) throw new ResourceSchemaError("resource.schema-depth-limit", "Resource schema is too deep.");
    if (value === false) return;
    if (value === true || value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ResourceSchemaError("resource.schema-node", `Invalid or unbounded schema at ${path}.`);
    }
    const node = value as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYS.has(key)) throw new ResourceSchemaError("resource.schema-keyword", `Unsupported keyword ${key} at ${path}.`);
    }
    if (typeof node.$schema === "string" && ![
      "https://json-schema.org/draft/2020-12/schema",
      "http://json-schema.org/draft-07/schema#",
    ].includes(node.$schema)) throw new ResourceSchemaError("resource.schema-dialect", "Unsupported JSON Schema dialect.");
    if (node.$ref !== undefined) {
      if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/")) throw new ResourceSchemaError("resource.schema-ref", "Only local JSON Pointer refs are allowed.");
      if (stack.includes(node.$ref)) throw new ResourceSchemaError("resource.schema-recursive", "Recursive resource schemas are forbidden.");
      if (Object.keys(node).some((key) => !["$ref", "$comment", "description"].includes(key))) throw new ResourceSchemaError("resource.schema-ref-siblings", "$ref siblings are forbidden.");
      refsSeen.add(node.$ref);
      visit(resolveRef(root, node.$ref), depth + 1, node.$ref, [...stack, node.$ref]);
      return;
    }
    const compositions = ["anyOf", "oneOf", "allOf"].filter((key) => node[key] !== undefined);
    if (compositions.length > 1) throw new ResourceSchemaError("resource.schema-composition", "Only one composition keyword is allowed per schema node.");
    for (const key of compositions) {
      const branches = node[key];
      if (!Array.isArray(branches) || branches.length === 0 || branches.length > limits.maxBranches) throw new ResourceSchemaError("resource.schema-branches", `Invalid ${key} branches.`);
      branches.forEach((branch, index) => visit(branch, depth + 1, `${path}/${key}/${index}`, stack));
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > limits.maxBranches)) {
      throw new ResourceSchemaError("resource.schema-enum", "Resource schema enum is invalid or too large.");
    }
    const constrained = node.type !== undefined || node.enum !== undefined || node.const !== undefined || compositions.length > 0;
    if (!constrained) throw new ResourceSchemaError("resource.schema-unbounded", `Schema is unconstrained at ${path}.`);
    if (Array.isArray(node.type)) throw new ResourceSchemaError("resource.schema-type-array", "Type arrays are not supported.");
    if (node.format !== undefined && (typeof node.format !== "string" || !ALLOWED_FORMATS.has(node.format))) throw new ResourceSchemaError("resource.schema-format", "Unsupported resource string format.");
    if (node.type === "string" && node.enum === undefined && node.const === undefined) bound(node.maxLength, limits.maxStringLength, "maxLength", path);
    if (node.type === "array") {
      bound(node.maxItems, limits.maxArrayItems, "maxItems", path);
      if (node.items === undefined || Array.isArray(node.items)) throw new ResourceSchemaError("resource.schema-items", "Arrays require one bounded items schema.");
      visit(node.items, depth + 1, `${path}/items`, stack);
    }
    if (node.type === "object") {
      const properties = node.properties ?? {};
      if (properties === null || typeof properties !== "object" || Array.isArray(properties)) throw new ResourceSchemaError("resource.schema-properties", "Invalid properties map.");
      const entries = Object.entries(properties as Record<string, unknown>);
      if (entries.length > limits.maxObjectProperties) throw new ResourceSchemaError("resource.schema-property-limit", "Too many object properties.");
      if (node.required !== undefined) {
        if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string")) throw new ResourceSchemaError("resource.schema-required", "required must be a string array.");
        if (new Set(node.required).size !== node.required.length) throw new ResourceSchemaError("resource.schema-required", "required contains duplicates.");
      }
      if (node.minProperties !== undefined) bound(node.minProperties, limits.maxObjectProperties, "minProperties", path);
      if (node.maxProperties !== undefined) bound(node.maxProperties, limits.maxObjectProperties, "maxProperties", path);
      if (typeof node.minProperties === "number" && typeof node.maxProperties === "number" && node.minProperties > node.maxProperties) throw new ResourceSchemaError("resource.schema-property-range", "minProperties exceeds maxProperties.");
      for (const [key, property] of entries) visit(property, depth + 1, `${path}/properties/${key}`, stack);
      if (node.additionalProperties !== false) {
        bound(node.maxProperties, limits.maxObjectProperties, "maxProperties", path);
        if (node.additionalProperties === undefined || node.additionalProperties === true) throw new ResourceSchemaError("resource.schema-open-object", "Open objects require typed additionalProperties.");
        visit(node.additionalProperties, depth + 1, `${path}/additionalProperties`, stack);
      }
    }
  };
  visit(root, 0, "#", []);
  for (const key of ["$defs", "definitions"] as const) {
    const defs = root[key];
    if (defs === undefined) continue;
    if (defs === null || typeof defs !== "object" || Array.isArray(defs)) throw new ResourceSchemaError("resource.schema-definitions", "Invalid schema definitions.");
    for (const [id, definition] of Object.entries(defs as Record<string, unknown>)) {
      const ref = `#/${key}/${id.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!refsSeen.has(ref)) visit(definition, 1, ref, []);
    }
  }
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  let current: unknown = root;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, key)) throw new ResourceSchemaError("resource.schema-missing-ref", `Missing local ref ${ref}.`);
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function bound(value: unknown, maximum: number, keyword: string, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new ResourceSchemaError("resource.schema-unbounded", `${keyword} must be no greater than ${maximum} at ${path}.`);
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
    if (typeof node.$ref === "string") return inspect(resolveRef(root, node.$ref), value, path);
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
      if (typeof node.minProperties === "number" && keys.length < node.minProperties) return `${path} has too few properties.`;
      if (typeof node.maxProperties === "number" && keys.length > node.maxProperties) return `${path} has too many properties.`;
      if (Array.isArray(node.required)) {
        for (const key of node.required) if (typeof key === "string" && !Object.hasOwn(record, key)) return `${path} is missing required property ${key}.`;
      }
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        const child = properties[key] ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
        if (child !== undefined) {
          const failure = inspect(child, item, `${path}/${key}`);
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
