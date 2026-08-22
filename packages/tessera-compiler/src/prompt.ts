import { z } from "zod";
import { assertJsonValue, canonicalize, hashJson } from "./canonical";
import {
  CompilerCatalog,
  defaultCompilerCatalog,
  sliceCatalog,
} from "./catalog";
import { compilerDiagnostic, CompilerDiagnosticError } from "./diagnostics";
import { actionContractVersions } from "./contract-version";
import { DEFAULT_DOCUMENT_POLICY } from "./information-flow";
import { resolveGenerationLimits } from "./normalize";
import type {
  AuthoringCodec,
  CatalogSlice,
  CompilerExample,
  CompilerPreset,
  DocumentPolicy,
  DocumentSummary,
  GenerationLimits,
  JSONSchema,
  JsonValue,
  ModelVisibleCapability,
  ModelVisibleMessageTemplate,
  NodeContract,
  PromptBundle,
  RenderMode,
  SurfaceProfile,
} from "./types";

const schemaProfile = {
  profileId: "data-elements.schema-core",
  profileVersion: 1,
  profileHash: hashJson({ id: "data-elements.schema-core", version: 1 }),
} as const;

const PROVIDER_SCHEMA_CACHE_LIMIT = 128;
const providerSchemaCache = new Map<string, string>();

function nodeDefinitionKey(contract: NodeContract): string {
  return `node_${contract.type.replaceAll(/[^a-zA-Z0-9_]/g, "_")}_${hashJson(contract.type).slice(0, 8)}`;
}

function jsonSchemaFor(contract: NodeContract): JSONSchema {
  if (contract.providerSchema) return applyContractBindings(contract.providerSchema, contract);
  const schema = contract.propsSchema;
  const generated: unknown = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "inline",
  });
  assertJsonValue(generated);
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    throw new TypeError("A node props schema must compile to an object JSON Schema.");
  }
  const embedded = { ...generated };
  delete embedded.$schema;
  return applyContractBindings(embedded, contract);
}

