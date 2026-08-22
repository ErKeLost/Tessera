import {
  actionContractSchema,
  accessibilityContractSchema,
  catalogManifestInputSchema,
  componentContractDefinitionSchema,
  componentContractSchema,
  createActionContract,
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
  type ComponentContractDefinition,
  type SlotContract,
} from "@open-generative/catalog";
import {
  actionTypeSchema,
  catalogIdSchema,
  catalogRevisionSchema,
  jsonPointerSchema,
  publisherIdSchema,
  type ActionContractRef,
  type ContractRef,
  type HashProvider,
  type JSONSchema,
  type Sha256Hash,
} from "@open-generative/protocol";
import { z } from "zod";
import {
  chartCenterTextResolvedValueSchema,
  resolvedChartDataSchema,
  resolvedChartInteractionStateSchema,
} from "./chart-spec";
import {
  contentCalloutPropsSchema,
  contentEmptyPropsSchema,
  contentTextPropsSchema,
  controlFilterOptionSchema,
  controlFilterPropsSchema,
  controlGroupPropsSchema,
  dataChartPropsSchema,
  dataMetricPropsSchema,
  dataQueryDetailsPropsSchema,
  dataTablePropsSchema,
  layoutGridPropsSchema,
  layoutSectionPropsSchema,
  layoutStackPropsSchema,
  resolvedQueryDetailsSchema,
  resolvedTableDataSchema,
} from "./props";
import {
  resourceBindingExprSchema,
  scalarLiteralExprSchema,
  scalarValueExprSchema,
  stateBindingExprSchema,
  toStrictJsonSchema,
  deepFreeze,
} from "./schema";
import { hashNamespacedCanonical } from "./integrity";

export const OFFICIAL_PUBLISHER = publisherIdSchema.parse("open-generative");
export const OFFICIAL_CATALOG_ID = catalogIdSchema.parse("official");
export const OFFICIAL_CATALOG_REVISION = catalogRevisionSchema.parse("0.3.11");
export const OFFICIAL_CONTRACT_REVISION = 1 as const;

const emptyObjectSchema = z.object({}).strict();
const resolvedMetricValueSchema = z.union([z.null(), z.string().max(16_384), z.number().finite()]);
const resolvedFilterValueSchema = controlFilterPropsSchema.shape.value;
const resolvedFilterOptionsSchema = z.array(controlFilterOptionSchema).max(256);
const authoringFilterOptionsSchema = z.union([
  z.array(controlFilterOptionSchema).max(256),
  resourceBindingExprSchema,
]);

const eventPayloads = Object.freeze({
  empty: toStrictJsonSchema(emptyObjectSchema),
  export: toStrictJsonSchema(z.object({ format: z.enum(["csv", "json", "xlsx"]) }).strict()),
  rowSelect: toStrictJsonSchema(z.object({ rowId: z.union([z.string().max(1_024), z.number().finite()]) }).strict()),
  sortChange: toStrictJsonSchema(z.object({
    column: z.string().min(1).max(256),
    direction: z.enum(["ascending", "descending"]),
  }).strict()),
  pageChange: toStrictJsonSchema(z.object({ page: z.number().int().nonnegative() }).strict()),
  chartSelect: toStrictJsonSchema(z.object({
    series: z.string().min(1).max(256).optional(),
    datum: z.union([z.string().max(1_024), z.number().finite()]).optional(),
  }).strict()),
  rangeChange: toStrictJsonSchema(z.object({ start: z.number().finite(), end: z.number().finite() }).strict()),
  legendToggle: toStrictJsonSchema(z.object({ series: z.string().min(1).max(256), visible: z.boolean() }).strict()),
  filterChange: toStrictJsonSchema(z.object({ filterId: z.string().min(1).max(128), value: resolvedFilterValueSchema }).strict()),
});

type OfficialActions = Readonly<{
  dataExport: ActionContract;
  surfaceRetry: ActionContract;
  controlApply: ActionContract;
}>;

