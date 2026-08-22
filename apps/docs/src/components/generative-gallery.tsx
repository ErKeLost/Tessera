"use client";

import {
  SurfaceController,
  createBrowserContractRegistry,
  createZodClientValidator,
  type BrowserContractRegistry,
} from "@open-generative/client";
import {
  contentCalloutPropsSchema,
  contentEmptyPropsSchema,
  contentTextPropsSchema,
  controlFilterPropsSchema,
  controlGroupPropsSchema,
  createOfficialCatalog,
  dataChartPropsSchema,
  dataMetricPropsSchema,
  dataQueryDetailsPropsSchema,
  dataTablePropsSchema,
  layoutGridPropsSchema,
  layoutSectionPropsSchema,
  layoutStackPropsSchema,
  officialChartSpecFixtures,
  officialComponentTypes,
  officialRendererReleaseSchema,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import {
  jsonObjectSchema,
  sha256HashSchema,
  surfaceEventEnvelopeSchema,
  type HostCommandEnvelope,
  type JsonObject,
  type JsonValue,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  GenerativeSurface,
  type RendererRegistry,
} from "@open-generative/react";
import { createVerifiedOfficialRendererRegistry } from "@open-generative/ui";
import rendererRelease from "@open-generative/ui/renderer-release.json";
import { useEffect, useState } from "react";
import { z } from "zod";
import {
  contractDescriptions,
  descriptorKey,
  generativeGalleryConformanceDescriptors,
  generativeGalleryPlacement,
  type OfficialComponentType,
  type PreviewDescriptor,
} from "./generative-gallery-model";

export {
  generativeGalleryConformanceDescriptors,
  generativeGalleryPlacement,
  type OfficialComponentType,
  type PreviewDescriptor,
};

type GalleryFoundation = Readonly<{
  catalog: OfficialCatalogBundle;
  contracts: BrowserContractRegistry;
  renderers: RendererRegistry;
}>;

type ReadySurface = Readonly<{
  controller: SurfaceController;
  registry: RendererRegistry;
}>;

type SurfaceState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; surface: ReadySurface }>
  | Readonly<{ status: "error"; message: string }>;

const AUDIENCE_BINDING_HASH = sha256HashSchema.parse(`sha256:${"a".repeat(64)}`);

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
} satisfies Record<OfficialComponentType, z.ZodType>;

let foundationPromise: Promise<GalleryFoundation> | undefined;
const eventPromises = new Map<string, Promise<SurfaceEventEnvelope>>();

function getFoundation(): Promise<GalleryFoundation> {
  foundationPromise ??= createFoundation();
  return foundationPromise;
}

async function createFoundation(): Promise<GalleryFoundation> {
  const catalog = await createOfficialCatalog();
  const release = officialRendererReleaseSchema.parse(rendererRelease);
  const registrations = catalog.componentContracts.map(contract => {
    const componentType = officialComponentType(contract.ref.componentType);
    const eventPayloadValidators = Object.fromEntries(
      Object.entries(contract.events).map(([port, event]) => [
        port,
        createZodClientValidator(
          z.fromJSONSchema(event.payloadSchema) as z.ZodType<JsonValue>,
        ),
      ]),
    );
    return {
      contract,
      validateResolvedProps: createZodClientValidator(
        resolvedPropsSchemas[componentType] as unknown as z.ZodType<JsonObject>,
      ),
      eventPayloadValidators,
    };
  });
  const [contracts, renderers] = await Promise.all([
    createBrowserContractRegistry(registrations),
    createVerifiedOfficialRendererRegistry(release, catalog),
  ]);
  if (contracts.contractSetHash !== catalog.manifest.contractSetHash) {
    throw new Error("The browser Contract registry does not match the official Catalog manifest.");
  }
  return Object.freeze({ catalog, contracts, renderers });
}

function officialComponentType(value: string): OfficialComponentType {
  if ((officialComponentTypes as readonly string[]).includes(value)) {
    return value as OfficialComponentType;
  }
  throw new Error(`Unknown official component type: ${value}`);
}

