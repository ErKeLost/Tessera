import { createHash } from "node:crypto";
import {
  canonicalEncode,
  resourceSchemaConstraintSchema,
  resourceSchemaIdSchema,
  sha256HashSchema,
  type JSONSchema,
  type JsonValue,
  type ResourceSchemaConstraint,
  type Sha256Hash,
} from "@open-generative/protocol";
import { z } from "zod";

type RegisteredResourceSchema = Readonly<{
  constraint: ResourceSchemaConstraint;
  schema: JSONSchema;
  validator: z.ZodType;
}>;

export class ResourceSchemaRegistry {
  readonly #schemas = new Map<string, RegisteredResourceSchema>();

  register(input: Readonly<{
    schemaId: string;
    schemaRevision: number;
    schema: JSONSchema;
    compatibility?: "exact" | "backward-compatible";
  }>): ResourceSchemaConstraint {
    const schemaId = resourceSchemaIdSchema.parse(input.schemaId);
    const schemaHash = resourceSchemaHash(input.schema);
    const constraint = resourceSchemaConstraintSchema.parse({
      schemaId,
      schemaRevision: input.schemaRevision,
      schemaHash,
      compatibility: input.compatibility ?? "exact",
    });
    const key = schemaKey(constraint);
    const existing = this.#schemas.get(key);
    if (existing && existing.constraint.schemaHash !== schemaHash) {
      throw new Error("Resource schema revision was reused with different bytes.");
    }
    this.#schemas.set(key, Object.freeze({
      constraint,
      schema: structuredClone(input.schema),
      validator: z.fromJSONSchema(input.schema),
    }));
    return constraint;
  }

  validate(constraintInput: ResourceSchemaConstraint, payload: JsonValue): JsonValue {
    const constraint = resourceSchemaConstraintSchema.parse(constraintInput);
    const registered = this.#schemas.get(schemaKey(constraint));
    if (!registered || registered.constraint.schemaHash !== constraint.schemaHash) {
      throw new ResourceSchemaError("resource.schema-not-registered", "The exact resource schema is not registered.");
    }
    return registered.validator.parse(payload) as JsonValue;
  }

  get(constraintInput: ResourceSchemaConstraint): Readonly<{
    constraint: ResourceSchemaConstraint;
    schema: JSONSchema;
  }> | undefined {
    const constraint = resourceSchemaConstraintSchema.parse(constraintInput);
    const registered = this.#schemas.get(schemaKey(constraint));
    return registered ? structuredClone({
      constraint: registered.constraint,
      schema: registered.schema,
    }) : undefined;
  }
}

export class ResourceSchemaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResourceSchemaError";
  }
}

export function resourceSchemaHash(schema: JSONSchema): Sha256Hash {
  const hash = createHash("sha256");
  hash.update("open-generative.resource-schema\0", "utf8");
  hash.update(canonicalEncode(schema));
  return sha256HashSchema.parse(`sha256:${hash.digest("hex")}`);
}

function schemaKey(constraint: ResourceSchemaConstraint): string {
  return `${constraint.schemaId}@${constraint.schemaRevision}`;
}
