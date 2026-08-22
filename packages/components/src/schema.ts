import {
  jsonSchemaSchema,
  type ColumnId,
  type JSONSchema,
  type ResourceBindingId,
} from "@open-generative/protocol";
import { z } from "zod";

const portableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function portableId<TId extends string>() {
  return z.string()
    .min(1)
    .max(256)
    .regex(portableIdPattern, "Expected a portable Open Generative identifier.") as unknown as z.ZodType<TId>;
}

export const columnIdValueSchema = portableId<ColumnId>();
export const resourceBindingIdValueSchema = portableId<ResourceBindingId>();

export const expressionPathSegmentSchema = z.union([
  z.string().min(1).max(1_024),
  z.number().int().nonnegative(),
]);

export const resourceBindingExprSchema = z.object({
  kind: z.literal("resource-ref"),
  bindingId: resourceBindingIdValueSchema,
  path: z.array(expressionPathSegmentSchema).max(64).optional(),
}).strict();

const fractionDigitsSchema = z.number().int().min(0).max(12);
const numberFormatSchema = z.object({
  kind: z.literal("number"),
  notation: z.enum(["standard", "compact", "scientific"]).default("standard"),
  minimumFractionDigits: fractionDigitsSchema.optional(),
  maximumFractionDigits: fractionDigitsSchema.optional(),
  unit: z.string().trim().min(1).max(32).optional(),
}).strict().superRefine((format, context) => {
  if (
    format.minimumFractionDigits !== undefined
    && format.maximumFractionDigits !== undefined
    && format.minimumFractionDigits > format.maximumFractionDigits
  ) {
    context.addIssue({
      code: "custom",
      path: ["maximumFractionDigits"],
      message: "Maximum fraction digits must not be lower than minimum fraction digits.",
    });
  }
});

const currencyFormatSchema = z.object({
  kind: z.literal("currency"),
  currency: z.string().regex(/^[A-Z]{3}$/, "Expected an ISO 4217 currency code."),
  display: z.enum(["symbol", "narrow-symbol", "code", "name"]).default("symbol"),
  maximumFractionDigits: fractionDigitsSchema.optional(),
}).strict();

const percentFormatSchema = z.object({
  kind: z.literal("percent"),
  maximumFractionDigits: fractionDigitsSchema.optional(),
}).strict();

const dateFormatSchema = z.object({
  kind: z.literal("date"),
  dateStyle: z.enum(["short", "medium", "long", "full"]).default("medium"),
}).strict();

const dateTimeFormatSchema = z.object({
  kind: z.literal("datetime"),
  dateStyle: z.enum(["short", "medium", "long", "full"]).default("medium"),
  timeStyle: z.enum(["short", "medium", "long", "full"]).default("short"),
}).strict();

export const formatTokenSchema = z.discriminatedUnion("kind", [
  numberFormatSchema,
  currencyFormatSchema,
  percentFormatSchema,
  dateFormatSchema,
  dateTimeFormatSchema,
]);

export type ResourceBindingExpr = z.infer<typeof resourceBindingExprSchema>;
export type FormatToken = z.infer<typeof formatTokenSchema>;

export function toStrictJsonSchema(schema: z.ZodType): JSONSchema {
  return jsonSchemaSchema.parse(z.toJSONSchema(schema));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
