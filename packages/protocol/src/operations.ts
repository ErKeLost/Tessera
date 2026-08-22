import { z } from "zod";
import { actionDefinitionSchema } from "./actions";
import { brandedStringSchema, type BrandedString } from "./brand";
import { HASH_DOMAINS } from "./constants";
import {
  actionIdSchema,
  claimIdSchema,
  entityRevisionIdSchema,
  evidenceIdSchema,
  nodeIdSchema,
  operationIdSchema,
  proposalEntityKindSchema,
  proposalLocalIdSchemas,
  resourceBindingIdSchema,
  stateIdSchema,
  transactionIdSchema,
} from "./ids";
import { hashCanonical, sha256HashSchema, type HashProvider } from "./hash";
import {
  canonicalNodeSchema,
  claimBindingSchema,
  evidenceBindingSchema,
  semanticDocumentMetaSchema,
} from "./document";
import { resourceBindingDeclarationSchema } from "./resources";
import { stateDefinitionSchema } from "./state";

export const canonicalEntityRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: nodeIdSchema }).strict(),
  z.object({ kind: z.literal("state"), id: stateIdSchema }).strict(),
  z.object({ kind: z.literal("action"), id: actionIdSchema }).strict(),
  z.object({ kind: z.literal("resource"), id: resourceBindingIdSchema }).strict(),
  z.object({ kind: z.literal("evidence"), id: evidenceIdSchema }).strict(),
  z.object({ kind: z.literal("claim"), id: claimIdSchema }).strict(),
]);

export type ProposalEntityKey = BrandedString<"ProposalEntityKey">;
export const proposalEntityKeySchema = brandedStringSchema<"ProposalEntityKey">(
  z.string()
    .max(160)
    .regex(/^(?:node|state|action|resource|evidence|claim):[A-Za-z0-9][A-Za-z0-9._-]*$/),
);

export const transactionIdentityMapSchema = z.record(proposalEntityKeySchema, canonicalEntityRefSchema)
  .superRefine((identityMap, context) => {
    for (const [key, target] of Object.entries(identityMap)) {
      if (key.slice(0, key.indexOf(":")) !== target.kind) {
        context.addIssue({ code: "custom", path: [key], message: "Identity-map entity kinds must match." });
      }
    }
  });

const identityMapDeltaEntrySchemas = [
  identityMapEntry("node", nodeIdSchema),
  identityMapEntry("state", stateIdSchema),
  identityMapEntry("action", actionIdSchema),
  identityMapEntry("resource", resourceBindingIdSchema),
  identityMapEntry("evidence", evidenceIdSchema),
  identityMapEntry("claim", claimIdSchema),
] as const;

export const transactionIdentityMapDeltaEntrySchema = z.discriminatedUnion("kind", identityMapDeltaEntrySchemas);
export const transactionIdentityMapDeltaSchema = z.array(transactionIdentityMapDeltaEntrySchema).max(10_000)
  .superRefine((entries, context) => {
    const keys = entries.map((entry) => `${entry.kind}:${entry.localId}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "Identity-map delta cannot assign a local entity twice." });
    }
  });

function identityMapEntry<TKind extends z.infer<typeof proposalEntityKindSchema>, TSchema extends z.ZodType>(
  kind: TKind,
  canonicalIdSchema: TSchema,
) {
  return z.object({
    kind: z.literal(kind),
    localId: proposalLocalIdSchemas[kind],
    canonicalId: canonicalIdSchema,
  }).strict();
}

export const canonicalEntityOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("put-node"), nodeId: nodeIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: canonicalNodeSchema }).strict(),
  z.object({ op: z.literal("remove-node"), nodeId: nodeIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("put-state"), stateId: stateIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: stateDefinitionSchema }).strict(),
  z.object({ op: z.literal("remove-state"), stateId: stateIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("put-action"), actionId: actionIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: actionDefinitionSchema }).strict(),
  z.object({ op: z.literal("remove-action"), actionId: actionIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("put-resource-binding"), bindingId: resourceBindingIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: resourceBindingDeclarationSchema }).strict(),
  z.object({ op: z.literal("remove-resource-binding"), bindingId: resourceBindingIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("put-evidence"), evidenceId: evidenceIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: evidenceBindingSchema }).strict(),
  z.object({ op: z.literal("remove-evidence"), evidenceId: evidenceIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("put-claim"), claimId: claimIdSchema, expectedEntityRevision: entityRevisionIdSchema.optional(), value: claimBindingSchema }).strict(),
  z.object({ op: z.literal("remove-claim"), claimId: claimIdSchema, expectedEntityRevision: entityRevisionIdSchema }).strict(),
  z.object({ op: z.literal("set-root"), nodeId: nodeIdSchema, expectedRootId: nodeIdSchema.optional() }).strict(),
  z.object({ op: z.literal("set-meta"), expectedMetaHash: sha256HashSchema.optional(), value: semanticDocumentMetaSchema }).strict(),
]);

export const canonicalOperationEnvelopeSchema = z.object({
  transactionId: transactionIdSchema,
  operationId: operationIdSchema,
  sequence: z.number().int().positive(),
  dependsOn: z.array(operationIdSchema).max(64),
  payloadHash: sha256HashSchema,
  operation: canonicalEntityOperationSchema,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.dependsOn).size !== envelope.dependsOn.length) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "Operation dependencies must be unique." });
  }
  if (envelope.dependsOn.includes(envelope.operationId)) {
    context.addIssue({ code: "custom", path: ["dependsOn"], message: "Operation cannot depend on itself." });
  }
});

export type CanonicalEntityRef = z.infer<typeof canonicalEntityRefSchema>;
export type TransactionIdentityMap = z.infer<typeof transactionIdentityMapSchema>;
export type TransactionIdentityMapDeltaEntry = z.infer<typeof transactionIdentityMapDeltaEntrySchema>;
export type TransactionIdentityMapDelta = z.infer<typeof transactionIdentityMapDeltaSchema>;
export type CanonicalEntityOperation = z.infer<typeof canonicalEntityOperationSchema>;
export type CanonicalOperationEnvelope = z.infer<typeof canonicalOperationEnvelopeSchema>;

export function toProposalEntityKey(
  kind: z.infer<typeof proposalEntityKindSchema>,
  localId: string,
): ProposalEntityKey {
  return proposalEntityKeySchema.parse(`${kind}:${localId}`);
}

export async function verifyCanonicalOperationEnvelope(
  input: CanonicalOperationEnvelope,
  provider?: HashProvider,
): Promise<boolean> {
  const envelope = canonicalOperationEnvelopeSchema.parse(input);
  return await hashCanonical(HASH_DOMAINS.operationPayload, envelope.operation, provider) === envelope.payloadHash;
}
