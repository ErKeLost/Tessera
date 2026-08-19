import { artifactContracts, type ArtifactContract } from "@data-elements/core";
import type { Artifact, ArtifactKind } from "@data-elements/schema";
import { z, type ZodType } from "zod";
import { assertJsonValue, deepFreeze, hashJson } from "./canonical";
import { actionContractVersions } from "./contract-version";
import { compilerDiagnostic, CompilerDiagnosticError } from "./diagnostics";
import type {
  CatalogIdentity,
  CatalogSlice,
  CompilerExample,
  JSONSchema,
  JsonValue,
  NodeContract,
  SurfaceProfile,
} from "./types";

const nodeTypePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const contractPathSegmentPattern = /^(?:[^~]|~[01])+$/;
const gapSchema = z.enum(["none", "xs", "sm", "md", "lg", "xl"]);
const alignSchema = z.enum(["start", "center", "end", "stretch"]);
const formInputValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite(),
]);
const formOptionSchema = z.object({
  value: z.string().min(1).max(512),
  label: z.string().min(1).max(512),
  disabled: z.boolean().optional(),
}).strict();

function propsSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict() as unknown as ZodType<Record<string, unknown>>;
}

export function defineNodeContract<const T extends NodeContract>(contract: T): T {
  if (!nodeTypePattern.test(contract.type)) {
    throw new TypeError(
      `Node type "${contract.type}" must be a lowercase namespaced identifier.`,
    );
  }
  if (!Number.isSafeInteger(contract.version) || contract.version < 1) {
    throw new TypeError(`Node contract "${contract.type}" must have a positive version.`);
  }
  if (!contract.prompt.summary.trim()) {
    throw new TypeError(`Node contract "${contract.type}" needs a prompt summary.`);
  }
  if (contract.prompt.useWhen.length === 0 || contract.prompt.avoidWhen.length === 0) {
    throw new TypeError(
      `Node contract "${contract.type}" needs positive and negative selection guidance.`,
    );
  }
  for (const [name, slot] of Object.entries(contract.slots)) {
    if (!name || (slot.min ?? 0) < 0 || (slot.max ?? Number.MAX_SAFE_INTEGER) < (slot.min ?? 0)) {
      throw new TypeError(`Node contract "${contract.type}" has an invalid "${name}" slot.`);
    }
    if (!slot.accepts?.length && !slot.categories?.length) {
      throw new TypeError(
        `Node contract "${contract.type}" slot "${name}" must constrain accepted children.`,
      );
    }
  }
  for (const [kind, paths] of Object.entries(contract.bindings ?? {})) {
    if (new Set(paths).size !== paths.length || paths.some((path) => !isContractPath(path))) {
      throw new TypeError(`Node contract "${contract.type}" has invalid ${kind}.`);
    }
    Object.freeze(paths);
  }
  for (const [name, event] of Object.entries(contract.events ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
      throw new TypeError(`Node contract "${contract.type}" has an invalid event port.`);
    }
    if (Object.keys(event.actionContracts).length === 0) {
      throw new TypeError(`Node contract "${contract.type}" event "${name}" needs an action contract.`);
    }
    for (const [contractId, versionRange] of Object.entries(event.actionContracts)) {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(contractId)) {
        throw new TypeError(`Node contract "${contract.type}" event "${name}" has an invalid action contract id.`);
      }
      if (!actionContractVersions(versionRange)) {
        throw new TypeError(
          `Node contract "${contract.type}" event "${name}" has an unsupported action contract range.`,
        );
      }
    }
    Object.freeze(event.actionContracts);
    Object.freeze(event);
  }
  if (contract.events) Object.freeze(contract.events);
  if (contract.bindings) Object.freeze(contract.bindings);
  Object.freeze(contract.prompt);
  Object.freeze(contract.slots);
  Object.freeze(contract);
  return contract;
}

function isContractPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  return path.slice(1).split("/").every((segment) => (
    segment.length > 0 && contractPathSegmentPattern.test(segment)
  ));
}