export type OfficialComponents = Readonly<{
  layoutStack: ComponentContract;
  layoutGrid: ComponentContract;
  layoutSection: ComponentContract;
  contentText: ComponentContract;
  contentCallout: ComponentContract;
  contentEmpty: ComponentContract;
  dataMetric: ComponentContract;
  dataTable: ComponentContract;
  dataChart: ComponentContract;
  dataQueryDetails: ComponentContract;
  controlFilter: ComponentContract;
  controlGroup: ComponentContract;
}>;

export type OfficialCatalogBundle = Readonly<{
  actions: OfficialActions;
  actionContracts: readonly ActionContract[];
  components: OfficialComponents;
  componentContracts: readonly ComponentContract[];
  manifest: CatalogManifest;
}>;

async function createOfficialActions(provider?: HashProvider): Promise<OfficialActions> {
  const [dataExport, surfaceRetry, controlApply] = await Promise.all([
    createActionContract({
      ref: officialActionIdentity("data.export"),
      normalizedInputSchema: toStrictJsonSchema(z.object({
        bindingId: z.string().min(1).max(256),
        format: z.enum(["csv", "json", "xlsx"]),
      }).strict()),
      resultSchema: toStrictJsonSchema(z.object({
        downloadId: z.string().min(1).max(256),
        expiresAt: z.iso.datetime({ offset: true }),
      }).strict()),
      receiptSchema: toStrictJsonSchema(z.object({
        contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        rowCount: z.number().int().nonnegative().optional(),
      }).strict()),
      reads: [{ source: "resource", required: true }],
      writes: [],
      effectClass: "read",
      risk: "low",
      idempotencyScope: "actor",
      cancellableUntil: "before-effect",
      timeoutPolicy: { timeoutMs: 60_000 },
      retryPolicy: { maxAttempts: 2, backoff: "fixed", initialDelayMs: 250 },
    }, provider),
    createActionContract({
      ref: officialActionIdentity("surface.retry"),
      normalizedInputSchema: toStrictJsonSchema(z.object({
        target: z.enum(["component", "resource", "surface"]),
        targetId: z.string().min(1).max(256),
      }).strict()),
      resultSchema: toStrictJsonSchema(z.object({ accepted: z.boolean() }).strict()),
      receiptSchema: toStrictJsonSchema(z.object({ attempt: z.number().int().positive() }).strict()),
      reads: [{ source: "resource", required: false }],
      writes: [],
      effectClass: "read",
      risk: "low",
      idempotencyScope: "surface",
      cancellableUntil: "before-dispatch",
      timeoutPolicy: { timeoutMs: 30_000 },
      retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
    }, provider),
    createActionContract({
      ref: officialActionIdentity("control.apply"),
      normalizedInputSchema: toStrictJsonSchema(z.object({
        groupId: z.string().min(1).max(256),
        stateIds: z.array(z.string().min(1).max(256)).min(1).max(64),
      }).strict()),
      resultSchema: toStrictJsonSchema(z.object({ applied: z.boolean() }).strict()),
      receiptSchema: toStrictJsonSchema(z.object({ stateRevision: z.string().min(1).max(256) }).strict()),
      reads: [{ source: "state", required: true }],
      writes: [{ target: "state", operation: "apply" }],
      effectClass: "reversible-write",
      risk: "low",
      idempotencyScope: "surface",
      cancellableUntil: "before-effect",
      timeoutPolicy: { timeoutMs: 10_000 },
      retryPolicy: { maxAttempts: 1, backoff: "none", initialDelayMs: 0 },
    }, provider),
  ]);
  return deepFreeze({ dataExport, surfaceRetry, controlApply });
}

