import {
  authoringActionDefinitionSchema,
  authoringClaimBindingSchema,
  authoringDocumentMetaSchema,
  authoringEvidenceBindingSchema,
  authoringResourceBindingSchema,
  authoringStateDefinitionSchema,
  canonicalStringify,
  proposalLocalIdSchemas,
  type JSONSchema,
} from "@open-generative/protocol";
import type { BindingPolicy, ComponentContract } from "@open-generative/catalog";
import { z } from "zod";
import { cloneCanonical, deepFreeze } from "./internal";
import type {
  CompilerCatalogLike,
  ProviderSchemaLoweringProfile,
} from "./types";

type SchemaObject = Record<string, unknown>;

const ENTITY_KINDS = ["node", "state", "action", "resource", "evidence", "claim"] as const;

function zodJsonSchema(schema: z.ZodType): JSONSchema {
  const output = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "inline",
    io: "input",
  });
  return stripZodSchemaMetadata(output) as JSONSchema;
}

function stripZodSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripZodSchemaMetadata);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "~standard")
    .map(([key, nested]) => [key, stripZodSchemaMetadata(nested)]));
}

function strictObject(
  properties: Record<string, JSONSchema>,
  required: readonly string[] = Object.keys(properties),
): JSONSchema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  } as JSONSchema;
}

function entityRefSchema(kind: (typeof ENTITY_KINDS)[number]): JSONSchema {
  const canonicalKey = kind === "resource" ? "bindingId" : `${kind}Id`;
  return {
    oneOf: [
      strictObject({
        kind: { const: kind } as JSONSchema,
        localId: zodJsonSchema(proposalLocalIdSchemas[kind]),
      }),
      strictObject({
        kind: { const: kind } as JSONSchema,
        canonicalId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: `Existing ${canonicalKey} granted by the turn write scope.`,
        } as JSONSchema,
      }),
    ],
  } as JSONSchema;
}

function commonDefinitions(): Record<string, JSONSchema> {
  const definitions: Record<string, JSONSchema> = {};
  for (const kind of ENTITY_KINDS) definitions[`Compiler${capitalize(kind)}Ref`] = entityRefSchema(kind);

  const scalar = { type: ["null", "boolean", "string", "number"] } as JSONSchema;
  definitions.CompilerLiteralValue = {
    anyOf: [
      scalar,
      { type: "array", items: { $ref: "#/$defs/CompilerLiteralValue" } },
      strictObject({
        object: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/CompilerLiteralValue" },
        } as JSONSchema,
      }),
    ],
  } as JSONSchema;
  definitions.CompilerAuthoringValue = {
    anyOf: [
      { $ref: "#/$defs/CompilerLiteralValue" },
      {
        type: "array",
        items: { $ref: "#/$defs/CompilerAuthoringValue" },
      } as JSONSchema,
      strictObject({
        object: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/CompilerAuthoringValue" },
        } as JSONSchema,
      }),
      strictObject({
        ref: { const: "state" } as JSONSchema,
        target: { $ref: "#/$defs/CompilerStateRef" } as JSONSchema,
        path: pathSchema(),
      }, ["ref", "target"]),
      strictObject({
        ref: { const: "state-id" } as JSONSchema,
        target: { $ref: "#/$defs/CompilerStateRef" } as JSONSchema,
      }),
      strictObject({
        ref: { const: "resource" } as JSONSchema,
        target: { $ref: "#/$defs/CompilerResourceRef" } as JSONSchema,
        path: pathSchema(),
      }, ["ref", "target"]),
      strictObject({
        ref: { const: "resource-id" } as JSONSchema,
        target: { $ref: "#/$defs/CompilerResourceRef" } as JSONSchema,
      }),
      strictObject({
        ref: { const: "event" } as JSONSchema,
        port: { type: "string", pattern: "^[a-z][a-zA-Z0-9]*$" } as JSONSchema,
        path: pathSchema(),
      }, ["ref", "port"]),
      strictObject({
        ref: { const: "context" } as JSONSchema,
        key: { enum: ["locale", "timezone"] } as JSONSchema,
      }),
      strictObject({
        condition: strictObject({
          op: { enum: ["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"] } as JSONSchema,
          args: {
            type: "array",
            maxItems: 16,
            items: { $ref: "#/$defs/CompilerAuthoringValue" },
          } as JSONSchema,
        }),
      }),
    ],
  } as JSONSchema;
  return definitions;
}

