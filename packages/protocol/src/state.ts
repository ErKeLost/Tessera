import { z } from "zod";
import {
  documentIdSchema,
  requestIdSchema,
  revisionIdSchema,
  stateIdSchema,
  stateRevisionIdSchema,
  surfaceSessionIdSchema,
} from "./ids";
import { sha256HashSchema } from "./hash";
import { isoTimestampSchema, jsonSchemaSchema, jsonValueSchema } from "./json";
import { modelVisibilitySchema, retentionPolicySchema, sensitivitySchema } from "./policy";

const stateDefinitionBaseSchema = z.object({
  schema: jsonSchemaSchema,
  schemaHash: sha256HashSchema,
  initial: jsonValueSchema,
  sensitivity: sensitivitySchema,
  modelVisibility: modelVisibilitySchema,
  retention: retentionPolicySchema,
}).strict();

export const stateDefinitionSchema = z.discriminatedUnion("scope", [
  stateDefinitionBaseSchema.extend({
    scope: z.literal("surface"),
    persistence: z.enum(["none", "session"]),
  }).strict(),
  stateDefinitionBaseSchema.extend({
    scope: z.literal("document"),
    persistence: z.literal("host"),
  }).strict(),
]);

export const stateValueSnapshotSchema = z.object({
  stateId: stateIdSchema,
  stateRevisionId: stateRevisionIdSchema,
  schemaHash: sha256HashSchema,
  scope: z.enum(["surface", "document"]),
  value: jsonValueSchema,
}).strict();

export const stateWriteRequestSchema = z.object({
  requestId: requestIdSchema,
  surfaceSessionId: surfaceSessionIdSchema,
  documentId: documentIdSchema,
  expectedRevisionId: revisionIdSchema,
  stateId: stateIdSchema,
  expectedStateRevisionId: stateRevisionIdSchema,
  value: jsonValueSchema,
}).strict();

export const stateWriteReceiptSchema = z.object({
  requestId: requestIdSchema,
  stateId: stateIdSchema,
  fromStateRevisionId: stateRevisionIdSchema,
  toStateRevisionId: stateRevisionIdSchema,
  schemaHash: sha256HashSchema,
  valueHash: sha256HashSchema,
  recordedAt: isoTimestampSchema,
}).strict();

export type StateDefinition = z.infer<typeof stateDefinitionSchema>;
export type StateValueSnapshot = z.infer<typeof stateValueSnapshotSchema>;
export type StateWriteRequest = z.infer<typeof stateWriteRequestSchema>;
export type StateWriteReceipt = z.infer<typeof stateWriteReceiptSchema>;
