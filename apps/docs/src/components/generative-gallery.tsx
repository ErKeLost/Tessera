"use client";

import {
  SurfaceController,
  createBrowserContractRegistry,
  createZodClientValidator,
  type BrowserContractRegistry,
} from "@open-generative/client";
import {
  createOfficialCatalog,
  dataChartPropsSchema,
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
  dataChartFixtureDocumentation,
  descriptorKey,
  generativeGalleryConformanceDescriptors,
  generativeGalleryPlacement,
  type DataChartFixtureName,
  type PreviewDescriptor,
} from "./generative-gallery-model";

export {
  generativeGalleryConformanceDescriptors,
  generativeGalleryPlacement,
  type DataChartFixtureName,
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
let foundationPromise: Promise<GalleryFoundation> | undefined;
const eventPromises = new Map<string, Promise<SurfaceEventEnvelope>>();

function getFoundation(): Promise<GalleryFoundation> {
  foundationPromise ??= createFoundation();
  return foundationPromise;
}

async function createFoundation(): Promise<GalleryFoundation> {
  const catalog = await createOfficialCatalog();
  const release = officialRendererReleaseSchema.parse(rendererRelease);
  const registrations = catalog.componentContracts.map(contract => ({
    contract,
    validateResolvedProps: createZodClientValidator(
      dataChartPropsSchema as unknown as z.ZodType<JsonObject>,
    ),
    eventPayloadValidators: Object.fromEntries(
      Object.entries(contract.events).map(([port, event]) => [
        port,
        createZodClientValidator(
          z.fromJSONSchema(event.payloadSchema) as z.ZodType<JsonValue>,
        ),
      ]),
    ),
  }));
  const [contracts, renderers] = await Promise.all([
    createBrowserContractRegistry(registrations),
    createVerifiedOfficialRendererRegistry(release, catalog),
  ]);
  if (contracts.contractSetHash !== catalog.manifest.contractSetHash) {
    throw new Error("The browser Contract registry does not match the official Catalog manifest.");
  }
  return Object.freeze({ catalog, contracts, renderers });
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
  }, [descriptor.value]);

  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        aria-label="Loading trusted data chart surface"
        className="animate-pulse rounded-md border border-border/60 bg-muted/25"
        style={{ minHeight: 440 }}
      />
    );
  }
  if (state.status === "error") {
    return (
      <div
        className="rounded-md border border-destructive/35 bg-destructive/5 p-4 text-sm text-destructive"
        role="alert"
        style={{ minHeight: 440 }}
      >
        Data chart surface failed validation: {state.message}
      </div>
    );
  }
  return (
    <div
      className="flex min-w-0 items-center justify-center overflow-hidden [&>*]:w-full"
      data-generative-preview={descriptor.value}
      style={{ minHeight: 440 }}
    >
      <GenerativeSurface
        controller={state.surface.controller}
        placement={generativeGalleryPlacement}
        registry={state.surface.registry}
      />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown validation error";
}

export function DataChartDemo({ fixtureName }: { fixtureName: DataChartFixtureName }) {
  return <SurfacePreview descriptor={{ kind: "fixture", value: fixtureName }} />;
}

export function DataChartGallery() {
  return (
    <div className="not-prose my-10 grid min-w-0 gap-y-14">
      {generativeGalleryConformanceDescriptors.map((descriptor, index) => {
        const documentation = dataChartFixtureDocumentation[descriptor.value];
        return (
          <section
            className="min-w-0 border-t border-border/70 pt-5"
            data-chart-fixture={descriptor.value}
            key={descriptor.value}
          >
            <header className="mb-5 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-8">
              <div className="min-w-0">
                <h2 className="m-0 text-base font-semibold text-foreground">
                  {documentation.title}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {documentation.description}
                </p>
              </div>
              <code className="text-[11px] text-muted-foreground">
                data.chart / {String(index + 1).padStart(2, "0")}
              </code>
            </header>
            <DataChartDemo fixtureName={descriptor.value} />
          </section>
        );
      })}
    </div>
  );
}