function pathSchema(): JSONSchema {
  return {
    type: "array",
    maxItems: 64,
    items: { anyOf: [{ type: "string" }, { type: "integer", minimum: 0 }] },
  } as JSONSchema;
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function refName(kind: string): string {
  return `#/$defs/Compiler${capitalize(kind)}Ref`;
}

function pointerEscape(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function containsBindingAtOrBelow(bindings: Readonly<Record<string, BindingPolicy>>, pointer: string): boolean {
  return Object.keys(bindings).some((candidate) => candidate === pointer || candidate.startsWith(`${pointer}/`));
}

function sourceValueSchema(
  resolvedSchema: JSONSchema,
  policy: BindingPolicy,
): JSONSchema {
  const branches: JSONSchema[] = [];
  if (policy.allowedSources.includes("literal")) branches.push(literalAuthoringSchema(resolvedSchema));
  if (policy.allowedSources.includes("state")) {
    branches.push(strictObject({
      ref: { const: "state" } as JSONSchema,
      target: { $ref: refName("state") } as JSONSchema,
      path: pathSchema(),
    }, ["ref", "target"]));
    branches.push(strictObject({
      ref: { const: "state-id" } as JSONSchema,
      target: { $ref: refName("state") } as JSONSchema,
    }));
  }
  if (policy.allowedSources.includes("resource")) {
    branches.push(strictObject({
      ref: { const: "resource" } as JSONSchema,
      target: { $ref: refName("resource") } as JSONSchema,
      path: pathSchema(),
    }, ["ref", "target"]));
    branches.push(strictObject({
      ref: { const: "resource-id" } as JSONSchema,
      target: { $ref: refName("resource") } as JSONSchema,
    }));
  }
  if (policy.allowedSources.includes("context")) {
    branches.push(strictObject({
      ref: { const: "context" } as JSONSchema,
      key: { enum: ["locale", "timezone"] } as JSONSchema,
    }));
  }
  branches.push(strictObject({
    condition: strictObject({
      op: { enum: ["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"] } as JSONSchema,
      args: {
        type: "array",
        maxItems: 16,
        items: { $ref: "#/$defs/CompilerAuthoringValue" },
      } as JSONSchema,
    }),
  }));
  return branches.length === 1 ? branches[0]! : { oneOf: branches } as JSONSchema;
}

function transformProperty(
  schema: JSONSchema,
  pointer: string,
  bindings: Readonly<Record<string, BindingPolicy>>,
): JSONSchema {
  const exact = bindings[pointer];
  if (exact) return sourceValueSchema(schema, exact);
  if (!containsBindingAtOrBelow(bindings, pointer)) return literalAuthoringSchema(schema);
  if (schema === true || schema === false) return literalAuthoringSchema(schema);
  const object = schema as SchemaObject;
  if (Array.isArray(object.anyOf)) {
    return { oneOf: object.anyOf.map((branch) => transformProperty(branch as JSONSchema, pointer, bindings)) } as JSONSchema;
  }
  if (Array.isArray(object.oneOf)) {
    return { oneOf: object.oneOf.map((branch) => transformProperty(branch as JSONSchema, pointer, bindings)) } as JSONSchema;
  }
  const properties = isRecord(object.properties) ? object.properties : undefined;
  if (properties || object.type === "object") {
    const transformed: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(properties ?? {})) {
      transformed[key] = transformProperty(
        value as JSONSchema,
        `${pointer}/${pointerEscape(key)}`,
        bindings,
      );
    }
    const inner: SchemaObject = {
      ...object,
      type: "object",
      properties: transformed,
      additionalProperties: object.additionalProperties ?? false,
    };
    return strictObject({ object: inner as JSONSchema });
  }
  return literalAuthoringSchema(schema);
}

function literalAuthoringSchema(schema: JSONSchema): JSONSchema {
  if (schema === true) return { $ref: "#/$defs/CompilerLiteralValue" } as JSONSchema;
  if (schema === false) return false;
  const object = schema as SchemaObject;
  if (Array.isArray(object.anyOf)) {
    return { oneOf: object.anyOf.map((branch) => literalAuthoringSchema(branch as JSONSchema)) } as JSONSchema;
  }
  if (Array.isArray(object.oneOf)) {
    return { oneOf: object.oneOf.map((branch) => literalAuthoringSchema(branch as JSONSchema)) } as JSONSchema;
  }
  if (Array.isArray(object.type)) {
    return {
      oneOf: object.type.map((type) => literalAuthoringSchema({ ...object, type } as JSONSchema)),
    } as JSONSchema;
  }
  if (object.type === "object" || isRecord(object.properties)) {
    const properties: Record<string, JSONSchema> = {};
    for (const [key, value] of Object.entries(isRecord(object.properties) ? object.properties : {})) {
      properties[key] = literalAuthoringSchema(value as JSONSchema);
    }
    const inner = {
      ...object,
      type: "object",
      properties,
      additionalProperties: object.additionalProperties === undefined
        ? false
        : object.additionalProperties,
    } as JSONSchema;
    return strictObject({ object: inner });
  }
  if (object.type === "array") {
    return {
      ...object,
      items: object.items === undefined ? { $ref: "#/$defs/CompilerLiteralValue" } : literalAuthoringSchema(object.items as JSONSchema),
    } as JSONSchema;
  }
  return cloneCanonical(schema);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createAuthoringPropsSchema(contract: ComponentContract): JSONSchema {
  const resolved = contract.resolvedPropsSchema;
  if (resolved === false) return false;
  if (resolved === true) {
    return {
      type: "object",
      additionalProperties: { $ref: "#/$defs/CompilerAuthoringValue" },
      $defs: commonDefinitions(),
    } as JSONSchema;
  }
  const root = resolved as SchemaObject;
  const properties = isRecord(root.properties) ? root.properties : {};
  const transformed: Record<string, JSONSchema> = {};
  for (const [key, schema] of Object.entries(properties)) {
    transformed[key] = transformProperty(
      schema as JSONSchema,
      `/${pointerEscape(key)}`,
      contract.authoringBindings,
    );
  }
  return deepFreeze({
    ...root,
    type: "object",
    properties: transformed,
    additionalProperties: root.additionalProperties ?? false,
    $defs: {
      ...(isRecord(root.$defs) ? root.$defs : {}),
      ...commonDefinitions(),
    },
  } as unknown as JSONSchema);
}

function snapshotNodeBranch(contract: ComponentContract, sliceId: string, props: JSONSchema): JSONSchema {
  const slotProperties: Record<string, JSONSchema> = {};
  for (const [name, slot] of Object.entries(contract.slots)) {
    slotProperties[name] = {
      type: "array",
      minItems: slot.min,
      maxItems: slot.max,
      items: {
        oneOf: [
          { $ref: "#/$defs/CompilerSnapshotNode" },
          { $ref: refName("node") },
        ],
      },
    } as JSONSchema;
  }
  const eventProperties = Object.fromEntries(Object.keys(contract.events).map((port) => [
    port,
    { $ref: refName("action") } as JSONSchema,
  ]));
  return strictObject({
    localId: zodJsonSchema(proposalLocalIdSchemas.node),
    component: { const: sliceId } as JSONSchema,
    props,
    slots: {
      type: "object",
      properties: slotProperties,
      additionalProperties: false,
    } as JSONSchema,
    events: {
      type: "object",
      properties: eventProperties,
      additionalProperties: false,
    } as JSONSchema,
    evidence: {
      type: "array",
      items: { $ref: refName("evidence") },
      uniqueItems: true,
    } as JSONSchema,
  }, ["localId", "component"]);
}

function operationNodeBranch(contract: ComponentContract, sliceId: string, props: JSONSchema): JSONSchema {
  const slotProperties = Object.fromEntries(Object.entries(contract.slots).map(([name, slot]) => [
    name,
    {
      type: "array",
      minItems: slot.min,
      maxItems: slot.max,
      items: { $ref: refName("node") },
    } as JSONSchema,
  ]));
  const eventProperties = Object.fromEntries(Object.keys(contract.events).map((port) => [
    port,
    { $ref: refName("action") } as JSONSchema,
  ]));
  return strictObject({
    component: { const: sliceId } as JSONSchema,
    props,
    slots: { type: "object", properties: slotProperties, additionalProperties: false } as JSONSchema,
    events: { type: "object", properties: eventProperties, additionalProperties: false } as JSONSchema,
    evidence: { type: "array", items: { $ref: refName("evidence") }, uniqueItems: true } as JSONSchema,
  }, ["component"]);
}

function putTarget(kind: string): JSONSchema {
  return {
    oneOf: [
      strictObject({
        kind: { const: kind } as JSONSchema,
        localId: zodJsonSchema(proposalLocalIdSchemas[kind as keyof typeof proposalLocalIdSchemas]),
      }),
      strictObject({
        kind: { const: kind } as JSONSchema,
        canonicalId: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
        expectedEntityRevision: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
      }),
    ],
  } as unknown as JSONSchema;
}

function updateTarget(kind: string): JSONSchema {
  return strictObject({
    kind: { const: kind } as JSONSchema,
    canonicalId: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
    expectedEntityRevision: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
  });
}

type EmbeddedAuthoringSchemas = Readonly<{
  state: JSONSchema;
  action: JSONSchema;
  resource: JSONSchema;
  evidence: JSONSchema;
  claim: JSONSchema;
  meta: JSONSchema;
}>;

function operationVariants(operationNode: JSONSchema, schemas: EmbeddedAuthoringSchemas): JSONSchema[] {
  const put = (op: string, kind: string, value: JSONSchema) => strictObject({
    op: { const: op } as JSONSchema,
    target: putTarget(kind),
    value,
  });
  const remove = (op: string, kind: string) => strictObject({
    op: { const: op } as JSONSchema,
    target: updateTarget(kind),
  });
  return [
    put("put-node", "node", operationNode),
    remove("remove-node", "node"),
    put("put-state", "state", schemas.state),
    remove("remove-state", "state"),
    put("put-action", "action", schemas.action),
    remove("remove-action", "action"),
    put("put-resource-binding", "resource", schemas.resource),
    remove("remove-resource-binding", "resource"),
    put("put-evidence", "evidence", schemas.evidence),
    remove("remove-evidence", "evidence"),
    put("put-claim", "claim", schemas.claim),
    remove("remove-claim", "claim"),
    strictObject({
      op: { const: "set-root" } as JSONSchema,
      node: { $ref: refName("node") } as JSONSchema,
      expectedRootId: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
    }, ["op", "node"]),
    strictObject({
      op: { const: "set-meta" } as JSONSchema,
      expectedMetaHash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } as JSONSchema,
      value: schemas.meta,
    }, ["op", "value"]),
  ];
}

export function createCanonicalPresentUiSchema(catalog: CompilerCatalogLike): JSONSchema {
  const definitions = commonDefinitions();
  const snapshotBranches: JSONSchema[] = [];
  const operationBranches: JSONSchema[] = [];
  for (const [index, entry] of catalog.slice.components.entries()) {
    const contract = catalog.componentBySliceId(entry.sliceComponentId);
    if (!contract) throw new TypeError(`Missing exact component contract for ${entry.sliceComponentId}.`);
    const props = hoistLocalDefinitions(
      catalog.authoringPropsSchema(contract.ref),
      definitions,
      `Component${index + 1}`,
    );
    snapshotBranches.push(snapshotNodeBranch(contract, entry.sliceComponentId, props));
    operationBranches.push(operationNodeBranch(contract, entry.sliceComponentId, props));
  }
  definitions.CompilerSnapshotNode = { oneOf: snapshotBranches } as JSONSchema;
  definitions.CompilerOperationNode = { oneOf: operationBranches } as JSONSchema;

  const schemas: EmbeddedAuthoringSchemas = {
    state: hoistLocalDefinitions(zodJsonSchema(authoringStateDefinitionSchema), definitions, "AuthoringState"),
    action: hoistLocalDefinitions(zodJsonSchema(authoringActionDefinitionSchema), definitions, "AuthoringAction"),
    resource: hoistLocalDefinitions(zodJsonSchema(authoringResourceBindingSchema), definitions, "AuthoringResource"),
    evidence: hoistLocalDefinitions(zodJsonSchema(authoringEvidenceBindingSchema), definitions, "AuthoringEvidence"),
    claim: hoistLocalDefinitions(zodJsonSchema(authoringClaimBindingSchema), definitions, "AuthoringClaim"),
    meta: hoistLocalDefinitions(zodJsonSchema(authoringDocumentMetaSchema), definitions, "AuthoringMeta"),
  };

  const snapshotEntity = (kind: keyof typeof proposalLocalIdSchemas, value: JSONSchema) => strictObject({
    localId: zodJsonSchema(proposalLocalIdSchemas[kind]),
    value,
  });
  const snapshot = strictObject({
    kind: { const: "snapshot" } as JSONSchema,
    root: { $ref: "#/$defs/CompilerSnapshotNode" } as JSONSchema,
    stateDefinitions: { type: "array", items: snapshotEntity("state", schemas.state) } as JSONSchema,
    actions: { type: "array", items: snapshotEntity("action", schemas.action) } as JSONSchema,
    resourceBindings: { type: "array", items: snapshotEntity("resource", schemas.resource) } as JSONSchema,
    evidenceBindings: { type: "array", items: snapshotEntity("evidence", schemas.evidence) } as JSONSchema,
    claims: { type: "array", items: snapshotEntity("claim", schemas.claim) } as JSONSchema,
    meta: schemas.meta,
  }, ["kind", "root", "meta"]);

  const operation = { oneOf: operationVariants({ $ref: "#/$defs/CompilerOperationNode" } as JSONSchema, schemas) } as JSONSchema;
  const operationEnvelope = strictObject({
    operationId: { type: "string", minLength: 1, maxLength: 256 } as JSONSchema,
    sequence: { type: "integer", minimum: 1 } as JSONSchema,
    dependsOn: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string" } } as JSONSchema,
    operation,
  });
  const operations = strictObject({
    kind: { const: "operations" } as JSONSchema,
    operations: {
      type: "array",
      minItems: 1,
      maxItems: catalog.slice.limits.maxOperations,
      items: operationEnvelope,
    } as JSONSchema,
  });

  return deepFreeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "present_ui",
    oneOf: [snapshot, operations],
    $defs: definitions,
  } as JSONSchema);
}