function applyContractBindings(schema: JSONSchema, contract: NodeContract): JSONSchema {
  const paths = new Map<string, { reference: boolean; condition: boolean }>();
  for (const path of contract.bindings?.referencePaths ?? []) {
    paths.set(path, { reference: true, condition: paths.get(path)?.condition ?? false });
  }
  for (const path of contract.bindings?.conditionPaths ?? []) {
    paths.set(path, { reference: paths.get(path)?.reference ?? false, condition: true });
  }
  let output = JSON.parse(JSON.stringify(schema)) as JSONSchema;
  for (const [path, allowed] of [...paths.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const result = wrapBindingPath(output, decodeContractPath(path), 0, allowed);
    if (!result.found) {
      throw new TypeError(`Node contract "${contract.type}" binding path "${path}" is not present in its props schema.`);
    }
    output = result.schema;
  }
  return output;
}

function decodeContractPath(path: string): string[] {
  return path.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function wrapBindingPath(
  schema: JSONSchema,
  segments: readonly string[],
  index: number,
  allowed: { reference: boolean; condition: boolean },
): { schema: JSONSchema; found: boolean } {
  if (index === segments.length) {
    return {
      schema: {
        oneOf: [
          schema,
          ...(allowed.reference ? [reference("#/$defs/propsReference")] : []),
          ...(allowed.condition ? [reference("#/$defs/presentationCondition")] : []),
        ],
      },
      found: true,
    };
  }
  const segment = segments[index]!;
  if (segment === "*") {
    const items = schema.items;
    if (!items || typeof items !== "object" || Array.isArray(items)) return { schema, found: false };
    const nested = wrapBindingPath(items as JSONSchema, segments, index + 1, allowed);
    return nested.found ? { schema: { ...schema, items: nested.schema }, found: true } : { schema, found: false };
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return { schema, found: false };
  }
  const property = properties[segment];
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return { schema, found: false };
  }
  const nested = wrapBindingPath(property as JSONSchema, segments, index + 1, allowed);
  if (!nested.found) return { schema, found: false };
  return {
    schema: { ...schema, properties: { ...properties, [segment]: nested.schema } },
    found: true,
  };
}

function reference(ref: string): JSONSchema {
  return { $ref: ref };
}

function buildValueDefinitions(): Record<string, JSONSchema> {
  const path = {
    type: "array",
    items: {
      anyOf: [
        { type: "string", minLength: 1, not: { enum: ["__proto__", "constructor", "prototype"] } },
        { type: "integer", minimum: 0 },
      ],
    },
  } as unknown as JSONSchema;
  const closed = (properties: JSONSchema, required: string[]): JSONSchema => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });
  const stateOrResourceReference = closed({
    $ref: { enum: ["state", "resource"] },
    id: { type: "string", minLength: 1 },
    path,
  }, ["$ref", "id"]);
  const contextReference = closed({
    $ref: { const: "context" },
    key: { enum: ["locale", "timezone"] },
  }, ["$ref", "key"]);
  const eventReference = closed({
    $ref: { const: "event" },
    port: { type: "string", minLength: 1 },
    path,
  }, ["$ref", "port"]);
  const presentationCondition = closed({
    $condition: closed({
      op: { enum: ["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"] },
      args: { type: "array", minItems: 1, items: reference("#/$defs/authoringValue") },
    }, ["op", "args"]),
  }, ["$condition"]);
  return {
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "string" },
        { type: "number" },
        { type: "array", items: reference("#/$defs/jsonValue") },
        {
          type: "object",
          propertyNames: { not: { enum: ["__proto__", "constructor", "prototype"] } },
          additionalProperties: reference("#/$defs/jsonValue"),
        },
      ],
    },
    authoringValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "string" },
        { type: "number" },
        { type: "array", items: reference("#/$defs/authoringValue") },
        {
          type: "object",
          propertyNames: {
            allOf: [
              { not: { pattern: "^\\$" } },
              { not: { enum: ["__proto__", "constructor", "prototype"] } },
            ],
          },
          additionalProperties: reference("#/$defs/authoringValue"),
        },
        reference("#/$defs/propsReference"),
        reference("#/$defs/eventReference"),
        reference("#/$defs/presentationCondition"),
      ],
    },
    propsReference: { oneOf: [stateOrResourceReference, contextReference] },
    eventReference,
    presentationCondition,
  };
}

function actionDefinitions(
  capabilities: readonly ModelVisibleCapability[],
  templates: readonly ModelVisibleMessageTemplate[],
  actionContracts: ReadonlyMap<string, readonly number[]>,
): Record<string, JSONSchema> {
  const valueRecord: JSONSchema = {
    type: "object",
    propertyNames: { not: { pattern: "^\\$" } },
    additionalProperties: reference("#/$defs/authoringValue"),
  };
  const stepBase = (properties: JSONSchema, required: string[]): JSONSchema => ({
    type: "object",
    properties: { stepId: { type: "string", minLength: 1 }, ...properties },
    required: ["stepId", ...required],
    additionalProperties: false,
  });
  const steps: JSONSchema[] = [
    stepBase({ type: { const: "state.set" }, stateId: { type: "string" }, value: reference("#/$defs/authoringValue") }, ["type", "stateId", "value"]),
    stepBase({ type: { const: "state.reset" }, stateIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } } }, ["type", "stateIds"]),
    stepBase({ type: { const: "node.focus" }, nodeId: { type: "string" } }, ["type", "nodeId"]),
  ];
  if (templates.length) {
    steps.push(stepBase({
      type: { const: "agent.message" },
      templateGrantId: { enum: templates.map(({ templateGrantId }) => templateGrantId) },
      values: valueRecord,
    }, ["type", "templateGrantId"]));
  }
  if (capabilities.length) {
    const capabilityIds = capabilities.map(({ capabilityId }) => capabilityId);
    steps.push(stepBase({
      type: { const: "capability.request" },
      capabilityId: { enum: capabilityIds },
      input: valueRecord,
    }, ["type", "capabilityId", "input"]));
    steps.push(stepBase({
      type: { const: "navigation.request" },
      target: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "route" }, capabilityId: { enum: capabilityIds },
              routeId: { type: "string" }, params: valueRecord,
            },
            required: ["kind", "capabilityId", "routeId"], additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "resource" }, capabilityId: { enum: capabilityIds },
              resourceId: { type: "string" },
            },
            required: ["kind", "capabilityId", "resourceId"], additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "external" }, capabilityId: { enum: capabilityIds }, input: valueRecord,
            },
            required: ["kind", "capabilityId", "input"], additionalProperties: false,
          },
        ],
      },
    }, ["type", "target"]));
  }
  let actionPlan: JSONSchema;
  if (actionContracts.size === 0) {
    actionPlan = { not: {} };
  } else {
    actionPlan = {
      oneOf: [...actionContracts.entries()].map(([contractId, versions]) => ({
          type: "object",
          properties: {
            contractId: { const: contractId },
            contractVersion: {
              enum: [...versions],
              ...(versions.includes(1) ? { default: 1 } : {}),
            },
            steps: { type: "array", minItems: 1, items: reference("#/$defs/actionStep") },
            onError: { enum: ["halt", "continue"], default: "halt" },
          },
          required: ["contractId", "steps", ...(versions.includes(1) ? [] : ["contractVersion"])],
          additionalProperties: false,
      })),
    };
  }
  return {
    actionStep: { oneOf: steps },
    actionPlan,
    stateDefinition: {
      type: "object",
      properties: {
        schema: { type: "object" },
        initial: reference("#/$defs/jsonValue"),
      },
      required: ["schema", "initial"],
      additionalProperties: false,
    },
  };
}

