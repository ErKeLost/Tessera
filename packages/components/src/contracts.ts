import {
  actionContractSchema,
  catalogManifestInputSchema,
  componentContractDefinitionSchema,
  componentContractSchema,
  createCatalogManifest,
  createComponentContract,
  verifyActionContract,
  verifyCatalogManifest,
  verifyComponentContract,
  actionContractRefKey,
  contractRefKey,
  type ActionContract,
  type BindingPolicy,
  type CatalogManifest,
  type ComponentContract,
} from "@open-generative/catalog";
import {
  catalogIdSchema,
  catalogRevisionSchema,
  jsonPointerSchema,
  publisherIdSchema,
  type HashProvider,
  type JSONSchema,
  type Sha256Hash,
} from "@open-generative/protocol";
import { z } from "zod";
import { resolvedChartDataSchema } from "./chart-spec";
import { dataChartPropsSchema } from "./props";
import {
  analysisInsightPropsSchema,
  analysisReportPropsSchema,
  dataMetricAuthoringPropsSchema,
  dataMetricPropsSchema,
  layoutGridPropsSchema,
  layoutStackPropsSchema,
} from "./generative-spec";
import { resourceBindingExprSchema, toStrictJsonSchema, deepFreeze } from "./schema";
import { hashNamespacedCanonical } from "./integrity";

export const OFFICIAL_PUBLISHER = publisherIdSchema.parse("open-generative");
export const OFFICIAL_CATALOG_ID = catalogIdSchema.parse("official");
export const OFFICIAL_CATALOG_REVISION = catalogRevisionSchema.parse("0.3.21");
export const OFFICIAL_CONTRACT_REVISION = 1 as const;

export type OfficialActions = Readonly<Record<never, never>>;
export type OfficialComponents = Readonly<{
  dataChart: ComponentContract;
  dataMetric: ComponentContract;
  analysisInsight: ComponentContract;
  layoutStack: ComponentContract;
  layoutGrid: ComponentContract;
  analysisReport: ComponentContract;
}>;

export type OfficialCatalogBundle = Readonly<{
  actions: OfficialActions;
  actionContracts: readonly ActionContract[];
  components: OfficialComponents;
  componentContracts: readonly ComponentContract[];
  manifest: CatalogManifest;
}>;

