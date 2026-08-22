import {
  actionContractRefSchema,
  compensationPolicyRefSchema,
  contractRefSchema,
  eventPortSchema,
  HASH_DOMAINS,
  jsonPointerSchema,
  jsonSchemaSchema,
  resourceSchemaIdSchema,
  sha256HashSchema,
  type ActionContractRef,
  type ContractRef,
  type HashProvider,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  addCanonicalSetIssues,
  addSortedUniqueStringIssues,
  assertHash,
  canonicalSet,
  computeHash,
  deepFreeze,
  sortedUniqueStrings,
} from "./internal";

const extensionTokenSchema = z.string()
  .min(3)
  .max(192)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/);

const customToken = (prefix: string) => z.string()
  .min(prefix.length + 3)
  .max(192)
  .regex(new RegExp(`^${prefix}:[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)*$`));

const nonEmptyTextSchema = z.string().trim().min(1).max(4_096);
const shortTokenSchema = z.string().min(1).max(128).regex(/^[a-z][a-zA-Z0-9.-]*$/);
const slotNameSchema = z.string().min(1).max(128).regex(/^[a-z][a-zA-Z0-9]*$/);
const mimeTypeSchema = z.string().min(3).max(192).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);

export const componentCategorySchema = z.union([
  z.enum(["layout", "content", "control", "data"]),
  customToken("extension"),
]);

export const bindingSourceSchema = z.enum(["literal", "state", "resource", "context"]);
export const bindingReadinessSchema = z.enum(["required", "optional", "deferred"]);
export const unresolvedFallbackSchema = z.enum(["omit", "loading", "empty", "error"]);
export const stateScopeSchema = z.enum(["surface", "document", "external"]);
export const sensitivitySchema = z.enum(["public", "internal", "confidential", "restricted"]);
export const resourceKindSchema = z.union([
  z.enum(["dataset", "record", "document", "asset"]),
  customToken("custom"),
]);

export const resourceSchemaConstraintSchema = z.object({
  schemaId: resourceSchemaIdSchema.optional(),
  schemaHash: sha256HashSchema,
  resolvedSchema: jsonSchemaSchema,
}).strict();

export const resourceSelectorPolicySchema = z.object({
  allowProjection: z.boolean(),
  maxProjectedColumns: z.number().int().positive().max(1_024),
  allowFilterState: z.boolean(),
  allowSort: z.boolean(),
  maxSortKeys: z.number().int().nonnegative().max(64),
  maxWindowItems: z.number().int().positive().max(100_000),
}).strict().superRefine((policy, context) => {
  if (!policy.allowSort && policy.maxSortKeys !== 0) {
    context.addIssue({
      code: "custom",
      message: "maxSortKeys must be zero when sorting is disabled.",
      path: ["maxSortKeys"],
    });
  }
});

const stateBindingPolicySchema = z.object({
  schema: jsonSchemaSchema,
  readableScopes: z.array(stateScopeSchema).min(1).max(3),
}).strict().superRefine((value, context) => {
  addSortedUniqueStringIssues(value.readableScopes, context, "readableScopes");
});

const resourceBindingPolicySchema = z.object({
  kinds: z.array(resourceKindSchema).min(1).max(64),
  schemaConstraints: z.array(resourceSchemaConstraintSchema).min(1).max(64),
  selector: resourceSelectorPolicySchema,
  maxSensitivity: sensitivitySchema,
}).strict().superRefine((value, context) => {
  addSortedUniqueStringIssues(value.kinds, context, "kinds");
  addCanonicalSetIssues(value.schemaConstraints, context, "schemaConstraints");
});

export const bindingPolicySchema = z.object({
  allowedSources: z.array(bindingSourceSchema).min(1).max(4),
  canonicalExprSchema: jsonSchemaSchema,
  resolvedValueSchema: jsonSchemaSchema,
  nullable: z.boolean(),
  readiness: bindingReadinessSchema,
  unresolvedFallback: unresolvedFallbackSchema,
  state: stateBindingPolicySchema.optional(),
  resource: resourceBindingPolicySchema.optional(),
}).strict().superRefine((policy, context) => {
  addSortedUniqueStringIssues(policy.allowedSources, context, "allowedSources");
  const stateAllowed = policy.allowedSources.includes("state");
  const resourceAllowed = policy.allowedSources.includes("resource");
  if (stateAllowed !== (policy.state !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A state policy is required exactly when state is an allowed source.",
      path: ["state"],
    });
  }
  if (resourceAllowed !== (policy.resource !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A resource policy is required exactly when resource is an allowed source.",
      path: ["resource"],
    });
  }
});

