import { z } from "zod";

const workingMemoryProvenanceSchema = z.enum([
  "user-correction",
  "verified-query",
  "schema",
  "code",
  "curated",
]);

/** Cross-session domain learning owned by the host's reviewed continual layer. */
export const tesseraWorkingMemorySchema = z.object({
  preferences: z.object({
    timezone: z.string().min(1).max(128).optional(),
    locale: z.string().min(1).max(64).optional(),
    currency: z.string().min(1).max(32).optional(),
    defaultDateRange: z.string().min(1).max(256).optional(),
    weekStartsOn: z.enum(["monday", "saturday", "sunday"]).optional(),
  }).strict().optional(),
  terminologyById: z.record(
    z.string().min(1).max(128),
    z.object({
      term: z.string().min(1).max(256),
      definition: z.string().min(1).max(2_000),
      scopeRef: z.string().min(1).max(512),
      provenance: workingMemoryProvenanceSchema,
      lastVerifiedAt: z.string().datetime().optional(),
    }).strict(),
  ).optional(),
  analysisRulesById: z.record(
    z.string().min(1).max(128),
    z.object({
      kind: z.enum(["filter", "join", "metric", "source", "freshness", "null", "dedupe"]),
      rule: z.string().min(1).max(2_000),
      scopeRef: z.string().min(1).max(512),
      provenance: workingMemoryProvenanceSchema,
      lastVerifiedAt: z.string().datetime().optional(),
      expiresAt: z.string().datetime().optional(),
    }).strict(),
  ).optional(),
  sourcePreferencesById: z.record(
    z.string().min(1).max(128),
    z.object({
      intent: z.string().min(1).max(512),
      preferredRef: z.string().min(1).max(512),
      reason: z.string().min(1).max(1_000),
      scopeRef: z.string().min(1).max(512),
      provenance: workingMemoryProvenanceSchema,
      lastVerifiedAt: z.string().datetime().optional(),
    }).strict(),
  ).optional(),
}).strict();

export type TesseraWorkingMemory = z.infer<typeof tesseraWorkingMemorySchema>;

export const tesseraWorkingMemoryOptions = Object.freeze({
  enabled: true,
  scope: "resource" as const,
  schema: tesseraWorkingMemorySchema,
  // Only a reviewed host process may update cross-session domain memory.
  agentManaged: false,
  useStateSignals: false,
});