export async function createOfficialCatalog(provider?: HashProvider): Promise<OfficialCatalogBundle> {
  const resolvedDatasetJsonSchema = toStrictJsonSchema(resolvedChartDataSchema);
  const resourceSchemaHash = await hashNamespacedCanonical(
    "open-generative.resource-schema",
    resolvedDatasetJsonSchema,
    provider,
  );
  const base = {
    trust: "governed" as const,
    commitPolicy: "atomic" as const,
    readiness: {
      strategy: "all-required" as const,
      requiredBindings: [] as string[],
      pendingFallback: "loading" as const,
      failureFallback: "error" as const,
    },
    placements: [
      { kind: "fullscreen" as const, minWidth: 320 },
      { kind: "inline" as const, minWidth: 160 },
      { kind: "panel" as const, minWidth: 240 },
      { kind: "sheet" as const, minWidth: 280 },
    ],
    events: {},
    slots: {},
    migrations: [],
  };
  const dataChart = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: {
      publisher: OFFICIAL_PUBLISHER,
      catalogId: OFFICIAL_CATALOG_ID,
      componentType: "data.chart",
      revision: OFFICIAL_CONTRACT_REVISION,
    },
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataChartPropsSchema),
    authoringBindings: {
      "/spec/data": resourcePolicy(resolvedDatasetJsonSchema, resourceSchemaHash),
    },
    ...base,
    readiness: { ...base.readiness, requiredBindings: [jsonPointerSchema.parse("/spec/data")] },
    accessibility: {
      semanticRole: "img",
      accessibleName: { kind: "prop", path: jsonPointerSchema.parse("/spec/accessibility/label") },
      description: { kind: "prop", path: jsonPointerSchema.parse("/spec/accessibility/description") },
      keyboardInteractions: ["navigate"],
      liveRegion: "off",
      equivalentView: "host-required",
    },
    prompt: {
      summary: "A strict resource-backed chart selected from the official Data Chart recipe catalog.",
      useWhen: ["Use when a governed dataset benefits from one of the declared visual comparisons."],
      avoidWhen: ["Do not provide inline rows, colors, CSS, callbacks, React props, or SVG markup."],
      examples: [],
    },
  }), provider);
  const dataMetric = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: OFFICIAL_PUBLISHER, catalogId: OFFICIAL_CATALOG_ID, componentType: "data.metric", revision: OFFICIAL_CONTRACT_REVISION },
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataMetricPropsSchema),
    authoringBindings: { "/data": resourcePolicy(resolvedDatasetJsonSchema, resourceSchemaHash) },
    ...base,
    readiness: { ...base.readiness, requiredBindings: [jsonPointerSchema.parse("/data")] },
    accessibility: { semanticRole: "status", accessibleName: { kind: "prop", path: jsonPointerSchema.parse("/label") }, keyboardInteractions: [], liveRegion: "polite", equivalentView: "text-summary" },
    prompt: { summary: "A compact metric derived from a governed dataset.", useWhen: ["Use for a headline value or KPI."], avoidWhen: ["Do not inline data rows or formatting code."], examples: [] },
  }), provider);
  const analysisInsight = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: OFFICIAL_PUBLISHER, catalogId: OFFICIAL_CATALOG_ID, componentType: "analysis.insight", revision: OFFICIAL_CONTRACT_REVISION },
    category: "content",
    resolvedPropsSchema: toStrictJsonSchema(analysisInsightPropsSchema),
    authoringBindings: {},
    ...base,
    trust: "safe",
    accessibility: { semanticRole: "status", accessibleName: { kind: "prop", path: jsonPointerSchema.parse("/title") }, keyboardInteractions: [], liveRegion: "polite", equivalentView: "text-summary" },
    prompt: { summary: "A concise evidence-backed interpretation of the analysis.", useWhen: ["Use for a conclusion or caveat."], avoidWhen: ["Do not fabricate facts or cite unbound data."], examples: [] },
  }), provider);
  const childSelectors = (contracts: readonly ComponentContract[]) => contracts
    .map((contract) => ({ kind: "contract" as const, contract: contract.ref }))
    .sort((left, right) => left.contract.componentType.localeCompare(right.contract.componentType));
  const layoutStack = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: OFFICIAL_PUBLISHER, catalogId: OFFICIAL_CATALOG_ID, componentType: "layout.stack", revision: OFFICIAL_CONTRACT_REVISION },
    category: "layout",
    resolvedPropsSchema: toStrictJsonSchema(layoutStackPropsSchema),
    authoringBindings: {},
    ...base,
    slots: { body: { accepts: childSelectors([dataMetric, dataChart, analysisInsight]), min: 0, max: 100, fallback: "empty" } },
    accessibility: { semanticRole: "group", accessibleName: { kind: "host", key: "surface-label" }, keyboardInteractions: [], liveRegion: "off", equivalentView: "none" },
    prompt: { summary: "A vertical layout for analytical components.", useWhen: ["Use to stack metrics, charts, and insights."], avoidWhen: ["Do not nest arbitrary components."], examples: [] },
  }), provider);
  const layoutGrid = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: OFFICIAL_PUBLISHER, catalogId: OFFICIAL_CATALOG_ID, componentType: "layout.grid", revision: OFFICIAL_CONTRACT_REVISION },
    category: "layout",
    resolvedPropsSchema: toStrictJsonSchema(layoutGridPropsSchema),
    authoringBindings: {},
    ...base,
    slots: { body: { accepts: childSelectors([dataMetric, dataChart, analysisInsight]), min: 0, max: 100, fallback: "empty" } },
    accessibility: { semanticRole: "group", accessibleName: { kind: "host", key: "surface-label" }, keyboardInteractions: [], liveRegion: "off", equivalentView: "none" },
    prompt: { summary: "A responsive grid for comparing analytical components.", useWhen: ["Use for two or more peer metrics or charts."], avoidWhen: ["Do not use for a single child."], examples: [] },
  }), provider);
  const analysisReport = await createComponentContract(componentContractDefinitionSchema.parse({
    ref: { publisher: OFFICIAL_PUBLISHER, catalogId: OFFICIAL_CATALOG_ID, componentType: "analysis.report", revision: OFFICIAL_CONTRACT_REVISION },
    category: "content",
    resolvedPropsSchema: toStrictJsonSchema(analysisReportPropsSchema),
    authoringBindings: {},
    ...base,
    slots: { body: { accepts: childSelectors([layoutStack, layoutGrid]), min: 1, max: 1, fallback: "placeholder" } },
    accessibility: { semanticRole: "region", accessibleName: { kind: "prop", path: jsonPointerSchema.parse("/title") }, description: { kind: "prop", path: jsonPointerSchema.parse("/description") }, keyboardInteractions: [], liveRegion: "polite", equivalentView: "text-summary" },
    prompt: { summary: "A complete analytical report with a title and composed visual sections.", useWhen: ["Use as the root of a multi-part analysis response."], avoidWhen: ["Do not put raw rows or executable markup in the report."], examples: [] },
  }), provider);

  const components = deepFreeze({ dataChart, dataMetric, analysisInsight, layoutStack, layoutGrid, analysisReport });
  const componentContracts = deepFreeze([dataChart, dataMetric, analysisInsight, layoutStack, layoutGrid, analysisReport]);
  const actions = deepFreeze({}) as OfficialActions;
  const actionContracts = deepFreeze([]) as readonly ActionContract[];
  const manifest = await createCatalogManifest(catalogManifestInputSchema.parse({
    ref: {
      publisher: OFFICIAL_PUBLISHER,
      catalogId: OFFICIAL_CATALOG_ID,
      catalogRevision: OFFICIAL_CATALOG_REVISION,
    },
    dependencies: [],
    components: componentContracts.map((contract) => contract.ref),
    actions: [],
  }), provider);
  return deepFreeze({ actions, actionContracts, components, componentContracts, manifest });
}

