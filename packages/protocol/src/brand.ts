import { z } from "zod";

declare const openGenerativeBrand: unique symbol;

export type Brand<TValue, TName extends string> = TValue & {
  readonly [openGenerativeBrand]: TName;
};

export type BrandedString<TName extends string> = Brand<string, TName>;

export function brandedStringSchema<TName extends string>(schema: z.ZodString) {
  return schema.transform((value): BrandedString<TName> => value as BrandedString<TName>);
}
