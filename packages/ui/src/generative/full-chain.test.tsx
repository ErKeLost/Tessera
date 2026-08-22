import { describe, expect, test } from "bun:test";
import {
  SurfaceController,
  createBrowserContractRegistry,
  createZodClientValidator,
  type ClientValueValidator,
} from "@open-generative/client";
import {
  contentCalloutPropsSchema,
  contentEmptyPropsSchema,
  contentTextPropsSchema,
  controlFilterPropsSchema,
  controlGroupPropsSchema,
  createOfficialCatalog,
  createOfficialRendererRelease,
  createSingleChunkOfficialRendererArtifactSet,
  dataChartPropsSchema,
  dataMetricPropsSchema,
  dataQueryDetailsPropsSchema,
  dataTablePropsSchema,
  layoutGridPropsSchema,
  layoutSectionPropsSchema,
  layoutStackPropsSchema,
  officialChartSpecFixtures,
  officialComponentFixtures,
  officialComponentTypeSchema,
  resolvedChartSpecSchema,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import { contractRefKey, type ComponentContract } from "@open-generative/catalog";
import {
  GenerativeSurface,
} from "@open-generative/react";
import {
  HASH_DOMAINS,
  OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
  OPEN_GENERATIVE_HASH_PROFILE_ID,
  OPEN_GENERATIVE_PROTOCOL_REVISION,
  OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
  committedRevisionSchema,
  documentContentSchema,
  hashCanonical,
  hashDocumentContent,
  jsonValueSchema,
  sha256HashSchema,
  surfaceSessionIdSchema,
  surfaceEventEnvelopeSchema,
  surfaceSnapshotSchema,
  type JsonObject,
  type JsonValue,
  type ValueExpr,
} from "@open-generative/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { createVerifiedOfficialRendererRegistry } from "./registry";

const AUDIENCE_HASH = sha256HashSchema.parse(`sha256:${"7".repeat(64)}`);
const SURFACE_ID = surfaceSessionIdSchema.parse("surface-ui-full-chain");
const RELEASE_CHUNK_HASH = sha256HashSchema.parse(`sha256:${"8".repeat(64)}`);
const RELEASE_STYLES_HASH = sha256HashSchema.parse(`sha256:${"9".repeat(64)}`);
const resolvedPropsSchemas = {
  "content.callout": contentCalloutPropsSchema,
  "content.empty": contentEmptyPropsSchema,
  "content.text": contentTextPropsSchema,
  "control.filter": controlFilterPropsSchema,
  "control.group": controlGroupPropsSchema,
  "data.chart": dataChartPropsSchema,
  "data.metric": dataMetricPropsSchema,
  "data.query-details": dataQueryDetailsPropsSchema,
  "data.table": dataTablePropsSchema,
  "layout.grid": layoutGridPropsSchema,
  "layout.section": layoutSectionPropsSchema,
  "layout.stack": layoutStackPropsSchema,
} as const;

const chartData = {
  columns: [
    { columnId: "month", label: "Month", valueType: "date" },
    { columnId: "revenue", label: "Revenue", valueType: "number" },
    { columnId: "cost", label: "Cost", valueType: "number" },
    { columnId: "channel", label: "Channel", valueType: "string" },
    { columnId: "dimension", label: "Dimension", valueType: "string" },
  ],
  rows: [
    { month: "2026-05-01", revenue: 120, cost: 74, channel: "Direct", dimension: "Speed" },
    { month: "2026-06-01", revenue: -36, cost: 81, channel: "Partner", dimension: "Quality" },
    { month: "2026-07-01", revenue: 154, cost: 96, channel: "Search", dimension: "Coverage" },
  ],
  totalRows: 3,
};

describe("official full render chain", () => {
  test("renders all 12 official contracts through SurfaceController, GenerativeSurface, and the verified registry", async () => {
    const harness = await createHarness();
    for (const [index, fixture] of officialComponentFixtures.entries()) {
      const html = await renderFixtureThroughSurface(
        harness,
        fixture.componentType,
        asObject(fixture.resolvedProps),
        `component-${index + 1}`,
      ).catch((cause: unknown) => {
        throw new Error(`Full-chain render failed for ${fixture.componentType}.`, { cause });
      });
      expect(html).toContain(`data-og-component="${fixture.componentType}"`);
      expect(html).not.toContain("data-open-generative-system");
    }
  });

  test("renders every one of the 70 chart and tooltip recipes through the complete trusted chain", async () => {
    const harness = await createHarness();
    expect(officialChartSpecFixtures).toHaveLength(70);
    for (const [index, fixture] of officialChartSpecFixtures.entries()) {
      const spec = resolvedChartSpecSchema.parse(resolveChartFixture(fixture.spec));
      const html = await renderFixtureThroughSurface(
        harness,
        "data.chart",
        { spec } as unknown as JsonObject,
        `chart-${index + 1}`,
      );
      expect(html).toContain('data-og-component="data.chart"');
      expect(html).toContain('class="recharts-wrapper"');
      expect(html).toContain(fixture.recipeName);
      expect(html).not.toContain("data-open-generative-system");
    }
  }, 20_000);
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness() {
  const catalog = await createOfficialCatalog();
  const browserRegistry = await createBrowserContractRegistry(catalog.componentContracts.map((contract) => {
    const componentType = officialComponentTypeSchema.parse(contract.ref.componentType);
    const schema = resolvedPropsSchemas[componentType];
    return {
      contract,
      validateResolvedProps: createZodClientValidator(schema as never),
      eventPayloadValidators: Object.fromEntries(
        Object.keys(contract.events).map((port) => [port, exactJsonValueValidator]),
      ),
    };
  }));
  const artifacts = createSingleChunkOfficialRendererArtifactSet({
    chunkHash: RELEASE_CHUNK_HASH,
    stylesheetHash: RELEASE_STYLES_HASH,
  });
  const release = await createOfficialRendererRelease(catalog, artifacts);
  const rendererRegistry = await createVerifiedOfficialRendererRegistry(release, catalog);
  return { browserRegistry, catalog, rendererRegistry };
}

async function renderFixtureThroughSurface(
  harness: Harness,
  componentTypeInput: string,
  resolvedProps: JsonObject,
  identity: string,
): Promise<string> {
  const componentType = officialComponentTypeSchema.parse(componentTypeInput);
  const rootContract = harness.catalog.componentContracts.find((contract) => contract.ref.componentType === componentType);
  if (rootContract === undefined) throw new TypeError(`Missing official contract ${componentType}.`);
  const content = createDocument(harness.catalog, harness.browserRegistry.contractSetHash, rootContract, resolvedProps, identity);
  const revision = committedRevisionSchema.parse({
    envelope: {
      documentId: `document-${identity}`,
      revisionId: `revision-${identity}`,
      parentRevisionIds: [],
      contentHash: await hashDocumentContent(content),
      hashProfile: OPEN_GENERATIVE_HASH_PROFILE_ID,
      migrationReceiptIds: [],
      createdAt: "2026-08-22T00:00:00Z",
      createdBy: "open-generative-ui-test",
    },
    content,
  });
  const snapshot = surfaceSnapshotSchema.parse({
    revision,
    state: {},
    resources: {},
    resourceResolutionIdentities: {},
    actions: {},
    approvals: [],
  });
  const payload = {
    type: "snapshot-published" as const,
    snapshot,
    streamPolicy: {
      maxSequenceGap: 8,
      maxBufferedBytes: 256_000,
      ackEveryEvents: 64,
      backpressure: "publish-snapshot" as const,
      cursorExpiresAt: "2026-08-23T00:00:00Z",
    },
  };
  const event = surfaceEventEnvelopeSchema.parse({
    protocol: OPEN_GENERATIVE_SURFACE_STREAM_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    surfaceSessionId: SURFACE_ID,
    streamId: `stream-${identity}`,
    epoch: 1,
    sequence: 1,
    eventId: `event-${identity}`,
    cursor: `cursor-full-chain-${identity}`,
    committedRevisionId: revision.envelope.revisionId,
    audienceBindingHash: AUDIENCE_HASH,
    contractSetHash: harness.browserRegistry.contractSetHash,
    correlationId: `correlation-${identity}`,
    payloadHash: await hashCanonical(HASH_DOMAINS.surfaceEventPayload, payload),
    payload,
  });
  const controller = new SurfaceController({
    surfaceSessionId: SURFACE_ID,
    audienceBindingHash: AUDIENCE_HASH,
    contracts: harness.browserRegistry,
    transport: { send: () => undefined },
    autoAcknowledge: false,
  });
  const consumed = await controller.consume(event);
  expect(consumed.status).toBe("applied");
  expect(controller.bindNode(content.rootNodeId)?.status).toBe("ready");
  return renderToStaticMarkup(
    <GenerativeSurface
      controller={controller}
      placement={{ kind: "inline", width: 800, height: 600 }}
      registry={harness.rendererRegistry}
    />,
  );
}

function createDocument(
  catalog: OfficialCatalogBundle,
  contractSetHash: ReturnType<typeof sha256HashSchema.parse>,
  rootContract: ComponentContract,
  rootProps: JsonObject,
  identity: string,
) {
  const contracts = new Map(catalog.componentContracts.map((contract) => [contractRefKey(contract.ref), contract]));
  const fixtures = new Map(officialComponentFixtures.map((fixture) => [fixture.componentType, asObject(fixture.resolvedProps)]));
  const nodes: Record<string, unknown> = {};
  let sequence = 0;
  const addNode = (contract: ComponentContract, props: JsonObject, preferredId?: string): string => {
    const nodeId = preferredId ?? `node-${identity}-${++sequence}`;
    const slots: Record<string, string[]> = {};
    for (const [slotName, slot] of Object.entries(contract.slots)) {
      const children: string[] = [];
      for (let index = 0; index < slot.min; index += 1) {
        const accepted = slot.accepts[0]?.contract;
        const childContract = accepted === undefined ? undefined : contracts.get(contractRefKey(accepted));
        if (childContract === undefined) throw new TypeError(`Missing accepted child for ${contract.ref.componentType}.${slotName}.`);
        const childType = officialComponentTypeSchema.parse(childContract.ref.componentType);
        const childProps = fixtures.get(childType);
        if (childProps === undefined) throw new TypeError(`Missing fixture for ${childType}.`);
        children.push(addNode(childContract, childProps));
      }
      if (children.length > 0) slots[slotName] = children;
    }
    nodes[nodeId] = {
      contract: contract.ref,
      props: Object.fromEntries(Object.entries(props).map(([key, value]) => [key, toValueExpr(value)])),
      slots,
      events: {},
      evidence: [],
    };
    return nodeId;
  };
  const rootNodeId = addNode(rootContract, rootProps, "root");
  return documentContentSchema.parse({
    protocol: OPEN_GENERATIVE_DOCUMENT_PROTOCOL,
    protocolRevision: OPEN_GENERATIVE_PROTOCOL_REVISION,
    contracts: {
      manifestRefs: [catalog.manifest.ref],
      contractSetHash,
    },
    requirements: { dataClassifications: [], evidence: "none", placements: [], capabilities: [] },
    rootNodeId,
    nodes,
    stateDefinitions: {},
    actions: {},
    resourceBindings: {},
    evidenceBindings: {},
    claims: {},
    meta: { title: `Full chain ${identity}`, tags: [] },
  });
}

function toValueExpr(value: JsonValue): ValueExpr {
  if (Array.isArray(value)) return { kind: "array", items: value.map(toValueExpr) };
  if (value !== null && typeof value === "object") {
    return { kind: "object", entries: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toValueExpr(item)])) };
  }
  return { kind: "literal", value };
}

const exactJsonValueValidator: ClientValueValidator<JsonValue> = (input) => {
  const parsed = jsonValueSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: [{ code: "test.json-invalid", message: parsed.error.message }] };
};

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected object fixture.");
  return value;
}

function resolveChartFixture(specInput: (typeof officialChartSpecFixtures)[number]["spec"]): Record<string, unknown> {
  const spec = structuredClone(specInput) as Record<string, any>;
  spec.data = chartData;
  if (spec.legend?.visibilityState !== undefined) {
    spec.legend.visibilityState = spec.series.map((series: { column: string }) => series.column);
  }
  if (spec.interaction?.state !== undefined) {
    spec.interaction.state = spec.interaction.kind === "range-select"
      ? { start: 0, end: 2 }
      : spec.series[0]?.column ?? null;
  }
  if (spec.centerText?.value !== undefined && typeof spec.centerText.value === "object") {
    spec.centerText.value = 120;
  }
  return spec;
}
