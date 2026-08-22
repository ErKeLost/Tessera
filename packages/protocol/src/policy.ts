import { z } from "zod";

export const sensitivitySchema = z.enum(["public", "private", "sensitive"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

export const stateScopeSchema = z.enum(["surface", "document", "external"]);
export type StateScope = z.infer<typeof stateScopeSchema>;

export const modelVisibilitySchema = z.enum(["none", "descriptor", "value"]);
export type ModelVisibility = z.infer<typeof modelVisibilitySchema>;

export const retentionPolicySchema = z.enum([
  "retain",
  "reset-on-commit",
  "prune-when-unreferenced",
]);
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;

export const dataClassificationSchema = z.union([
  z.enum(["public", "internal", "confidential", "restricted"]),
  z.string().regex(/^custom:[a-z][a-z0-9.-]{0,127}$/),
]);
export type DataClassification = z.infer<typeof dataClassificationSchema>;