function contractProjection(contract: NodeContract): JsonValue {
  const props = contract.providerSchema ?? z.toJSONSchema(contract.propsSchema, {
    target: "draft-2020-12", reused: "inline",
  });
  assertJsonValue(props);
  const events = Object.fromEntries(
    Object.entries(contract.events ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(
      ([name, event]) => {
        const payload = z.toJSONSchema(event.payloadSchema, {
          target: "draft-2020-12",
          reused: "inline",
        });
        assertJsonValue(payload);
        return [name, {
          payload,
          actionContracts: Object.fromEntries(
            Object.entries(event.actionContracts).sort(([left], [right]) => left.localeCompare(right)),
          ),
        }];
      },
    ),
  );

  return {
    type: contract.type,
    version: contract.version,
    category: contract.category,
    props,
    slots: contract.slots as unknown as JsonValue,
    trust: contract.trust,
    commitPolicy: contract.commitPolicy,
    prompt: contract.prompt as unknown as JsonValue,
    profiles: [...contract.profiles].sort(),
    dependencies: [...(contract.dependencies ?? [])].sort(),
    maxInstances: contract.maxInstances ?? null,
    events: events as JsonValue,
    bindings: (contract.bindings ?? {}) as JsonValue,
  };
}

export class CompilerCatalog {
  readonly identity: Readonly<CatalogIdentity>;
  readonly contractFingerprint: string;
  readonly #contracts: ReadonlyMap<string, NodeContract>;

  constructor(identity: CatalogIdentity, contracts: readonly NodeContract[]) {
    if (!identity.id.trim() || !identity.version.trim()) {
      throw new TypeError("A compiler catalog needs a stable id and version.");
    }
    const entries = new Map<string, NodeContract>();
    for (const contract of contracts) {
      if (entries.has(contract.type)) {
        throw new TypeError(`Node type "${contract.type}" is already registered.`);
      }
      entries.set(contract.type, defineNodeContract(contract));
    }
    for (const contract of entries.values()) {
      for (const dependency of contract.dependencies ?? []) {
        if (!entries.has(dependency)) {
          throw new TypeError(
            `Node contract "${contract.type}" depends on missing type "${dependency}".`,
          );
        }
      }
    }

    this.identity = deepFreeze({ ...identity });
    this.#contracts = entries;
    this.contractFingerprint = hashJson({
      catalog: this.identity as unknown as JsonValue,
      contracts: [...entries.values()]
        .sort((left, right) => left.type.localeCompare(right.type))
        .map(contractProjection),
    });
    Object.freeze(this);
  }

  has(type: string): boolean {
    return this.#contracts.has(type);
  }

  get(type: string): NodeContract | undefined {
    return this.#contracts.get(type);
  }

  contracts(): readonly NodeContract[] {
    return [...this.#contracts.values()].sort((left, right) => left.type.localeCompare(right.type));
  }

  extend(
    contracts: readonly NodeContract[],
    identity: CatalogIdentity = this.identity,
  ): CompilerCatalog {
    return new CompilerCatalog(identity, [...this.#contracts.values(), ...contracts]);
  }
}

export function createCompilerCatalog(
  contracts: readonly NodeContract[],
  identity: CatalogIdentity = { id: "data-elements.custom", version: "1" },
): CompilerCatalog {
  return new CompilerCatalog(identity, contracts);
}

const composableCategories = [
  "surface-layout",
  "surface-content",
  "surface-form",
  "semantic-artifact",
  "extension:*",
] as const;

export const surfaceNodeContracts = [
  defineNodeContract({
    type: "layout.stack",
    version: 1,
    category: "surface-layout",
    propsSchema: propsSchema({
      gap: gapSchema.default("md"),
      align: alignSchema.default("stretch"),
    }),
    slots: {
      children: {
        categories: composableCategories,
        min: 1,
        max: 32,
        fallback: "placeholder",
      },
    },
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Arrange related nodes vertically with semantic spacing.",
      useWhen: ["The result contains more than one related block."],
      avoidWhen: ["A single semantic artifact can be the root."],
    },
    profiles: ["analysis", "report", "form", "operations"],
    searchTerms: ["stack", "layout", "section", "纵向", "布局"],
    maxInstances: 16,
  }),
  defineNodeContract({
    type: "layout.grid",
    version: 1,
    category: "surface-layout",
    propsSchema: propsSchema({
      columns: z.number().int().min(1).max(4).default(2),
      gap: gapSchema.default("md"),
      align: alignSchema.default("stretch"),
    }),
    slots: {
      children: {
        categories: composableCategories,
        min: 1,
        max: 16,
        fallback: "placeholder",
      },
    },
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Arrange comparable nodes in a responsive grid.",
      useWhen: ["Several peers benefit from side-by-side comparison."],
      avoidWhen: ["Reading order or narrow-screen density would be unclear."],
    },
    profiles: ["analysis", "report", "operations"],
    searchTerms: ["grid", "compare", "dashboard", "网格", "对比"],
    maxInstances: 8,
  }),
  defineNodeContract({
    type: "layout.section",
    version: 1,
    category: "surface-layout",
    propsSchema: propsSchema({
      title: z.string().min(1).max(160).optional(),
      description: z.string().max(1_000).optional(),
    }),
    slots: {
      children: {
        categories: composableCategories,
        min: 1,
        max: 24,
        fallback: "placeholder",
      },
    },
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Group a named part of a report without controlling visual styling.",
      useWhen: ["A document needs a clear semantic subsection."],
      avoidWhen: ["The section would contain no meaningful child."],
    },
    profiles: ["analysis", "report", "form", "operations"],
    searchTerms: ["section", "group", "章节", "分组"],
    maxInstances: 16,
  }),
  defineNodeContract({
    type: "content.text",
    version: 1,
    category: "surface-content",
    propsSchema: propsSchema({
      text: z.string().min(1).max(8_000),
      role: z.enum(["heading", "paragraph", "caption"]).default("paragraph"),
      tone: z.enum(["default", "muted", "positive", "warning", "critical"]).default("default"),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Render bounded plain text with a semantic role.",
      useWhen: ["A short heading, explanation, or caption improves comprehension."],
      avoidWhen: ["Structured data belongs in a semantic artifact node."],
    },
    profiles: ["analysis", "report", "form", "operations"],
    searchTerms: ["text", "summary", "explain", "文本", "说明"],
    maxInstances: 32,
  }),
  defineNodeContract({
    type: "content.callout",
    version: 1,
    category: "surface-content",
    propsSchema: propsSchema({
      title: z.string().min(1).max(160).optional(),
      body: z.string().min(1).max(2_000),
      tone: z.enum(["info", "success", "warning", "critical"]).default("info"),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Emphasize a bounded status, warning, or conclusion.",
      useWhen: ["One short message needs distinct semantic emphasis."],
      avoidWhen: ["The content is ordinary narrative or unsupported alarm."],
    },
    profiles: ["analysis", "report", "form", "operations"],
    searchTerms: ["warning", "notice", "status", "提醒", "警告"],
    maxInstances: 12,
  }),
  defineNodeContract({
    type: "content.progress",
    version: 1,
    category: "surface-content",
    propsSchema: propsSchema({
      label: z.string().min(1).max(160),
      value: z.number().min(0).max(100),
      detail: z.string().max(500).optional(),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Show validated completion against a zero-to-one-hundred scale.",
      useWhen: ["A real process or target has a validated completion percentage."],
      avoidWhen: ["The percentage is an unsupported estimate."],
    },
    profiles: ["report", "operations"],
    searchTerms: ["progress", "completion", "进度", "完成率"],
    maxInstances: 12,
  }),
  defineNodeContract({
    type: "content.empty",
    version: 1,
    category: "surface-content",
    propsSchema: propsSchema({
      title: z.string().min(1).max(160),
      description: z.string().max(1_000).optional(),
      reason: z.enum(["no-data", "filtered", "unavailable", "not-applicable"]).default("no-data"),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "progressive",
    prompt: {
      summary: "Represent a valid empty or unavailable result explicitly.",
      useWhen: ["A trusted query produced no data or a resource is unavailable."],
      avoidWhen: ["Generation failed or validation is incomplete."],
    },
    profiles: ["analysis", "report", "form", "operations"],
    searchTerms: ["empty", "no data", "unavailable", "空", "无数据"],
    maxInstances: 8,
  }),
  defineNodeContract({
    type: "form.root",
    version: 1,
    category: "surface-form",
    propsSchema: propsSchema({
      title: z.string().min(1).max(160).optional(),
      description: z.string().max(1_000).optional(),
    }),
    slots: {
      fields: {
        accepts: ["form.input", "form.select", "form.toggle", "form.button"],
        min: 1,
        max: 32,
        fallback: "placeholder",
      },
    },
    trust: "safe",
    commitPolicy: "atomic",
    prompt: {
      summary: "Collect typed local state through a bounded declarative form.",
      useWhen: ["The user needs to review or change a small set of typed values."],
      avoidWhen: ["The interaction can execute without explicit user review."],
    },
    profiles: ["form", "operations"],
    searchTerms: ["form", "input", "edit", "表单", "填写"],
    dependencies: ["form.input", "form.select", "form.toggle", "form.button"],
    maxInstances: 4,
    events: {
      submit: {
        payloadSchema: z.object({}).strict(),
        actionContracts: { "form.submit": "^1" },
      },
      reset: {
        payloadSchema: z.object({}).strict(),
        actionContracts: { "form.reset": "^1" },
      },
    },
  }),
  defineNodeContract({
    type: "form.input",
    version: 1,
    category: "surface-form",
    propsSchema: propsSchema({
      label: z.string().min(1).max(160),
      inputType: z.enum(["text", "email", "number", "date"]).default("text"),
      value: formInputValueSchema.default(""),
      placeholder: z.string().max(500).optional(),
      description: z.string().max(1_000).optional(),
      required: z.boolean().default(false),
      disabled: z.boolean().default(false),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "atomic",
    prompt: {
      summary: "Edit one bounded string or numeric state value.",
      useWhen: ["A form needs a short text, email, number, or date value."],
      avoidWhen: ["The field is a fixed option set or boolean choice."],
    },
    profiles: ["form", "operations"],
    searchTerms: ["input", "field", "text field", "输入", "字段"],
    maxInstances: 24,
    events: {
      change: {
        payloadSchema: z.object({ value: formInputValueSchema }).strict(),
        actionContracts: { "form.change": "^1" },
      },
    },
    bindings: {
      referencePaths: ["/value", "/disabled"],
      conditionPaths: ["/disabled"],
    },
  }),
  defineNodeContract({
    type: "form.select",
    version: 1,
    category: "surface-form",
    propsSchema: propsSchema({
      label: z.string().min(1).max(160),
      value: z.string().max(512).default(""),
      options: z.array(formOptionSchema).max(100).default([]),
      placeholder: z.string().max(500).optional(),
      description: z.string().max(1_000).optional(),
      required: z.boolean().default(false),
      disabled: z.boolean().default(false),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "atomic",
    prompt: {
      summary: "Choose one value from a bounded option set.",
      useWhen: ["A typed form value must come from known options."],
      avoidWhen: ["The option set is unbounded or free-form text is required."],
    },
    profiles: ["form", "operations"],
    searchTerms: ["select", "options", "choice", "选择", "选项"],
    maxInstances: 16,
    events: {
      change: {
        payloadSchema: z.object({ value: z.string().max(512) }).strict(),
        actionContracts: { "form.change": "^1" },
      },
    },
    bindings: {
      referencePaths: ["/value", "/options", "/disabled"],
      conditionPaths: ["/disabled"],
    },
  }),
  defineNodeContract({
    type: "form.toggle",
    version: 1,
    category: "surface-form",
    propsSchema: propsSchema({
      label: z.string().min(1).max(160),
      description: z.string().max(1_000).optional(),
      checked: z.boolean().default(false),
      disabled: z.boolean().default(false),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "atomic",
    prompt: {
      summary: "Edit one explicit boolean state value.",
      useWhen: ["A form needs a binary on or off choice."],
      avoidWhen: ["The choice has more than two meaningful values."],
    },
    profiles: ["form", "operations"],
    searchTerms: ["toggle", "boolean", "switch", "开关", "布尔"],
    maxInstances: 16,
    events: {
      change: {
        payloadSchema: z.object({ checked: z.boolean() }).strict(),
        actionContracts: { "form.change": "^1" },
      },
    },
    bindings: {
      referencePaths: ["/checked", "/disabled"],
      conditionPaths: ["/disabled"],
    },
  }),
  defineNodeContract({
    type: "form.button",
    version: 1,
    category: "surface-form",
    propsSchema: propsSchema({
      label: z.string().min(1).max(160),
      type: z.enum(["button", "submit", "reset"]).default("button"),
      variant: z.enum(["default", "secondary", "destructive"]).default("default"),
      disabled: z.boolean().default(false),
    }),
    slots: {},
    trust: "safe",
    commitPolicy: "atomic",
    prompt: {
      summary: "Trigger a declared form action with an explicit command button.",
      useWhen: ["A form needs an explicit submit, reset, or local action command."],
      avoidWhen: ["The action is not declared or requires hidden executable behavior."],
    },
    profiles: ["form", "operations"],
    searchTerms: ["button", "submit", "reset", "按钮", "提交"],
    maxInstances: 8,
    events: {
      press: {
        payloadSchema: z.object({}).strict(),
        actionContracts: { "form.press": "^1" },
      },
    },
    bindings: {
      referencePaths: ["/disabled"],
      conditionPaths: ["/disabled"],
    },
  }),
] as const;

const artifactProfiles: Record<ArtifactKind, readonly SurfaceProfile[]> = {
  query: ["analysis"],
  calculator: ["analysis"],
  metric: ["analysis", "report", "operations"],
  comparison: ["analysis", "report"],
  trend: ["analysis", "report", "operations"],
  anomaly: ["analysis", "operations"],
  forecast: ["analysis", "report", "operations"],
  funnel: ["analysis", "report", "operations"],
  "data-quality": ["analysis", "report", "operations"],
  insight: ["analysis", "report", "operations"],
  breakdown: ["analysis", "report"],
  distribution: ["analysis", "report"],
  cohort: ["analysis", "report"],
  experiment: ["analysis", "report"],
  driver: ["analysis", "report"],
  ranking: ["analysis", "report"],
  target: ["analysis", "report", "operations"],
  timeline: ["analysis", "report", "operations"],
};

const artifactSearchTerms: Record<ArtifactKind, readonly string[]> = {
  query: ["query", "rows", "table", "sql", "查询", "明细"],
  calculator: ["calculator", "what if", "scenario", "计算器", "假设"],
  metric: ["metric", "kpi", "number", "指标"],
  comparison: ["compare", "comparison", "versus", "比较", "对比"],
  trend: ["trend", "over time", "time series", "趋势", "变化"],
  anomaly: ["anomaly", "unusual", "spike", "异常", "突增"],
  forecast: ["forecast", "predict", "future", "预测", "未来"],
  funnel: ["funnel", "conversion", "drop off", "漏斗", "转化"],
  "data-quality": ["quality", "freshness", "validity", "质量", "新鲜度"],
  insight: ["insight", "finding", "结论", "洞察"],
  breakdown: ["breakdown", "contribution", "segment", "构成", "贡献"],
  distribution: ["distribution", "histogram", "spread", "分布", "直方图"],
  cohort: ["cohort", "retention", "留存", "同期群"],
  experiment: ["experiment", "ab test", "significance", "实验", "显著性"],
  driver: ["driver", "decomposition", "cause", "驱动", "归因"],
  ranking: ["ranking", "leaderboard", "top", "bottom", "排名", "排行"],
  target: ["target", "goal", "progress", "on track", "目标", "进度"],
  timeline: ["timeline", "event", "milestone", "history", "时间线", "里程碑"],
};

function semanticProviderSchema(contract: ArtifactContract<Artifact>): JsonValue {
  const generated = z.toJSONSchema(contract.schema, {
    target: "draft-2020-12",
    io: "input",
    reused: "inline",
  });
  assertJsonValue(generated);
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    throw new TypeError(`Artifact contract "${contract.kind}" did not produce an object schema.`);
  }
  const schema = JSON.parse(JSON.stringify(generated)) as Record<string, JsonValue>;
  delete schema.$schema;
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    delete properties.protocolVersion;
    delete properties.kind;
    delete properties.id;
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((key) => (
      key !== "protocolVersion" && key !== "kind" && key !== "id"
    ));
  }
  schema.additionalProperties = false;
  schema.description = `Semantic props for artifact.${contract.kind}@${contract.version}. Envelope identity is supplied by the host.`;
  return schema;
}

function semanticPropsSchema(
  contract: ArtifactContract<Artifact>,
): ZodType<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).refine(
    (input) => !("protocolVersion" in input) && !("kind" in input) && !("id" in input),
    { message: "Semantic node props must not contain v1 envelope identity fields." },
  ).transform((input) => contract.schema.parse({
    ...input,
    protocolVersion: "1.0",
    kind: contract.kind,
    id: "semantic-node",
  })).transform((artifact) => {
    const {
      protocolVersion: _protocolVersion,
      kind: _kind,
      id: _id,
      ...props
    } = artifact;
    return props;
  }) as unknown as ZodType<Record<string, unknown>>;
}

export const semanticArtifactContracts: readonly NodeContract[] = artifactContracts.map(
  (contract) => defineNodeContract({
    type: `artifact.${contract.kind}`,
    version: contract.version,
    category: "semantic-artifact",
    propsSchema: semanticPropsSchema(contract),
    providerSchema: semanticProviderSchema(contract) as JSONSchema,
    slots: {},
    trust: "governed",
    commitPolicy: contract.commitPolicy,
    prompt: contract.prompt,
    profiles: artifactProfiles[contract.kind as ArtifactKind],
    searchTerms: artifactSearchTerms[contract.kind as ArtifactKind],
    maxInstances: contract.kind === "metric" ? 12 : 4,
    events: Object.fromEntries(Object.entries(contract.eventPorts).map(([name, payloadSchema]) => [
      name,
      { payloadSchema, actionContracts: { [name]: "^1" } },
    ])),
  }),
);

const defaultExamples: readonly CompilerExample[] = [
  {
    id: "surface-summary",
    profiles: ["analysis", "report", "operations"],
    nodeTypes: ["layout.stack", "content.text"],
    user: "Summarize the validated result.",
    proposal: {
      root: {
        id: "root",
        type: "layout.stack",
        props: { gap: "md", align: "stretch" },
        slots: {
          children: [{
            id: "summary",
            type: "content.text",
            props: { text: "The validated result is ready.", role: "paragraph", tone: "default" },
          }],
        },
      },
    },
  },
  {
    id: "metric-report",
    profiles: ["analysis", "report"],
    nodeTypes: ["artifact.metric"],
    user: "Show the validated revenue metric.",
    proposal: {
      root: {
        id: "revenue",
        type: "artifact.metric",
        props: {
          title: "Revenue",
          description: "Validated revenue",
          metrics: [{ id: "mrr", label: "MRR", value: 461400, format: "currency", currency: "USD" }],
        },
      },
    },
  },
  {
    id: "typed-contact-form",
    profiles: ["form"],
    nodeTypes: ["form.root", "form.input", "form.button"],
    user: "Let me edit and confirm a contact name.",
    proposal: {
      root: {
        id: "contact-form",
        type: "form.root",
        props: { title: "Contact" },
        slots: {
          fields: [
            {
              id: "contact-name",
              type: "form.input",
              props: {
                label: "Name",
                value: { $ref: "state", id: "name" },
              },
              events: { change: "set-name" },
            },
            {
              id: "confirm",
              type: "form.button",
              props: { label: "Confirm", type: "submit" },
            },
          ],
        },
      },
      state: {
        name: { schema: { type: "string", maxLength: 160 }, initial: "" },
      },
      actions: {
        "set-name": {
          contractId: "form.change",
          steps: [{
            stepId: "apply-name",
            type: "state.set",
            stateId: "name",
            value: { $ref: "event", port: "change", path: ["value"] },
          }],
        },
      },
    },
  },
];

const contractsWithExamples = [...surfaceNodeContracts, ...semanticArtifactContracts].map(
  (contract) => ({
    ...contract,
    examples: defaultExamples.filter((example) => example.nodeTypes.includes(contract.type)),
  }),
);

export const defaultCompilerCatalog = new CompilerCatalog(
  { id: "data-elements.default", version: "2.0" },
  contractsWithExamples,
);

export type CatalogSliceInput = {
  catalog?: CompilerCatalog;
  profile?: SurfaceProfile;
  requestedNodeTypes?: readonly string[];
  task?: string;
  maxNodeTypes?: number;
};

const foundationTypes = new Set(["layout.stack", "content.text", "content.callout", "content.empty"]);

export function sliceCatalog(input: CatalogSliceInput = {}): CatalogSlice {
  const catalog = input.catalog ?? defaultCompilerCatalog;
  const profile = input.profile ?? "analysis";
  const maxNodeTypes = input.maxNodeTypes ?? 12;
  if (!Number.isSafeInteger(maxNodeTypes) || maxNodeTypes < 1) {
    throw new TypeError("maxNodeTypes must be a positive integer.");
  }
  const requested = [...new Set(input.requestedNodeTypes ?? [])].sort();
  const missing = requested.filter((type) => !catalog.has(type));
  if (missing.length) {
    throw new CompilerDiagnosticError(missing.map((type) => compilerDiagnostic({
      phase: "validate",
      code: "catalog.unknown_node_type",
      message: `Node type "${type}" is not in the active catalog.`,
      path: "/requestedNodeTypes",
      hint: "Choose a node type from the active catalog slice.",
    })));
  }

  const task = (input.task ?? "").normalize("NFKC").toLocaleLowerCase("en-US");
  const scores = new Map<string, number>();
  const taskScores = new Map<string, number>();
  for (const contract of catalog.contracts()) {
    let taskScore = 0;
    for (const term of contract.searchTerms ?? []) {
      if (task.includes(term.toLocaleLowerCase("en-US"))) taskScore += 200 + term.length;
    }
    if (task.includes(contract.type.toLocaleLowerCase("en-US"))) taskScore += 500;
    if (taskScore > 0) taskScores.set(contract.type, taskScore);
  }
  const hasTaskMatch = taskScores.size > 0;
  for (const contract of catalog.contracts()) {
    let score = 0;
    if (foundationTypes.has(contract.type)) score += 40;
    if (requested.length) {
      if (requested.includes(contract.type)) score += 10_000;
    } else if (hasTaskMatch) {
      score += taskScores.get(contract.type) ?? 0;
    } else if (contract.profiles.includes(profile)) {
      score += 20;
    }
    if (score > 0) scores.set(contract.type, score);
  }

  const selected = new Set<string>();
  const ranked = catalog.contracts().filter((contract) => scores.has(contract.type)).sort(
    (left, right) => (scores.get(right.type)! - scores.get(left.type)!) || left.type.localeCompare(right.type),
  );
  for (const contract of ranked) {
    if (selected.size >= maxNodeTypes) break;
    selected.add(contract.type);
  }

  const addDependencies = (type: string): void => {
    const contract = catalog.get(type)!;
    for (const dependency of [...(contract.dependencies ?? [])].sort()) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        addDependencies(dependency);
      }
    }
  };
  for (const type of [...selected]) addDependencies(type);

  if (selected.size > maxNodeTypes || requested.some((type) => !selected.has(type))) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "validate",
      code: "catalog.slice_limit_exceeded",
      message: "The requested node types and their dependencies exceed the catalog slice limit.",
      path: "/requestedNodeTypes",
      expected: maxNodeTypes,
      hint: "Increase maxNodeTypes or request a smaller surface.",
    })]);
  }

  const contracts = catalog.contracts().filter(({ type }) => selected.has(type));
  const sliceHash = hashJson({
    catalog: catalog.identity as unknown as JsonValue,
    contractFingerprint: catalog.contractFingerprint,
    nodeTypes: contracts.map(({ type, version }) => `${type}@${version}`),
  });
  return Object.freeze({
    catalog: catalog.identity,
    contractFingerprint: catalog.contractFingerprint,
    sliceHash,
    contracts: Object.freeze([...contracts]),
  });
}