export async function createOfficialCatalog(provider?: HashProvider): Promise<OfficialCatalogBundle> {
  const actions = await createOfficialActions(provider);
  const schemaHashes = await createResourceSchemaHashes(provider);

  const contentText = await createOfficialComponent({
    componentType: "content.text",
    category: "content",
    resolvedPropsSchema: toStrictJsonSchema(contentTextPropsSchema),
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("generic", propertyName("/text"), [], "none"),
    prompt: prompt("Plain semantic text without executable markup.", ["Use for short headings, body copy, captions, or code text."], ["Do not use for structured data or interactive controls."]),
  }, provider);

  const controlFilter = await createOfficialComponent({
    componentType: "control.filter",
    category: "control",
    resolvedPropsSchema: toStrictJsonSchema(controlFilterPropsSchema),
    authoringBindings: {
      "/value": statePolicy(toStrictJsonSchema(stateBindingExprSchema), toStrictJsonSchema(resolvedFilterValueSchema), true),
      "/options": resourcePolicy({
        canonicalExprSchema: toStrictJsonSchema(authoringFilterOptionsSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedFilterOptionsSchema),
        schemaHash: schemaHashes.filterOptions,
        resourceSchema: toStrictJsonSchema(resolvedFilterOptionsSchema),
        allowedSources: ["literal", "resource"],
        readiness: "optional",
        unresolvedFallback: "omit",
        kinds: ["dataset"],
        maxProjectedColumns: 2,
        maxWindowItems: 256,
      }),
    },
    events: {
      change: event(eventPayloads.filterChange),
      apply: event(eventPayloads.empty, [actions.controlApply.ref]),
      reset: event(eventPayloads.empty),
    },
    trust: "governed",
    commitPolicy: "atomic",
    requiredBindings: ["/value"],
    accessibility: accessibility("form", propertyName("/label"), ["edit"], "none"),
    prompt: prompt("A state-bound, policy-limited data filter.", ["Use when the user needs to refine a data view."], ["Do not invent filter options that are not offered by the host."]),
  }, provider);

  const controlGroup = await createOfficialComponent({
    componentType: "control.group",
    category: "control",
    resolvedPropsSchema: toStrictJsonSchema(controlGroupPropsSchema),
    slots: { controls: slot([controlFilter.ref], 1, 16, "placeholder") },
    events: {
      apply: event(eventPayloads.empty, [actions.controlApply.ref]),
      reset: event(eventPayloads.empty),
    },
    trust: "governed",
    commitPolicy: "atomic",
    accessibility: accessibility("form", { kind: "host", key: "component-label" }, ["edit"], "none"),
    prompt: prompt("A semantic fieldset for related controls.", ["Use to group filters that apply to the same data view."], ["Do not place display-only content in this slot."]),
  }, provider);

  const contentCallout = await createOfficialComponent({
    componentType: "content.callout",
    category: "content",
    resolvedPropsSchema: toStrictJsonSchema(contentCalloutPropsSchema),
    slots: { actions: slot([controlGroup.ref], 0, 1, "omit") },
    events: { dismiss: event(eventPayloads.empty) },
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("status", propertyName("/body"), ["dismiss"], "none", "polite"),
    prompt: prompt("A bounded insight, limitation, warning, or critical message.", ["Use when information needs semantic emphasis."], ["Do not use as a generic visual container."]),
  }, provider);

  const contentEmpty = await createOfficialComponent({
    componentType: "content.empty",
    category: "content",
    resolvedPropsSchema: toStrictJsonSchema(contentEmptyPropsSchema),
    slots: { actions: slot([controlGroup.ref], 0, 1, "omit") },
    events: { retry: event(eventPayloads.empty, [actions.surfaceRetry.ref]) },
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("status", propertyName("/title"), ["activate"], "none", "polite"),
    prompt: prompt("An explicit no-data, filtered, unavailable, or unconfigured state.", ["Use instead of fabricating data when a result is empty."], ["Do not imply retry is available unless the host action is offered."]),
  }, provider);

  const dataQueryDetails = await createOfficialComponent({
    componentType: "data.query-details",
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataQueryDetailsPropsSchema),
    authoringBindings: {
      "/details": resourcePolicy({
        canonicalExprSchema: toStrictJsonSchema(resourceBindingExprSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedQueryDetailsSchema),
        schemaHash: schemaHashes.queryDetails,
        resourceSchema: toStrictJsonSchema(resolvedQueryDetailsSchema),
        allowedSources: ["resource"],
        readiness: "required",
        unresolvedFallback: "loading",
        kinds: ["record"],
        maxProjectedColumns: 32,
        maxWindowItems: 1,
      }),
    },
    slots: { actions: slot([controlGroup.ref], 0, 1, "omit") },
    events: {
      copy: event(eventPayloads.empty),
      export: event(eventPayloads.export, [actions.dataExport.ref]),
    },
    trust: "governed",
    commitPolicy: "atomic",
    requiredBindings: ["/details"],
    accessibility: accessibility("region", { kind: "host", key: "component-label" }, ["navigate", "activate"], "none"),
    prompt: prompt("A policy-controlled inspection surface for query metadata and evidence.", ["Use to expose query, lineage, freshness, and evidence details."], ["Do not include SQL or lineage when the resolved resource omits it."]),
  }, provider);

  const dataMetric = await createOfficialComponent({
    componentType: "data.metric",
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataMetricPropsSchema),
    authoringBindings: {
      "/value": resourceAndStatePolicy({
        canonicalExprSchema: toStrictJsonSchema(scalarValueExprSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedMetricValueSchema),
        schemaHash: schemaHashes.metric,
        resourceSchema: toStrictJsonSchema(resolvedMetricValueSchema),
      }),
      "/comparison/value": resourceAndStatePolicy({
        canonicalExprSchema: toStrictJsonSchema(scalarValueExprSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedMetricValueSchema),
        schemaHash: schemaHashes.metric,
        resourceSchema: toStrictJsonSchema(resolvedMetricValueSchema),
        readiness: "optional",
        unresolvedFallback: "omit",
      }),
    },
    slots: { details: slot([contentText.ref, dataQueryDetails.ref], 0, 1, "omit") },
    events: { select: event(eventPayloads.chartSelect) },
    trust: "governed",
    commitPolicy: "atomic",
    requiredBindings: ["/value"],
    accessibility: accessibility("group", propertyName("/label"), ["select"], "none", "polite"),
    prompt: prompt("A resource-backed scalar KPI with optional comparison.", ["Use for one primary measure or a tightly related comparison."], ["Do not use for a long record or unverified calculation."]),
  }, provider);

  const dataTable = await createOfficialComponent({
    componentType: "data.table",
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataTablePropsSchema),
    authoringBindings: {
      "/data": resourcePolicy({
        canonicalExprSchema: toStrictJsonSchema(resourceBindingExprSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedTableDataSchema),
        schemaHash: schemaHashes.table,
        resourceSchema: toStrictJsonSchema(resolvedTableDataSchema),
        allowedSources: ["resource"],
        readiness: "required",
        unresolvedFallback: "loading",
        kinds: ["dataset"],
        maxProjectedColumns: 256,
        maxWindowItems: 10_000,
        allowSort: true,
        maxSortKeys: 16,
      }),
      "/selection/state": statePolicy(toStrictJsonSchema(stateBindingExprSchema), { type: "array", maxItems: 10_000 }, false),
      "/sort/state": statePolicy(toStrictJsonSchema(stateBindingExprSchema), { type: "array", maxItems: 16 }, false),
    },
    slots: { toolbar: slot([controlGroup.ref], 0, 1, "omit") },
    events: {
      export: event(eventPayloads.export, [actions.dataExport.ref]),
      rowSelect: event(eventPayloads.rowSelect),
      sortChange: event(eventPayloads.sortChange),
      pageChange: event(eventPayloads.pageChange),
    },
    trust: "governed",
    commitPolicy: "atomic",
    requiredBindings: ["/data"],
    accessibility: accessibility("table", { kind: "host", key: "component-label" }, ["navigate", "select"], "none"),
    prompt: prompt("A windowed, resource-backed data table.", ["Use when exact rows and columns matter."], ["Do not inline dataset rows or request unavailable columns."]),
  }, provider);

  const dataChart = await createOfficialComponent({
    componentType: "data.chart",
    category: "data",
    resolvedPropsSchema: toStrictJsonSchema(dataChartPropsSchema),
    authoringBindings: {
      "/spec/data": resourcePolicy({
        canonicalExprSchema: toStrictJsonSchema(resourceBindingExprSchema),
        resolvedValueSchema: toStrictJsonSchema(resolvedChartDataSchema),
        schemaHash: schemaHashes.chart,
        resourceSchema: toStrictJsonSchema(resolvedChartDataSchema),
        allowedSources: ["resource"],
        readiness: "required",
        unresolvedFallback: "loading",
        kinds: ["dataset"],
        maxProjectedColumns: 32,
        maxWindowItems: 10_000,
      }),
      "/spec/legend/visibilityState": statePolicy(
        toStrictJsonSchema(stateBindingExprSchema),
        toStrictJsonSchema(resolvedChartInteractionStateSchema),
        false,
      ),
      "/spec/interaction/state": statePolicy(
        toStrictJsonSchema(stateBindingExprSchema),
        toStrictJsonSchema(resolvedChartInteractionStateSchema),
        false,
      ),
      "/spec/centerText/value": literalOrStatePolicy(
        toStrictJsonSchema(z.union([scalarLiteralExprSchema, stateBindingExprSchema])),
        toStrictJsonSchema(chartCenterTextResolvedValueSchema),
        false,
      ),
    },
    slots: { toolbar: slot([controlGroup.ref], 0, 1, "omit") },
    events: {
      select: event(eventPayloads.chartSelect),
      rangeChange: event(eventPayloads.rangeChange),
      legendToggle: event(eventPayloads.legendToggle),
    },
    trust: "governed",
    commitPolicy: "atomic",
    requiredBindings: ["/spec/data"],
    accessibility: accessibility("img", propertyName("/spec/accessibility/label"), ["navigate", "select"], "host-required"),
    prompt: prompt("A strict, resource-backed semantic chart specification.", ["Use for area, bar, line, pie, radar, or radial views when visual comparison adds value."], ["Do not provide inline data, renderer props, raw colors, functions, markup, or vector content."]),
  }, provider);

  const sectionChildren = [
    contentText.ref,
    contentCallout.ref,
    contentEmpty.ref,
    controlGroup.ref,
    dataMetric.ref,
    dataTable.ref,
    dataChart.ref,
    dataQueryDetails.ref,
  ];
  const layoutSection = await createOfficialComponent({
    componentType: "layout.section",
    category: "layout",
    resolvedPropsSchema: toStrictJsonSchema(layoutSectionPropsSchema),
    slots: { children: slot(sectionChildren, 1, 64, "placeholder") },
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("region", { kind: "host", key: "component-label" }, [], "none"),
    prompt: prompt("A titled semantic section with ordered content.", ["Use to group a coherent part of an analysis."], ["Do not use as visual decoration or nest arbitrary sections."]),
  }, provider);

  const gridChildren = [layoutSection.ref, ...sectionChildren];
  const layoutGrid = await createOfficialComponent({
    componentType: "layout.grid",
    category: "layout",
    resolvedPropsSchema: toStrictJsonSchema(layoutGridPropsSchema),
    slots: { children: slot(gridChildren, 1, 64, "placeholder") },
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("group", { kind: "host", key: "component-label" }, [], "none"),
    prompt: prompt("A responsive comparison grid with semantic sizing tokens.", ["Use for comparable metrics or views that benefit from columns."], ["Do not use when reading order would become ambiguous."]),
  }, provider);

  const layoutStack = await createOfficialComponent({
    componentType: "layout.stack",
    category: "layout",
    resolvedPropsSchema: toStrictJsonSchema(layoutStackPropsSchema),
    slots: { children: slot([layoutGrid.ref, layoutSection.ref, ...sectionChildren], 1, 128, "placeholder") },
    trust: "safe",
    commitPolicy: "progressive",
    accessibility: accessibility("group", { kind: "host", key: "component-label" }, [], "none"),
    prompt: prompt("The default ordered reading flow for a generated surface.", ["Use as the normal root for multi-part content."], ["Do not use to imply unrelated content is a single section."]),
  }, provider);

  const components = deepFreeze({
    layoutStack,
    layoutGrid,
    layoutSection,
    contentText,
    contentCallout,
    contentEmpty,
    dataMetric,
    dataTable,
    dataChart,
    dataQueryDetails,
    controlFilter,
    controlGroup,
  });
  const componentContracts = Object.values(components);
  const actionContracts = Object.values(actions);
  const manifest = await createCatalogManifest(catalogManifestInputSchema.parse({
    ref: {
      publisher: OFFICIAL_PUBLISHER,
      catalogId: OFFICIAL_CATALOG_ID,
      catalogRevision: OFFICIAL_CATALOG_REVISION,
    },
    dependencies: [],
    components: componentContracts.map((contract) => contract.ref),
    actions: actionContracts.map((contract) => contract.ref),
  }), provider);

  return deepFreeze({ actions, actionContracts, components, componentContracts, manifest });
}