function hoistLocalDefinitions(
  schema: JSONSchema,
  rootDefinitions: Record<string, JSONSchema>,
  namespace: string,
): JSONSchema {
  if (typeof schema === "boolean") return schema;
  const clone = cloneCanonical(schema) as SchemaObject;
  const localDefinitions = isRecord(clone.$defs) ? clone.$defs : {};
  const names = new Map(Object.keys(localDefinitions).map((name) => [name, `${namespace}_${name}`]));
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      if (key === "$ref" && typeof nested === "string" && nested.startsWith("#/$defs/")) {
        const localName = nested.slice("#/$defs/".length);
        return [key, names.has(localName) ? `#/$defs/${names.get(localName)!}` : nested];
      }
      return [key, rewrite(nested)];
    }));
  };
  for (const [name, definition] of Object.entries(localDefinitions)) {
    rootDefinitions[names.get(name)!] = rewrite(definition) as JSONSchema;
  }
  delete clone.$defs;
  delete clone.$schema;
  return rewrite(clone) as JSONSchema;
}

function transformSchema(
  schema: JSONSchema,
  options: { constToEnum?: boolean; removeKeywords?: ReadonlySet<string> },
): JSONSchema {
  if (typeof schema === "boolean") return schema;
  const output: SchemaObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (options.removeKeywords?.has(key)) continue;
    if (key === "const" && options.constToEnum) {
      output.enum = [cloneCanonical(value)];
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.map((item) => isRecord(item)
        ? transformSchema(item as JSONSchema, options)
        : cloneCanonical(item));
    } else if (isRecord(value)) {
      if (key === "properties" || key === "$defs" || key === "definitions") {
        output[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
          name,
          transformSchema(child as JSONSchema, options),
        ]));
      } else {
        output[key] = transformSchema(value as JSONSchema, options);
      }
    } else {
      output[key] = value;
    }
  }
  return output as JSONSchema;
}