export const componentSelectorSchema = z.object({
  kind: z.literal("contract"),
  contract: contractRefSchema,
}).strict();

export const slotContractSchema = z.object({
  accepts: z.array(componentSelectorSchema).min(1).max(512),
  min: z.number().int().nonnegative().max(10_000),
  max: z.number().int().positive().max(10_000),
  fallback: z.enum(["omit", "empty", "placeholder"]),
}).strict().superRefine((slot, context) => {
  if (slot.max < slot.min) {
    context.addIssue({ code: "custom", message: "Slot max must be greater than or equal to min.", path: ["max"] });
  }
  addCanonicalSetIssues(slot.accepts, context, "accepts");
});

export const componentEventContractSchema = z.object({
  payloadSchema: jsonSchemaSchema,
  actionContracts: z.array(actionContractRefSchema).max(256),
}).strict().superRefine((event, context) => {
  addCanonicalSetIssues(event.actionContracts, context, "actionContracts");
});

export const readinessContractSchema = z.object({
  strategy: z.enum(["all-required", "first-meaningful"]),
  requiredBindings: z.array(jsonPointerSchema).max(512),
  pendingFallback: z.enum(["loading", "omit", "placeholder"]),
  failureFallback: z.enum(["error", "empty", "omit"]),
}).strict().superRefine((readiness, context) => {
  addSortedUniqueStringIssues(readiness.requiredBindings, context, "requiredBindings");
});

export const placementKindSchema = z.union([
  z.enum(["inline", "panel", "sheet", "dialog", "fullscreen"]),
  customToken("custom"),
]);

export const placementConstraintSchema = z.object({
  kind: placementKindSchema,
  minWidth: z.number().int().nonnegative().max(100_000).optional(),
  maxWidth: z.number().int().positive().max(100_000).optional(),
  minHeight: z.number().int().nonnegative().max(100_000).optional(),
  maxHeight: z.number().int().positive().max(100_000).optional(),
}).strict().superRefine((placement, context) => {
  if (placement.minWidth !== undefined && placement.maxWidth !== undefined && placement.minWidth > placement.maxWidth) {
    context.addIssue({ code: "custom", message: "minWidth must not exceed maxWidth.", path: ["minWidth"] });
  }
  if (placement.minHeight !== undefined && placement.maxHeight !== undefined && placement.minHeight > placement.maxHeight) {
    context.addIssue({ code: "custom", message: "minHeight must not exceed maxHeight.", path: ["minHeight"] });
  }
});

