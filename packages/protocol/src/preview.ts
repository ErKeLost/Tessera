import { z } from "zod";
import {
  actionIdSchema,
  nodeIdSchema,
  revisionIdSchema,
  surfaceSessionIdSchema,
  transactionIdSchema,
} from "./ids";
import { sha256HashSchema } from "./hash";
import { canonicalEntityOperationSchema, transactionIdentityMapDeltaSchema } from "./operations";

export const validatedPreviewSchema = z.object({
  surfaceSessionId: surfaceSessionIdSchema,
  transactionId: transactionIdSchema,
  baseRevisionId: revisionIdSchema,
  overlaySequence: z.number().int().positive(),
  previousOverlayHash: sha256HashSchema.optional(),
  overlayHash: sha256HashSchema,
  identityMapDelta: transactionIdentityMapDeltaSchema,
  operations: z.array(canonicalEntityOperationSchema).min(1).max(10_000),
  renderableNodeIds: z.array(nodeIdSchema).max(1_000),
  disabledActionIds: z.array(actionIdSchema).max(256),
}).strict();

export type ValidatedPreview = z.infer<typeof validatedPreviewSchema>;