export const canonicalProviderSchemaProfile: ProviderSchemaLoweringProfile = deepFreeze({
  id: "canonical",
  lower: (schema: JSONSchema) => cloneCanonical(schema),
});

export const openAiStrictProviderSchemaProfile: ProviderSchemaLoweringProfile = deepFreeze({
  id: "openai-strict",
  lower: (schema: JSONSchema) => transformSchema(schema, {
    removeKeywords: new Set(["$schema", "examples", "default"]),
  }),
});

export const anthropicProviderSchemaProfile: ProviderSchemaLoweringProfile = deepFreeze({
  id: "anthropic-json-schema",
  lower: (schema: JSONSchema) => transformSchema(schema, {
    constToEnum: true,
    removeKeywords: new Set(["$schema", "examples"]),
  }),
});

export const googleProviderSchemaProfile: ProviderSchemaLoweringProfile = deepFreeze({
  id: "google-json-schema",
  lower: (schema: JSONSchema) => transformSchema(schema, {
    constToEnum: true,
    removeKeywords: new Set(["$schema", "pattern", "minLength", "maxLength", "uniqueItems"]),
  }),
});

export const providerSchemaProfiles = deepFreeze({
  canonical: canonicalProviderSchemaProfile,
  "json-schema-2020-12": canonicalProviderSchemaProfile,
  "openai-strict": openAiStrictProviderSchemaProfile,
  "anthropic-json-schema": anthropicProviderSchemaProfile,
  "google-json-schema": googleProviderSchemaProfile,
} as const);