type CreateComponentInput = Readonly<{
  componentType: string;
  category: "layout" | "content" | "control" | "data";
  resolvedPropsSchema: JSONSchema;
  authoringBindings?: Record<string, BindingPolicy>;
  slots?: Record<string, SlotContract>;
  events?: Record<string, { payloadSchema: JSONSchema; actionContracts: ActionContractRef[] }>;
  trust: "safe" | "governed";
  commitPolicy: "progressive" | "atomic";
  requiredBindings?: string[];
  accessibility: ComponentContractDefinition["accessibility"];
  prompt: ComponentContractDefinition["prompt"];
}>;

async function createOfficialComponent(input: CreateComponentInput, provider?: HashProvider) {
  return createComponentContract(componentContractDefinitionSchema.parse({
    ref: {
      publisher: OFFICIAL_PUBLISHER,
      catalogId: OFFICIAL_CATALOG_ID,
      componentType: input.componentType,
      revision: OFFICIAL_CONTRACT_REVISION,
    },
    category: input.category,
    resolvedPropsSchema: input.resolvedPropsSchema,
    authoringBindings: input.authoringBindings ?? {},
    slots: input.slots ?? {},
    events: input.events ?? {},
    trust: input.trust,
    commitPolicy: input.commitPolicy,
    readiness: {
      strategy: input.requiredBindings?.length ? "all-required" : "first-meaningful",
      requiredBindings: input.requiredBindings ?? [],
      pendingFallback: input.commitPolicy === "atomic" ? "loading" : "placeholder",
      failureFallback: "error",
    },
    placements: [
      { kind: "fullscreen", minWidth: 320 },
      { kind: "inline", minWidth: 160 },
      { kind: "panel", minWidth: 240 },
      { kind: "sheet", minWidth: 280 },
    ],
    accessibility: input.accessibility,
    prompt: input.prompt,
    migrations: [],
  }), provider);
}

