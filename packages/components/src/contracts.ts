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
import { resourceDatasetPayloadSchema } from "@open-generative/protocol";
import { dataChartPropsSchema } from "./props";
import { resourceBindingExprSchema, toStrictJsonSchema, deepFreeze } from "./schema";
import { hashNamespacedCanonical } from "./integrity";

export const OFFICIAL_PUBLISHER = publisherIdSchema.parse("open-generative");
export const OFFICIAL_CATALOG_ID = catalogIdSchema.parse("official");
export const OFFICIAL_CATALOG_REVISION = catalogRevisionSchema.parse("0.3.19");
export const OFFICIAL_CONTRACT_REVISION = 1 as const;

export type OfficialActions = Readonly<Record<never, never>>;
export type OfficialComponents = Readonly<{ dataChart: ComponentContract }>;

export type OfficialCatalogBundle = Readonly<{
  actions: OfficialActions;
  actionContracts: readonly ActionContract[];
  components: OfficialComponents;
  componentContracts: readonly ComponentContract[];
  manifest: CatalogManifest;
}>;

export async function createOfficialCatalog(provider?: HashProvider): Promise<OfficialCatalogBundle> {
  const resolvedDatasetJsonSchema = toStrictJsonSchema(resourceDatasetPayloadSchema);
  const resourceSchemaHash = await hashNamespacedCanonical(
    "open-generative.resource-schema",
    resolvedDatasetJsonSchema,
    provider,
  );
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
    slots: {},
    events: {},
    trust: "governed",
    commitPolicy: "atomic",
    readiness: {
      strategy: "all-required",
      requiredBindings: [jsonPointerSchema.parse("/spec/data")],
      pendingFallback: "loading",
      failureFallback: "error",
    },
    placements: [
      { kind: "fullscreen", minWidth: 320 },
      { kind: "inline", minWidth: 160 },
      { kind: "panel", minWidth: 240 },
      { kind: "sheet", minWidth: 280 },
    ],
    accessibility: {
      semanticRole: "img",
      accessibleName: { kind: "prop", path: jsonPointerSchema.parse("/spec/accessibility/label") },
      description: { kind: "prop", path: jsonPointerSchema.parse("/spec/accessibility/description") },
      keyboardInteractions: ["navigate"],
      liveRegion: "off",
      equivalentView: "host-required",
    },
    prompt: {
      summary: "A strict resource-backed data chart described with semantic marks and encodings.",
      useWhen: ["Use when a governed dataset benefits from a bar, line, area, scatter, pie, or radar comparison."],
      avoidWhen: ["Do not provide inline rows, colors, CSS, callbacks, React props, or SVG markup."],
      examples: [],
    },
    migrations: [],
  }), provider);

  const components = deepFreeze({ dataChart });
  const componentContracts = deepFreeze([dataChart]);
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
  components: z.array(verifiedComponentViewSchema).length(1),
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
