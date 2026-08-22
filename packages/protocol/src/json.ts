import { z } from "zod";
import { brandedStringSchema, type BrandedString } from "./brand";
import { DEFAULT_PROTOCOL_LIMITS, FORBIDDEN_OBJECT_KEYS } from "./constants";

export type JsonScalar = null | boolean | string | number;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JSONSchema = boolean | JsonObject;
export type PathSegment = string | number;
export type JsonPointer = BrandedString<"JsonPointer">;

export const finiteNumberSchema = z.number().refine(Number.isFinite, "Number must be finite.");

export const safeObjectKeySchema = z.string()
  .max(1_024)
  .refine((key) => !FORBIDDEN_OBJECT_KEYS.has(key), "Prototype-polluting object key is forbidden.");

export const jsonScalarSchema: z.ZodType<JsonScalar> = z.union([
  z.null(),
  z.boolean(),
  z.string().max(DEFAULT_PROTOCOL_LIMITS.maxStringBytes),
  finiteNumberSchema,
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  jsonScalarSchema,
  z.array(jsonValueSchema).max(DEFAULT_PROTOCOL_LIMITS.maxCollectionItems),
  z.record(safeObjectKeySchema, jsonValueSchema),
]));

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(safeObjectKeySchema, jsonValueSchema);
export const jsonSchemaSchema: z.ZodType<JSONSchema> = z.union([z.boolean(), jsonObjectSchema]);

export const pathSegmentSchema = z.union([
  safeObjectKeySchema,
  z.number().int().nonnegative(),
]);

export const pathSchema = z.array(pathSegmentSchema).max(DEFAULT_PROTOCOL_LIMITS.maxDepth);

export const jsonPointerSchema = brandedStringSchema<"JsonPointer">(
  z.string().max(4_096).refine(
    (value) => value === "" || /^(?:\/(?:[^~/]|~0|~1)*)+$/.test(value),
    "Expected an RFC 6901 JSON Pointer.",
  ),
);

export const isoTimestampSchema = z.iso.datetime({ offset: true });

export function assertValidUnicode(value: string, path = "$"): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`Unpaired high surrogate at ${path}.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`Unpaired low surrogate at ${path}.`);
    }
  }
}