function resourcePolicy(resolvedSchema: JSONSchema, schemaHash: Sha256Hash): BindingPolicy {
  return {
    allowedSources: ["resource"],
    canonicalExprSchema: toStrictJsonSchema(resourceBindingExprSchema),
    resolvedValueSchema: resolvedSchema,
    nullable: false,
    readiness: "required",
    unresolvedFallback: "loading",
    resource: {
      kinds: ["dataset"],
      schemaConstraints: [{ schemaHash, resolvedSchema }],
      selector: {
        allowProjection: true,
        maxProjectedColumns: 32,
        allowFilterState: true,
        allowSort: false,
        maxSortKeys: 0,
        maxWindowItems: 10_000,
      },
      maxSensitivity: "confidential",
    },
  };
}

const {
  authoringBindings: _componentAuthoringBindingsSchema,
  prompt: _componentPromptSchema,
  migrations: _componentMigrationsSchema,
  ...verifiedComponentViewShape
} = componentContractSchema.shape;

export const verifiedComponentViewSchema = z.object(verifiedComponentViewShape).strict();
export const verifiedActionViewSchema = actionContractSchema;
export const officialBrowserCatalogProjectionSchema = z.object({
  manifest: z.object({
    ref: z.object({
      publisher: z.string(),
      catalogId: z.string(),
      catalogRevision: z.string(),
      manifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      signatureRef: z.string().optional(),
    }).strict(),
    contractSetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
  components: z.array(verifiedComponentViewSchema).min(1),
  actions: z.array(verifiedActionViewSchema).length(0),
}).strict();

export type VerifiedComponentView = z.infer<typeof verifiedComponentViewSchema>;
export type OfficialBrowserCatalogProjection = z.infer<typeof officialBrowserCatalogProjectionSchema>;

export async function createOfficialBrowserCatalogProjection(
  bundle: OfficialCatalogBundle,
  provider?: HashProvider,
): Promise<OfficialBrowserCatalogProjection> {
  const [manifest, components, actions] = await Promise.all([
    verifyCatalogManifest(bundle.manifest, provider),
    Promise.all(bundle.componentContracts.map((contract) => verifyComponentContract(contract, provider))),
    Promise.all(bundle.actionContracts.map((contract) => verifyActionContract(contract, provider))),
  ]);
  const componentRefs = new Set(manifest.components.map(contractRefKey));
  const actionRefs = new Set(manifest.actions.map(actionContractRefKey));
  if (components.some((contract) => !componentRefs.has(contractRefKey(contract.ref)))) {
    throw new Error("A verified component is not owned by the official manifest.");
  }
  if (actions.some((contract) => !actionRefs.has(actionContractRefKey(contract.ref)))) {
    throw new Error("A verified action is not owned by the official manifest.");
  }
  return deepFreeze(officialBrowserCatalogProjectionSchema.parse({
    manifest: { ref: manifest.ref, contractSetHash: manifest.contractSetHash },
    components: components.map(({ authoringBindings: _bindings, prompt: _prompt, migrations: _migrations, ...view }) => view),
    actions,
  }));
}