function getSnapshotEvent(descriptor: PreviewDescriptor): Promise<SurfaceEventEnvelope> {
  const key = descriptorKey(descriptor);
  const cached = eventPromises.get(key);
  if (cached !== undefined) return cached;
  const promise = fetchSnapshotEvent(descriptor);
  eventPromises.set(key, promise);
  void promise.catch(() => eventPromises.delete(key));
  return promise;
}

async function fetchSnapshotEvent(descriptor: PreviewDescriptor): Promise<SurfaceEventEnvelope> {
  const search = new URLSearchParams({ kind: descriptor.kind, value: descriptor.value });
  const response = await fetch(`/api/generative-gallery?${search}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = jsonObjectSchema.safeParse(payload);
    throw new Error(
      message.success && typeof message.data.error === "string"
        ? message.data.error
        : `Proof surface request failed with ${response.status}.`,
    );
  }
  return surfaceEventEnvelopeSchema.parse(payload);
}

export async function createGenerativeGalleryConformanceCase(
  descriptor: PreviewDescriptor,
  eventInput?: unknown,
) {
  const foundation = await getFoundation();
  const event = eventInput === undefined
    ? await getSnapshotEvent(descriptor)
    : surfaceEventEnvelopeSchema.parse(eventInput);
  const commands: HostCommandEnvelope[] = [];
  const controller = new SurfaceController({
    surfaceSessionId: event.surfaceSessionId,
    audienceBindingHash: AUDIENCE_BINDING_HASH,
    contracts: foundation.contracts,
    transport: {
      send(command) {
        commands.push(command);
      },
    },
    stateValidation: { validateSurfaceStateValue: () => [] },
    autoAcknowledge: false,
    context: { locale: "en-US", timezone: "Asia/Shanghai" },
  });
  const result = await controller.consume(event);
  if (result.status !== "applied" || result.snapshot.status !== "ready") {
    controller.dispose();
    throw new Error(result.issues.map(issue => issue.code).join(", ") || result.status);
  }
  return Object.freeze({
    commands,
    controller,
    descriptor,
    event,
    registry: foundation.renderers,
    result,
  });
}

function SurfacePreview({ descriptor }: { descriptor: PreviewDescriptor }) {
  const [state, setState] = useState<SurfaceState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let controller: SurfaceController | undefined;
    setState({ status: "loading" });
    void (async () => {
      try {
        const conformanceCase = await createGenerativeGalleryConformanceCase(descriptor);
        controller = conformanceCase.controller;
        if (!active) {
          controller.dispose();
          return;
        }
        setState({
          status: "ready",
          surface: { controller, registry: conformanceCase.registry },
        });
      } catch (error) {
        controller?.dispose();
        if (active) setState({ status: "error", message: errorMessage(error) });
      }
    })();
    return () => {
      active = false;
      controller?.dispose();
    };
  }, [descriptor.kind, descriptor.value]);

  const minHeight = previewMinHeight(descriptor);
  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-label="Loading trusted Generative UI surface"
        className="animate-pulse rounded-md border border-border/60 bg-muted/25"
        style={{ minHeight }}
      />
    );
  }
  if (state.status === "error") {
    return (
      <div
        className="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm text-destructive"
        role="alert"
        style={{ minHeight }}
      >
        Generative UI surface failed validation: {state.message}
      </div>
    );
  }
  return (
    <div
      className="min-w-0 overflow-hidden"
      data-generative-preview={descriptor.value}
      style={{ minHeight }}
    >
      <GenerativeSurface
        controller={state.surface.controller}
        placement={generativeGalleryPlacement}
        registry={state.surface.registry}
      />
    </div>
  );
}

function previewMinHeight(descriptor: PreviewDescriptor): number {
  if (descriptor.kind === "recipe") return 380;
  if (descriptor.kind === "analysis" || descriptor.kind === "filter") return 760;
  if (descriptor.kind === "metrics") return 260;
  if (descriptor.value === "data.chart") return 380;
  if (descriptor.value === "data.table" || descriptor.value === "data.query-details") return 300;
  return 128;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown validation error";
}

export function ComponentContractDemo({
  componentType,
}: {
  componentType: OfficialComponentType;
}) {
  return <SurfacePreview descriptor={{ kind: "component", value: componentType }} />;
}

export function ChartRecipeDemo({ recipeName }: { recipeName: string }) {
  return <SurfacePreview descriptor={{ kind: "recipe", value: recipeName }} />;
}

export function DataAgentAnalysisDemo() {
  return <SurfacePreview descriptor={{ kind: "analysis", value: "analysis-overview" }} />;
}

export function DataAgentFilterDemo() {
  return <SurfacePreview descriptor={{ kind: "filter", value: "filterable-breakdown" }} />;
}

export function DataAgentMetricsDemo() {
  return <SurfacePreview descriptor={{ kind: "metrics", value: "workspace-health" }} />;
}

export function DataAgentCompositionGallery() {
  const compositions = [
    {
      key: "analysis",
      title: "Query analysis",
      description: "Metric, chart, exact rows, and governed query evidence from pinned resources.",
      preview: <DataAgentAnalysisDemo />,
    },
    {
      key: "filter",
      title: "Filter-bound breakdown",
      description: "Surface state drives Resource Gateway row projection before chart and table materialization.",
      preview: <DataAgentFilterDemo />,
    },
    {
      key: "metrics",
      title: "Workspace health",
      description: "Three independent scalar bindings composed into one responsive operational view.",
      preview: <DataAgentMetricsDemo />,
    },
  ] as const;
  return (
    <div className="not-prose my-8 grid min-w-0 gap-y-12">
      {compositions.map(composition => (
        <section className="min-w-0 border-t border-border/70 pt-5" key={composition.key}>
          <header className="mb-5 grid gap-1 md:grid-cols-[12rem_minmax(0,1fr)] md:items-baseline md:gap-6">
            <h3 className="text-sm font-semibold text-foreground">{composition.title}</h3>
            <p className="m-0 text-xs leading-5 text-muted-foreground">{composition.description}</p>
          </header>
          {composition.preview}
        </section>
      ))}
    </div>
  );
}

export function GenerativeContractGallery() {
  return (
    <div className="not-prose my-8 grid min-w-0 gap-x-8 gap-y-10 xl:grid-cols-2">
      {officialComponentTypes.map(componentType => (
        <section className="min-w-0 border-t border-border/70 pt-4" key={componentType}>
          <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <code className="text-sm font-semibold text-foreground">{componentType}</code>
            <span className="text-xs text-muted-foreground">{contractDescriptions[componentType]}</span>
          </header>
          <ComponentContractDemo componentType={componentType} />
        </section>
      ))}
    </div>
  );
}

export function GenerativeChartRecipeGallery() {
  const [selected, setSelected] = useState(officialChartSpecFixtures[0]!.recipeName);
  const selectedFixture = officialChartSpecFixtures.find(fixture => fixture.recipeName === selected)
    ?? officialChartSpecFixtures[0]!;
  const families = ["area", "bar", "line", "pie", "radar", "radial", "tooltip"] as const;
  return (
    <div className="not-prose my-8 min-w-0">
      <div className="mb-6 border-y border-border/70 py-5">
        {families.map(family => {
          const fixtures = officialChartSpecFixtures.filter(fixture => fixture.recipeFamily === family);
          return (
            <div className="grid gap-2 py-2 md:grid-cols-[5rem_minmax(0,1fr)]" key={family}>
              <span className="pt-1.5 text-xs font-semibold uppercase text-muted-foreground">{family}</span>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {fixtures.map(fixture => (
                  <button
                    aria-pressed={selected === fixture.recipeName}
                    className="min-h-8 max-w-full rounded-md border border-border/70 px-2.5 py-1 text-left text-[11px] leading-4 text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:border-foreground/30 data-[active=true]:bg-foreground data-[active=true]:text-background"
                    data-active={selected === fixture.recipeName}
                    key={fixture.recipeName}
                    onClick={() => setSelected(fixture.recipeName)}
                    type="button"
                  >
                    {fixture.recipeName.replace(`chart-${family}-`, "")}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <section aria-live="polite" className="min-w-0">
        <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <code className="text-sm font-semibold text-foreground">{selectedFixture.recipeName}</code>
          <span className="text-xs text-muted-foreground">1 trusted Surface / 70 selectable recipes</span>
        </header>
        <ChartRecipeDemo recipeName={selectedFixture.recipeName} />
      </section>
    </div>
  );
}
