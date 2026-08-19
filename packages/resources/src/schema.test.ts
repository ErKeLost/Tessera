import { describe, expect, test } from "bun:test";
import { canonicalHash } from "@data-elements/runtime";
import {
  compileResourceSchema,
  parseResourceValue,
  ResourceSchemaError,
  type RegisteredResourceSchema,
  type SchemaProfileBinding,
} from "./index";

const PROFILE: SchemaProfileBinding = {
  profileId: "data-elements.schema-core",
  profileVersion: 1,
  profileHash: "profile-hash",
};

describe("resource schema profile", () => {
  test("enforces bounded open-object limits omitted by the converter", async () => {
    const schema: RegisteredResourceSchema["schema"] = {
      type: "object",
      maxProperties: 1,
      additionalProperties: { type: "integer" },
    };
    const registration: RegisteredResourceSchema = {
      schemaId: "bounded-map",
      schemaVersion: 1,
      schemaHash: await canonicalHash(schema),
      schemaProfile: PROFILE,
      schema,
    };
    const validator = await compileResourceSchema(registration, PROFILE);
    expect(parseResourceValue(validator, { one: 1 })).toEqual({ one: 1 });
    expect(() => parseResourceValue(validator, { one: 1, two: 2 })).toThrow(ResourceSchemaError);
  });
});