export function defineProviderSchemaProfile(input: ProviderSchemaLoweringProfile): ProviderSchemaLoweringProfile {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) throw new TypeError("Provider schema profile ID is invalid.");
  return deepFreeze({ id: input.id, lower: input.lower });
}

export function resolveProviderSchemaProfile(
  id: string,
  override?: ProviderSchemaLoweringProfile,
): ProviderSchemaLoweringProfile {
  if (override) {
    if (override.id !== id) throw new TypeError("Provider schema profile override does not match the frozen Slice.");
    return override;
  }
  const known = providerSchemaProfiles[id as keyof typeof providerSchemaProfiles];
  if (!known) throw new TypeError(`No provider schema lowering profile is registered for ${id}.`);
  return known;
}

const validatorCache = new Map<string, z.ZodType>();

export function validateJsonSchema(schema: JSONSchema, input: unknown): z.ZodSafeParseResult<unknown> {
  const key = canonicalStringify(schema);
  let validator = validatorCache.get(key);
  if (!validator) {
    validator = z.fromJSONSchema(schema as never);
    validatorCache.set(key, validator);
  }
  return validator.safeParse(input);
}

export function createActionAuthoringInputSchema(schema: JSONSchema): JSONSchema {
  if (schema === false) return false;
  if (schema === true) {
    return {
      type: "object",
      additionalProperties: { $ref: "#/$defs/CompilerAuthoringValue" },
      $defs: commonDefinitions(),
    } as JSONSchema;
  }
  const root = schema as SchemaObject;
  const properties = isRecord(root.properties) ? root.properties : {};
  return {
    ...root,
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [
      key,
      {
        anyOf: [
          literalAuthoringSchema(value as JSONSchema),
          { $ref: "#/$defs/CompilerAuthoringValue" },
        ],
      },
    ])),
    additionalProperties: root.additionalProperties ?? false,
    $defs: {
      ...(isRecord(root.$defs) ? root.$defs : {}),
      ...commonDefinitions(),
    },
  } as unknown as JSONSchema;
}

export function schemaIssueSummary(result: z.ZodSafeParseError<unknown>): string {
  const first = result.error.issues[0];
  if (!first) return "Value does not satisfy the JSON Schema.";
  const path = first.path.length === 0 ? "value" : first.path.join(".");
  return `${path}: ${first.message}`.slice(0, 512);
}