export const accessibleTextSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prop"), path: jsonPointerSchema }).strict(),
  z.object({ kind: z.literal("host"), key: z.enum(["component-label", "surface-label"]) }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

export const accessibilityContractSchema = z.object({
  semanticRole: z.enum(["generic", "group", "region", "status", "table", "img", "form"]),
  accessibleName: accessibleTextSourceSchema,
  description: accessibleTextSourceSchema.optional(),
  keyboardInteractions: z.array(z.enum(["activate", "navigate", "select", "edit", "dismiss"])).max(5),
  liveRegion: z.enum(["off", "polite", "assertive"]),
  equivalentView: z.enum(["none", "table", "text-summary", "host-required"]),
}).strict().superRefine((accessibility, context) => {
  addSortedUniqueStringIssues(accessibility.keyboardInteractions, context, "keyboardInteractions");
});

export const assetPolicySchema = z.object({
  allowedMimeTypes: z.array(mimeTypeSchema).min(1).max(128),
  maxBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  requireIntegrity: z.boolean(),
  allowAnimation: z.boolean(),
}).strict().superRefine((policy, context) => {
  addSortedUniqueStringIssues(policy.allowedMimeTypes, context, "allowedMimeTypes");
});

export const exampleRefSchema = z.object({
  exampleId: shortTokenSchema,
  contentHash: sha256HashSchema,
}).strict();

export const migrationRefSchema = z.object({
  fromRevision: z.number().int().positive(),
  toRevision: z.number().int().positive(),
  migrationHash: sha256HashSchema,
}).strict().superRefine((migration, context) => {
  if (migration.fromRevision >= migration.toRevision) {
    context.addIssue({ code: "custom", message: "Migration revisions must increase.", path: ["toRevision"] });
  }
});

const promptMetadataSchema = z.object({
  summary: nonEmptyTextSchema,
  useWhen: z.array(nonEmptyTextSchema).min(1).max(64),
  avoidWhen: z.array(nonEmptyTextSchema).max(64),
  examples: z.array(exampleRefSchema).max(128),
}).strict().superRefine((prompt, context) => {
  addSortedUniqueStringIssues(prompt.useWhen, context, "useWhen");
  addSortedUniqueStringIssues(prompt.avoidWhen, context, "avoidWhen");
  addCanonicalSetIssues(prompt.examples, context, "examples");
});

const contractIdentitySchema = contractRefSchema.omit({ contractHash: true });
const authoringBindingsSchema = z.record(jsonPointerSchema, bindingPolicySchema);
const slotsSchema = z.record(slotNameSchema, slotContractSchema);
const eventsSchema = z.record(eventPortSchema, componentEventContractSchema);

const componentContractBodyShape = {
  category: componentCategorySchema,
  resolvedPropsSchema: jsonSchemaSchema,
  authoringBindings: authoringBindingsSchema,
  slots: slotsSchema,
  events: eventsSchema,
  trust: z.enum(["safe", "governed"]),
  commitPolicy: z.enum(["progressive", "atomic"]),
  readiness: readinessContractSchema,
  placements: z.array(placementConstraintSchema).min(1).max(64),
  accessibility: accessibilityContractSchema,
  assets: assetPolicySchema.optional(),
  prompt: promptMetadataSchema,
  migrations: z.array(migrationRefSchema).max(256),
} as const;

function refineComponentContract(
  contract: {
    ref: { revision: number };
    authoringBindings: Record<string, unknown>;
    readiness: { requiredBindings: readonly string[] };
    placements: readonly unknown[];
    migrations: readonly { fromRevision: number; toRevision: number; migrationHash: string }[];
  },
  context: z.RefinementCtx,
): void {
  for (const path of contract.readiness.requiredBindings) {
    if (!(path in contract.authoringBindings)) {
      context.addIssue({
        code: "custom",
        message: "Every required readiness binding must have a BindingPolicy.",
        path: ["readiness", "requiredBindings"],
      });
    }
  }
  addCanonicalSetIssues(contract.placements, context, "placements");
  addCanonicalSetIssues(contract.migrations, context, "migrations");
  for (const [index, migration] of contract.migrations.entries()) {
    if (migration.toRevision > contract.ref.revision) {
      context.addIssue({
        code: "custom",
        message: "Migration target cannot exceed the contract revision.",
        path: ["migrations", index, "toRevision"],
      });
    }
  }
}

export const componentContractDefinitionSchema = z.object({
  ref: contractIdentitySchema,
  ...componentContractBodyShape,
}).strict().superRefine(refineComponentContract);

export const componentContractSchema = z.object({
  ref: contractRefSchema,
  ...componentContractBodyShape,
}).strict().superRefine(refineComponentContract);

export type ComponentCategory = z.infer<typeof componentCategorySchema>;
export type BindingSource = z.infer<typeof bindingSourceSchema>;
export type StateScope = z.infer<typeof stateScopeSchema>;
export type Sensitivity = z.infer<typeof sensitivitySchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type ResourceSchemaConstraint = z.infer<typeof resourceSchemaConstraintSchema>;
export type ResourceSelectorPolicy = z.infer<typeof resourceSelectorPolicySchema>;
export type BindingPolicy = z.infer<typeof bindingPolicySchema>;
export type ComponentSelector = z.infer<typeof componentSelectorSchema>;
export type SlotContract = z.infer<typeof slotContractSchema>;
export type ComponentEventContract = z.infer<typeof componentEventContractSchema>;
export type ReadinessContract = z.infer<typeof readinessContractSchema>;
export type PlacementKind = z.infer<typeof placementKindSchema>;
export type PlacementConstraint = z.infer<typeof placementConstraintSchema>;
export type AccessibilityContract = z.infer<typeof accessibilityContractSchema>;
export type AssetPolicy = z.infer<typeof assetPolicySchema>;
export type ExampleRef = z.infer<typeof exampleRefSchema>;
export type MigrationRef = z.infer<typeof migrationRefSchema>;
export type ComponentContractDefinition = z.infer<typeof componentContractDefinitionSchema>;
export type ComponentContract = z.infer<typeof componentContractSchema>;

export async function computeComponentContractHash(
  input: ComponentContractDefinition,
  provider?: HashProvider,
) {
  const definition = componentContractDefinitionSchema.parse(input);
  return computeHash(HASH_DOMAINS.componentContract, definition, provider);
}

export async function createComponentContract(
  input: ComponentContractDefinition,
  provider?: HashProvider,
): Promise<ComponentContract> {
  const definition = normalizeComponentContractDefinition(input);
  const contractHash = await computeComponentContractHash(definition, provider);
  return deepFreeze(componentContractSchema.parse({
    ...definition,
    ref: { ...definition.ref, contractHash },
  }));
}

export async function verifyComponentContract(
  input: unknown,
  provider?: HashProvider,
): Promise<ComponentContract> {
  const contract = componentContractSchema.parse(input);
  const definition = componentContractDefinitionSchema.parse({
    ...contract,
    ref: {
      publisher: contract.ref.publisher,
      catalogId: contract.ref.catalogId,
      componentType: contract.ref.componentType,
      revision: contract.ref.revision,
    },
  });
  const expected = await computeComponentContractHash(definition, provider);
  assertHash(contract.ref.contractHash, expected, "catalog.component-contract-hash", "Component contract");
  return deepFreeze(contract);
}

function normalizeComponentContractDefinition(input: ComponentContractDefinition): ComponentContractDefinition {
  return componentContractDefinitionSchema.parse({
    ...input,
    authoringBindings: Object.fromEntries(Object.entries(input.authoringBindings).map(([path, policy]) => [
      path,
      {
        ...policy,
        allowedSources: sortedUniqueStrings(policy.allowedSources),
        ...(policy.state === undefined ? {} : {
          state: {
            ...policy.state,
            readableScopes: sortedUniqueStrings(policy.state.readableScopes),
          },
        }),
        ...(policy.resource === undefined ? {} : {
          resource: {
            ...policy.resource,
            kinds: sortedUniqueStrings(policy.resource.kinds),
            schemaConstraints: canonicalSet(policy.resource.schemaConstraints),
          },
        }),
      },
    ])),
    slots: Object.fromEntries(Object.entries(input.slots).map(([name, slot]) => [
      name,
      { ...slot, accepts: canonicalSet(slot.accepts) },
    ])),
    events: Object.fromEntries(Object.entries(input.events).map(([name, event]) => [
      name,
      { ...event, actionContracts: canonicalSet(event.actionContracts) },
    ])),
    readiness: {
      ...input.readiness,
      requiredBindings: sortedUniqueStrings(input.readiness.requiredBindings),
    },
    placements: canonicalSet(input.placements),
    accessibility: {
      ...input.accessibility,
      keyboardInteractions: sortedUniqueStrings(input.accessibility.keyboardInteractions),
    },
    ...(input.assets === undefined ? {} : {
      assets: {
        ...input.assets,
        allowedMimeTypes: sortedUniqueStrings(input.assets.allowedMimeTypes),
      },
    }),
    migrations: canonicalSet(input.migrations),
    prompt: {
      ...input.prompt,
      useWhen: sortedUniqueStrings(input.prompt.useWhen),
      avoidWhen: sortedUniqueStrings(input.prompt.avoidWhen),
      examples: canonicalSet(input.prompt.examples),
    },
  });
}

export const actionEffectClassSchema = z.enum(["none", "read", "reversible-write", "irreversible-write"]);
export const actionRiskSchema = z.enum(["low", "medium", "high"]);

export const actionReadDeclarationSchema = z.object({
  source: z.enum(["state", "resource"]),
  path: jsonPointerSchema.optional(),
  required: z.boolean(),
}).strict();

export const actionWriteDeclarationSchema = z.object({
  target: z.enum(["state", "resource", "document"]),
  operation: shortTokenSchema,
}).strict();

export const idempotencyScopeSchema = z.enum(["actor", "surface", "document", "tenant"]);
export const cancellableBoundarySchema = z.enum(["before-dispatch", "before-effect", "never"]);
export const timeoutPolicySchema = z.object({
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1_000),
}).strict();
export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(16),
  backoff: z.enum(["none", "fixed", "exponential"]),
  initialDelayMs: z.number().int().nonnegative().max(60 * 60 * 1_000),
}).strict().superRefine((policy, context) => {
  if (policy.backoff === "none" && policy.initialDelayMs !== 0) {
    context.addIssue({ code: "custom", message: "No-backoff retries must use a zero delay.", path: ["initialDelayMs"] });
  }
});