function collectActionContracts(slice: CatalogSlice): ReadonlyMap<string, readonly number[]> {
  const versions = new Map<string, Set<number>>();
  for (const contract of slice.contracts) {
    for (const event of Object.values(contract.events ?? {})) {
      for (const [contractId, range] of Object.entries(event.actionContracts)) {
        const supported = actionContractVersions(range);
        if (!supported) {
          throw new TypeError(`Unsupported action contract range "${range}" in "${contract.type}".`);
        }
        const existing = versions.get(contractId) ?? new Set<number>();
        supported.forEach((version) => existing.add(version));
        versions.set(contractId, existing);
      }
    }
  }
  return new Map([...versions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([contractId, supported]) => [contractId, [...supported].sort((left, right) => left - right)]));
}

export function createProviderSchema(
  slice: CatalogSlice,
  options: {
    capabilities?: readonly ModelVisibleCapability[];
    messageTemplates?: readonly ModelVisibleMessageTemplate[];
  } = {},
): JSONSchema {
  const capabilities = [...(options.capabilities ?? [])].sort(
    (left, right) => left.capabilityId.localeCompare(right.capabilityId),
  );
  const templates = [...(options.messageTemplates ?? [])].sort(
    (left, right) => left.templateGrantId.localeCompare(right.templateGrantId),
  );
  const cacheIdentity = {
    version: 1,
    sliceHash: slice.sliceHash,
    capabilities,
    templates,
  };
  assertJsonValue(cacheIdentity);
  const cacheKey = hashJson(cacheIdentity);
  const cached = providerSchemaCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh insertion order so frequently used catalog slices remain hot.
    providerSchemaCache.delete(cacheKey);
    providerSchemaCache.set(cacheKey, cached);
    return JSON.parse(cached) as JSONSchema;
  }

  const definitions: Record<string, JSONSchema> = {
    ...buildValueDefinitions(),
    ...actionDefinitions(capabilities, templates, collectActionContracts(slice)),
  };
  const keyByType = new Map(slice.contracts.map((contract) => [contract.type, nodeDefinitionKey(contract)]));

  for (const contract of slice.contracts) {
    const properties: JSONSchema = {
      id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$" },
      type: { const: contract.type },
      typeVersion: { const: contract.version },
      props: jsonSchemaFor(contract),
    };
    const required = ["id", "type"];
    const slotEntries = Object.entries(contract.slots).sort(([left], [right]) => left.localeCompare(right));
    if (slotEntries.length) {
      const slotProperties: JSONSchema = {};
      const requiredSlots: string[] = [];
      for (const [slotName, slot] of slotEntries) {
        const accepted = slice.contracts.filter((candidate) => (
          slot.accepts?.includes(candidate.type)
          || slot.categories?.includes(candidate.category)
          || (candidate.category.startsWith("extension:") && slot.categories?.includes("extension:*"))
        ));
        slotProperties[slotName] = {
          type: "array",
          minItems: slot.min ?? 0,
          maxItems: slot.max ?? 2_000,
          items: accepted.length
            ? { oneOf: accepted.map((candidate) => reference(`#/$defs/${keyByType.get(candidate.type)!}`)) }
            : { not: {} },
        };
        if ((slot.min ?? 0) > 0) requiredSlots.push(slotName);
      }
      properties.slots = {
        type: "object",
        properties: slotProperties,
        ...(requiredSlots.length ? { required: requiredSlots } : {}),
        additionalProperties: false,
      };
      if (requiredSlots.length) required.push("slots");
    }
    if (contract.events && Object.keys(contract.events).length) {
      properties.events = {
        type: "object",
        properties: Object.fromEntries(Object.keys(contract.events).sort().map((port) => [
          port,
          { type: "string", minLength: 1 },
        ])),
        additionalProperties: false,
      };
    }
    properties.evidence = {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    };
    definitions[keyByType.get(contract.type)!] = {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }

  const rootRefs = slice.contracts.map((contract) => reference(`#/$defs/${keyByType.get(contract.type)!}`));
  const schema: JSONSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:data-elements:authoring:${slice.sliceHash}`,
    title: "Data Elements Artifact Proposal",
    description: "Nested authoring input. The trusted compiler normalizes and validates it before rendering.",
    type: "object",
    properties: {
      root: { oneOf: rootRefs },
      state: { type: "object", additionalProperties: reference("#/$defs/stateDefinition") },
      actions: { type: "object", additionalProperties: reference("#/$defs/actionPlan") },
      claims: { type: "object", additionalProperties: reference("#/$defs/jsonValue") },
      resourceIds: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
      meta: {
        type: "object",
        properties: {
          title: { type: "string" }, description: { type: "string" }, locale: { type: "string" },
          tags: { type: "array", uniqueItems: true, items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    required: ["root"],
    additionalProperties: false,
    $defs: definitions,
  };
  providerSchemaCache.set(cacheKey, JSON.stringify(schema));
  if (providerSchemaCache.size > PROVIDER_SCHEMA_CACHE_LIMIT) {
    const oldest = providerSchemaCache.keys().next().value;
    if (oldest !== undefined) providerSchemaCache.delete(oldest);
  }
  return schema;
}

function validateDescriptorSets(
  capabilities: readonly ModelVisibleCapability[],
  templates: readonly ModelVisibleMessageTemplate[],
): void {
  const assertUnique = (values: readonly string[], path: string): void => {
    if (new Set(values).size !== values.length) {
      throw new CompilerDiagnosticError([compilerDiagnostic({
        phase: "policy",
        code: "prompt.duplicate_descriptor",
        message: "Model-visible descriptor ids must be unique within a turn.",
        path,
        recoverable: false,
        modelCorrectable: false,
      })]);
    }
  };
  assertUnique(capabilities.map(({ capabilityId }) => capabilityId), "/capabilityDescriptors");
  assertUnique(templates.map(({ templateGrantId }) => templateGrantId), "/messageTemplateDescriptors");
  for (const [index, descriptor] of [...capabilities, ...templates].entries()) {
    if (
      descriptor.schemaProfile.profileId !== schemaProfile.profileId
      || descriptor.schemaProfile.profileVersion !== schemaProfile.profileVersion
      || descriptor.schemaProfile.profileHash !== schemaProfile.profileHash
    ) {
      throw new CompilerDiagnosticError([compilerDiagnostic({
        phase: "policy",
        code: "prompt.schema_profile_mismatch",
        message: "A model-visible descriptor uses a different schema profile.",
        path: `/descriptors/${index}/schemaProfile`,
        recoverable: false,
        modelCorrectable: false,
      })]);
    }
  }
}

function selectExamples(
  slice: CatalogSlice,
  profile: SurfaceProfile,
  maxExamples: number,
): readonly CompilerExample[] {
  const available = new Set(slice.contracts.map(({ type }) => type));
  const unique = new Map<string, CompilerExample>();
  for (const contract of slice.contracts) {
    for (const example of contract.examples ?? []) unique.set(example.id, example);
  }
  return [...unique.values()]
    .filter((example) => example.profiles.includes(profile) && example.nodeTypes.every((type) => available.has(type)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, maxExamples);
}

function contractInstructions(contract: NodeContract): string {
  const slots = Object.entries(contract.slots).sort(([left], [right]) => left.localeCompare(right)).map(
    ([name, slot]) => `${name}[${slot.min ?? 0}..${slot.max ?? "n"}]`,
  ).join(", ") || "none";
  return [
    `- ${contract.type}@${contract.version} (${contract.category}, ${contract.commitPolicy})`,
    `  ${contract.prompt.summary}`,
    `  Use when: ${contract.prompt.useWhen.join(" ")}`,
    `  Avoid when: ${contract.prompt.avoidWhen.join(" ")}`,
    `  Slots: ${slots}`,
  ].join("\n");
}

function buildSystem(input: {
  slice: CatalogSlice;
  profile: SurfaceProfile;
  preset: CompilerPreset;
  codec: AuthoringCodec;
  renderMode: RenderMode;
  locale: string;
  limits: GenerationLimits;
  examples: readonly CompilerExample[];
  capabilities: readonly ModelVisibleCapability[];
  templates: readonly ModelVisibleMessageTemplate[];
  summaries: readonly DocumentSummary[];
}): string {
  const sections = [
    "You produce Data Elements Artifact Authoring DSL only through the renderArtifact tool.",
    "Never emit JSX, JavaScript, HTML, CSS, SQL, executable formulas, credentials, endpoints, or arbitrary component names.",
    `Protocol 2.0; codec ${input.codec}; profile ${input.profile}; preset ${input.preset}; render mode ${input.renderMode}; locale ${input.locale}.`,
    `Limits: at most ${input.limits.maxNodes} nodes, depth ${input.limits.maxDepth}, ${input.limits.maxDocumentBytes} UTF-8 bytes, and ${input.limits.maxTotalValues} values.`,
    "Use stable unique ids. Nest nodes only in declared slots. Props must match the generated closed schema. Treat semantic artifact nodes as atomic.",
    "Only cite evidence and resources already provided by the host. Descriptors name possible requests, not authorization to invent new ids.",
    "Active node contracts:\n" + input.slice.contracts.map(contractInstructions).join("\n"),
  ];
  if (input.capabilities.length) {
    sections.push("Model-visible capabilities:\n" + input.capabilities.map((capability) => (
      `- ${capability.capabilityId}@${capability.grantVersion}: ${capability.summary}; approval=${capability.requiresApproval}`
    )).join("\n"));
  }
  if (input.templates.length) {
    sections.push("Model-visible message templates:\n" + input.templates.map((template) => (
      `- ${template.templateGrantId}@${template.templateGrantVersion}: ${template.summary}`
    )).join("\n"));
  }
  if (input.summaries.length) {
    sections.push("Authorized parent document summaries:\n" + input.summaries.map((summary) => (
      `- ${summary.documentId}@${summary.revisionId}${summary.title ? ` (${summary.title})` : ""}: ${summary.summary}`
    )).join("\n"));
  }
  if (input.examples.length) {
    sections.push("Validated examples:\n" + input.examples.map((example) => (
      `User: ${example.user}\nTool input: ${canonicalize(example.proposal as unknown as JsonValue)}`
    )).join("\n\n"));
  }
  return sections.join("\n\n");
}

export type PromptCompileInput = {
  catalog?: CompilerCatalog | CatalogSlice;
  preset?: CompilerPreset;
  profile?: SurfaceProfile;
  documentPolicy?: DocumentPolicy;
  generationTaintHash: string;
  requestedNodeTypes?: readonly string[];
  task?: string;
  codec?: AuthoringCodec;
  renderMode?: RenderMode;
  capabilityDescriptors?: readonly ModelVisibleCapability[];
  messageTemplateDescriptors?: readonly ModelVisibleMessageTemplate[];
  locale?: string;
  limits?: Partial<GenerationLimits>;
  parentDocumentSummaries?: readonly DocumentSummary[];
};

export function compilePrompt(input: PromptCompileInput): Readonly<PromptBundle> {
  const preset = input.preset ?? "standard";
  const profile = input.profile ?? "analysis";
  const codec = input.codec ?? "snapshot-json";
  const renderMode = preset === "governed" ? "strict" : input.renderMode ?? "progressive";
  const locale = input.locale ?? "en-US";
  const limits = resolveGenerationLimits(input.limits);
  const capabilities = [...(input.capabilityDescriptors ?? [])].sort(
    (left, right) => left.capabilityId.localeCompare(right.capabilityId),
  );
  const templates = [...(input.messageTemplateDescriptors ?? [])].sort(
    (left, right) => left.templateGrantId.localeCompare(right.templateGrantId),
  );
  validateDescriptorSets(capabilities, templates);
  const catalog = input.catalog ?? defaultCompilerCatalog;
  const catalogSlice = catalog instanceof CompilerCatalog
    ? sliceCatalog({
        catalog,
        profile,
        requestedNodeTypes: input.requestedNodeTypes,
        task: input.task,
        maxNodeTypes: limits.maxNodeTypes,
      })
    : catalog;
  const examples = selectExamples(catalogSlice, profile, limits.maxExamples);
  const providerSchema = createProviderSchema(catalogSlice, {
    capabilities,
    messageTemplates: templates,
  });
  const summaries = [...(input.parentDocumentSummaries ?? [])].sort(
    (left, right) => left.documentId.localeCompare(right.documentId) || left.revisionId.localeCompare(right.revisionId),
  );
  const system = buildSystem({
    slice: catalogSlice,
    profile,
    preset,
    codec,
    renderMode,
    locale,
    limits,
    examples,
    capabilities,
    templates,
    summaries,
  });
  const documentPolicy = input.documentPolicy ?? DEFAULT_DOCUMENT_POLICY;
  const hashInput: JsonValue = {
    protocolVersion: "2.0",
    system,
    providerSchema,
    catalog: catalogSlice.catalog as unknown as JsonValue,
    contractFingerprint: catalogSlice.contractFingerprint,
    sliceHash: catalogSlice.sliceHash,
    profile,
    preset,
    codec,
    renderMode,
    locale,
    limits,
    documentPolicy,
    generationTaintHash: input.generationTaintHash,
    capabilities: capabilities as unknown as JsonValue,
    messageTemplates: templates as unknown as JsonValue,
    parentDocumentSummaries: summaries as unknown as JsonValue,
    examples: examples as unknown as JsonValue,
  };
  const promptBundleHash = hashJson(hashInput);
  const bundle: PromptBundle = {
    protocolVersion: "2.0",
    system,
    providerSchema,
    tool: {
      name: "renderArtifact",
      description: "Submit one validated, declarative Data Elements artifact proposal.",
      inputSchema: providerSchema,
    },
    catalogSlice,
    contractFingerprint: catalogSlice.contractFingerprint,
    promptBundleHash,
    generationTaintHash: input.generationTaintHash,
    profile,
    preset,
    codec,
    renderMode,
    locale,
    limits,
    examples,
    repair: {
      maxAttempts: limits.maxRepairAttempts,
      redactedFields: ["actualSummary", "expected", "rawException", "credentials", "hiddenPolicy", "sql"],
    },
  };
  Object.freeze(bundle.tool);
  Object.freeze(bundle.repair);
  return Object.freeze(bundle);
}

export { schemaProfile as compilerSchemaProfile };
