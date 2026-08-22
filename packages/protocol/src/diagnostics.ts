import { z } from "zod";
import {
  actionIdSchema,
  claimIdSchema,
  documentIdSchema,
  evidenceIdSchema,
  nodeIdSchema,
  operationIdSchema,
  resourceBindingIdSchema,
  revisionIdSchema,
  stateIdSchema,
  streamIdSchema,
  transactionIdSchema,
} from "./ids";
import { jsonValueSchema, jsonPointerSchema } from "./json";

export const diagnosticPhaseSchema = z.enum([
  "decode",
  "authoring",
  "normalize",
  "validate",
  "policy",
  "commit",
  "resource",
  "action",
  "render",
  "transport",
]);

export const diagnosticEntitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document"), id: documentIdSchema }).strict(),
  z.object({ kind: z.literal("revision"), id: revisionIdSchema }).strict(),
  z.object({ kind: z.literal("node"), id: nodeIdSchema }).strict(),
  z.object({ kind: z.literal("state"), id: stateIdSchema }).strict(),
  z.object({ kind: z.literal("action"), id: actionIdSchema }).strict(),
  z.object({ kind: z.literal("resource"), id: resourceBindingIdSchema }).strict(),
  z.object({ kind: z.literal("evidence"), id: evidenceIdSchema }).strict(),
  z.object({ kind: z.literal("claim"), id: claimIdSchema }).strict(),
]);

export const diagnosticSchema = z.object({
  phase: diagnosticPhaseSchema,
  code: z.string().min(1).max(192).regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/),
  severity: z.enum(["info", "warning", "error", "fatal"]),
  recoverable: z.boolean(),
  modelCorrectable: z.boolean(),
  message: z.string().min(1).max(4_096),
  location: z.object({
    streamId: streamIdSchema.optional(),
    transactionId: transactionIdSchema.optional(),
    operationId: operationIdSchema.optional(),
    revisionId: revisionIdSchema.optional(),
    sequence: z.number().int().nonnegative().optional(),
    entity: diagnosticEntitySchema.optional(),
    path: jsonPointerSchema.optional(),
  }).strict().optional(),
  expected: jsonValueSchema.optional(),
  actualSummary: z.string().max(2_048).optional(),
  hint: z.string().max(2_048).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();

export type DiagnosticPhase = z.infer<typeof diagnosticPhaseSchema>;
export type DiagnosticEntity = z.infer<typeof diagnosticEntitySchema>;
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export class ProtocolError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: Diagnostic | readonly Diagnostic[]) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
    super(list.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "ProtocolError";
    this.diagnostics = Object.freeze([...list]);
  }
}

export function createDiagnostic(input: Diagnostic): Diagnostic {
  return diagnosticSchema.parse(input);
}