const actionContractIdentitySchema = actionContractRefSchema.omit({ contractHash: true });
const actionContractBodyShape = {
  normalizedInputSchema: jsonSchemaSchema,
  resultSchema: jsonSchemaSchema,
  receiptSchema: jsonSchemaSchema,
  reads: z.array(actionReadDeclarationSchema).max(256),
  writes: z.array(actionWriteDeclarationSchema).max(256),
  effectClass: actionEffectClassSchema,
  risk: actionRiskSchema,
  approvalPolicyRef: extensionTokenSchema.optional(),
  idempotencyScope: idempotencyScopeSchema,
  cancellableUntil: cancellableBoundarySchema,
  timeoutPolicy: timeoutPolicySchema,
  retryPolicy: retryPolicySchema,
  compensationPolicy: compensationPolicyRefSchema.optional(),
} as const;

function refineActionContract(
  contract: {
    effectClass: string;
    risk: string;
    reads: readonly unknown[];
    writes: readonly unknown[];
    compensationPolicy?: string;
  },
  context: z.RefinementCtx,
): void {
  addCanonicalSetIssues(contract.reads, context, "reads");
  addCanonicalSetIssues(contract.writes, context, "writes");
  if (contract.effectClass === "irreversible-write" && contract.risk === "low") {
    context.addIssue({ code: "custom", message: "Irreversible effects cannot be low risk.", path: ["risk"] });
  }
  if (contract.compensationPolicy !== undefined && contract.effectClass !== "reversible-write") {
    context.addIssue({
      code: "custom",
      message: "A compensation policy is only valid for reversible writes.",
      path: ["compensationPolicy"],
    });
  }
}