function officialActionIdentity(actionType: string) {
  return {
    publisher: OFFICIAL_PUBLISHER,
    catalogId: OFFICIAL_CATALOG_ID,
    actionType: actionTypeSchema.parse(actionType),
    revision: OFFICIAL_CONTRACT_REVISION,
  } as const;
}

function propertyName(path: string): ComponentContractDefinition["accessibility"]["accessibleName"] {
  return { kind: "prop", path: jsonPointerSchema.parse(path) };
}

function event(payloadSchema: JSONSchema, actionContracts: ActionContractRef[] = []) {
  return { payloadSchema, actionContracts };
}

function slot(contracts: ContractRef[], min: number, max: number, fallback: SlotContract["fallback"]): SlotContract {
  return {
    accepts: contracts
      .map((contract) => ({ kind: "contract" as const, contract }))
      .sort((left, right) => contractRefKey(left.contract).localeCompare(contractRefKey(right.contract))),
    min,
    max,
    fallback,
  };
}

function prompt(summary: string, useWhen: string[], avoidWhen: string[]): ComponentContractDefinition["prompt"] {
  return { summary, useWhen, avoidWhen, examples: [] };
}

function accessibility(
  semanticRole: ComponentContractDefinition["accessibility"]["semanticRole"],
  accessibleName: ComponentContractDefinition["accessibility"]["accessibleName"],
  keyboardInteractions: ComponentContractDefinition["accessibility"]["keyboardInteractions"],
  equivalentView: ComponentContractDefinition["accessibility"]["equivalentView"],
  liveRegion: ComponentContractDefinition["accessibility"]["liveRegion"] = "off",
): ComponentContractDefinition["accessibility"] {
  return accessibilityContractSchema.parse({
    semanticRole,
    accessibleName,
    keyboardInteractions: [...keyboardInteractions].sort(),
    liveRegion,
    equivalentView,
  });
}