export const actionContractDefinitionSchema = z.object({
  ref: actionContractIdentitySchema,
  ...actionContractBodyShape,
}).strict().superRefine(refineActionContract);

export const actionContractSchema = z.object({
  ref: actionContractRefSchema,
  ...actionContractBodyShape,
}).strict().superRefine(refineActionContract);

export type ActionContractDefinition = z.infer<typeof actionContractDefinitionSchema>;
export type ActionContract = z.infer<typeof actionContractSchema>;
export type ActionReadDeclaration = z.infer<typeof actionReadDeclarationSchema>;
export type ActionWriteDeclaration = z.infer<typeof actionWriteDeclarationSchema>;

export async function computeActionContractHash(input: ActionContractDefinition, provider?: HashProvider) {
  const definition = actionContractDefinitionSchema.parse(input);
  return computeHash(HASH_DOMAINS.actionContract, definition, provider);
}

export async function createActionContract(
  input: ActionContractDefinition,
  provider?: HashProvider,
): Promise<ActionContract> {
  const definition = actionContractDefinitionSchema.parse({
    ...input,
    reads: canonicalSet(input.reads),
    writes: canonicalSet(input.writes),
  });
  const contractHash = await computeActionContractHash(definition, provider);
  return deepFreeze(actionContractSchema.parse({ ...definition, ref: { ...definition.ref, contractHash } }));
}

export async function verifyActionContract(input: unknown, provider?: HashProvider): Promise<ActionContract> {
  const contract = actionContractSchema.parse(input);
  const definition = actionContractDefinitionSchema.parse({
    ...contract,
    ref: {
      publisher: contract.ref.publisher,
      catalogId: contract.ref.catalogId,
      actionType: contract.ref.actionType,
      revision: contract.ref.revision,
    },
  });
  const expected = await computeActionContractHash(definition, provider);
  assertHash(contract.ref.contractHash, expected, "catalog.action-contract-hash", "Action contract");
  return deepFreeze(contract);
}

export function sameContractRef(left: ContractRef, right: ContractRef): boolean {
  return contractRefKey(left) === contractRefKey(right);
}

export function sameActionContractRef(left: ActionContractRef, right: ActionContractRef): boolean {
  return actionContractRefKey(left) === actionContractRefKey(right);
}

export function contractRefKey(ref: ContractRef): string {
  return `${ref.publisher}/${ref.catalogId}/${ref.componentType}@${ref.revision}#${ref.contractHash}`;
}

export function actionContractRefKey(ref: ActionContractRef): string {
  return `${ref.publisher}/${ref.catalogId}/${ref.actionType}@${ref.revision}#${ref.contractHash}`;
}