type ResourcePolicyInput = Readonly<{
  canonicalExprSchema: JSONSchema;
  resolvedValueSchema: JSONSchema;
  schemaHash: Sha256Hash;
  resourceSchema: JSONSchema;
  allowedSources: Array<"literal" | "state" | "resource" | "context">;
  readiness: "required" | "optional" | "deferred";
  unresolvedFallback: "omit" | "loading" | "empty" | "error";
  kinds: Array<"dataset" | "record" | "document" | "asset">;
  maxProjectedColumns: number;
  maxWindowItems: number;
  allowSort?: boolean;
  maxSortKeys?: number;
}>;

function resourcePolicy(input: ResourcePolicyInput): BindingPolicy {
  const allowSort = input.allowSort ?? false;
  return {
    allowedSources: input.allowedSources,
    canonicalExprSchema: input.canonicalExprSchema,
    resolvedValueSchema: input.resolvedValueSchema,
    nullable: false,
    readiness: input.readiness,
    unresolvedFallback: input.unresolvedFallback,
    resource: {
      kinds: input.kinds,
      schemaConstraints: [{ schemaHash: input.schemaHash, resolvedSchema: input.resourceSchema }],
      selector: {
        allowProjection: true,
        maxProjectedColumns: input.maxProjectedColumns,
        allowFilterState: true,
        allowSort,
        maxSortKeys: input.maxSortKeys ?? 0,
        maxWindowItems: input.maxWindowItems,
      },
      maxSensitivity: "confidential",
    },
  };
}

function statePolicy(
  canonicalExprSchema: JSONSchema,
  resolvedValueSchema: JSONSchema,
  required: boolean,
): BindingPolicy {
  return {
    allowedSources: ["state"],
    canonicalExprSchema,
    resolvedValueSchema,
    nullable: !required,
    readiness: required ? "required" : "optional",
    unresolvedFallback: required ? "error" : "omit",
    state: { schema: resolvedValueSchema, readableScopes: ["document", "external", "surface"] },
  };
}

function literalOrStatePolicy(
  canonicalExprSchema: JSONSchema,
  resolvedValueSchema: JSONSchema,
  required: boolean,
): BindingPolicy {
  return {
    allowedSources: ["literal", "state"],
    canonicalExprSchema,
    resolvedValueSchema,
    nullable: !required,
    readiness: required ? "required" : "optional",
    unresolvedFallback: required ? "error" : "omit",
    state: { schema: resolvedValueSchema, readableScopes: ["document", "external", "surface"] },
  };
}

function resourceAndStatePolicy(input: Readonly<{
  canonicalExprSchema: JSONSchema;
  resolvedValueSchema: JSONSchema;
  schemaHash: Sha256Hash;
  resourceSchema: JSONSchema;
  readiness?: "required" | "optional";
  unresolvedFallback?: "omit" | "loading";
}>): BindingPolicy {
  const readiness = input.readiness ?? "required";
  return {
    ...resourcePolicy({
      canonicalExprSchema: input.canonicalExprSchema,
      resolvedValueSchema: input.resolvedValueSchema,
      schemaHash: input.schemaHash,
      resourceSchema: input.resourceSchema,
      allowedSources: ["literal", "resource", "state"],
      readiness,
      unresolvedFallback: input.unresolvedFallback ?? "loading",
      kinds: ["dataset", "record"],
      maxProjectedColumns: 32,
      maxWindowItems: 10_000,
    }),
    state: { schema: input.resolvedValueSchema, readableScopes: ["document", "external", "surface"] },
  };
}

async function createResourceSchemaHashes(provider?: HashProvider) {
  const schemas = {
    metric: toStrictJsonSchema(resolvedMetricValueSchema),
    table: toStrictJsonSchema(resolvedTableDataSchema),
    chart: toStrictJsonSchema(resolvedChartDataSchema),
    queryDetails: toStrictJsonSchema(resolvedQueryDetailsSchema),
    filterOptions: toStrictJsonSchema(resolvedFilterOptionsSchema),
  } as const;
  const entries = await Promise.all(Object.entries(schemas).map(async ([key, schema]) => [
    key,
    await hashNamespacedCanonical("open-generative.resource-schema", schema, provider),
  ] as const));
  return Object.fromEntries(entries) as { [K in keyof typeof schemas]: Sha256Hash };
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
  components: z.array(verifiedComponentViewSchema).length(12),
  actions: z.array(verifiedActionViewSchema).length(3),
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
