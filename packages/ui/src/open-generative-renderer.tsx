"use client";

import {
  SurfaceController,
  createBrowserContractRegistry,
  createZodClientValidator,
  type BrowserContractRegistry,
} from "@open-generative/client";
import type { PlacementContext } from "@open-generative/catalog";
import {
  analysisInsightPropsSchema,
  analysisReportPropsSchema,
  createOfficialCatalog,
  dataChartPropsSchema,
  dataMetricPropsSchema,
  layoutGridPropsSchema,
  layoutStackPropsSchema,
  type OfficialCatalogBundle,
  type OfficialRendererRelease,
} from "@open-generative/components";
import {
  openGenerativeSurfaceStreamSchema,
  type HostCommandEnvelope,
  type JsonObject,
  type JsonValue,
  type OpenGenerativeSurfaceStream,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { GenerativeSurface, type RendererRegistry } from "@open-generative/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  createOfficialRendererRegistry,
  createVerifiedOfficialRendererRegistry,
} from "./generative/registry";

const DEFAULT_PLACEMENT: PlacementContext = Object.freeze({
  kind: "inline",
  width: 720,
  height: 520,
});

type Foundation = Readonly<{
  contracts: BrowserContractRegistry;
  renderers: RendererRegistry;
}>;

type RendererState =
  | Readonly<{ status: "loading" }>
  | Readonly<{
    status: "ready";
    surfaceSessionId: string;
    controller: SurfaceController;
    registry: RendererRegistry;
  }>
  | Readonly<{ status: "error"; error: unknown }>;

export type OpenGenerativeRendererProps = Readonly<{
  stream: OpenGenerativeSurfaceStream;
  /** Optional command bridge for interactive and paginated surfaces. */
  onCommand?: (command: HostCommandEnvelope) => void | readonly SurfaceEventEnvelope[] | Promise<void | readonly SurfaceEventEnvelope[]>;
  /** Supply the published release when artifact-integrity verification is required. */
  rendererRelease?: OfficialRendererRelease;
  placement?: PlacementContext;
  locale?: string;
  timezone?: string;
  className?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode | ((error: unknown) => ReactNode);
}>;

let defaultFoundationPromise: Promise<Foundation> | undefined;
const verifiedFoundationPromises = new WeakMap<object, Promise<Foundation>>();

/**
 * The complete official client integration. Applications render one trusted
 * Surface event; controller, contracts, registry, replay, and cleanup remain
 * package-owned.
 */
export function OpenGenerativeRenderer({
  stream: streamInput,
  onCommand,
  rendererRelease,
  placement = DEFAULT_PLACEMENT,
  locale = "en-US",
  timezone = "UTC",
  className,
  loadingFallback,
  errorFallback = null,
}: OpenGenerativeRendererProps) {
  const [state, setState] = useState<RendererState>({ status: "loading" });
  const consumedSequence = useRef(0);
  const consumeChain = useRef(Promise.resolve());
  const surfaceSessionId = streamInput.surfaceSessionId;

  useEffect(() => {
    let active = true;
    let controller: SurfaceController | undefined;
    setState({ status: "loading" });
    void (async () => {
      try {
        const stream = openGenerativeSurfaceStreamSchema.parse(streamInput);
        const event = stream.events[0];
        if (!event || event.payload.type !== "snapshot-published") {
          throw new Error("An Open Generative Surface stream must begin with a snapshot.");
        }
        const foundation = await getFoundation(rendererRelease);
        controller = new SurfaceController({
          surfaceSessionId: event.surfaceSessionId,
          audienceBindingHash: event.audienceBindingHash,
          contracts: foundation.contracts,
          transport: {
            async send(command) {
              const events = await onCommand?.(command);
              if (!events) return;
              for (const nextEvent of events) {
                await controller?.consume(nextEvent);
                consumedSequence.current = Math.max(consumedSequence.current, nextEvent.sequence);
              }
            },
          },
          context: { locale, timezone },
          stateValidation: { validateSurfaceStateValue: () => [] },
        });
        for (const nextEvent of stream.events) {
          const consumed = await controller.consume(nextEvent);
          if (consumed.status === "rejected" || consumed.status === "resync-required") {
            throw new Error("The trusted Open Generative Surface event could not be applied.");
          }
          consumedSequence.current = nextEvent.sequence;
        }
        if (!active) {
          controller.dispose();
          return;
        }
        setState({
          status: "ready",
          surfaceSessionId: stream.surfaceSessionId,
          controller,
          registry: foundation.renderers,
        });
      } catch (error) {
        controller?.dispose();
        if (active) setState({ status: "error", error });
      }
    })();
    return () => {
      active = false;
      consumedSequence.current = 0;
      consumeChain.current = Promise.resolve();
      controller?.dispose();
    };
  }, [locale, onCommand, rendererRelease, surfaceSessionId, timezone]);

  useEffect(() => {
    if (state.status !== "ready") return;
    let active = true;
    consumeChain.current = consumeChain.current.then(async () => {
      try {
        const stream = openGenerativeSurfaceStreamSchema.parse(streamInput);
        if (stream.surfaceSessionId !== state.surfaceSessionId) return;
        for (const event of stream.events) {
          if (event.sequence <= consumedSequence.current) continue;
          const consumed = await state.controller.consume(event);
          if (consumed.status === "rejected" || consumed.status === "resync-required") {
            throw new Error("The trusted Open Generative Surface event could not be applied.");
          }
          consumedSequence.current = event.sequence;
        }
      } catch (error) {
        if (active) setState({ status: "error", error });
      }
    });
    return () => {
      active = false;
    };
  }, [state, streamInput]);

  if (state.status === "loading") {
    return loadingFallback ?? <div aria-busy="true" className={className} data-og-renderer="loading" />;
  }
  if (state.status === "error") {
    return typeof errorFallback === "function" ? errorFallback(state.error) : errorFallback;
  }
  return (
    <div className={className} data-og-renderer="ready">
      <GenerativeSurface controller={state.controller} placement={placement} registry={state.registry} />
    </div>
  );
}

function getFoundation(release: OfficialRendererRelease | undefined): Promise<Foundation> {
  if (release === undefined) {
    defaultFoundationPromise ??= createFoundation();
    return defaultFoundationPromise;
  }
  const key = release as object;
  let pending = verifiedFoundationPromises.get(key);
  if (!pending) {
    pending = createFoundation(release);
    verifiedFoundationPromises.set(key, pending);
  }
  return pending;
}

async function createFoundation(release?: OfficialRendererRelease): Promise<Foundation> {
  const catalog = await createOfficialCatalog();
  const [contracts, renderers] = await Promise.all([
    createOfficialBrowserContracts(catalog),
    release === undefined
      ? createOfficialRendererRegistry(catalog)
      : createVerifiedOfficialRendererRegistry(release, catalog),
  ]);
  if (contracts.contractSetHash !== catalog.manifest.contractSetHash) {
    throw new Error("The browser Contract Registry does not match the official Catalog.");
  }
  return Object.freeze({ contracts, renderers });
}

function createOfficialBrowserContracts(catalog: OfficialCatalogBundle): Promise<BrowserContractRegistry> {
  const propsSchemas = new Map<string, z.ZodType<JsonObject>>([
    ["data.chart", dataChartPropsSchema as unknown as z.ZodType<JsonObject>],
    ["data.metric", dataMetricPropsSchema as unknown as z.ZodType<JsonObject>],
    ["analysis.insight", analysisInsightPropsSchema as unknown as z.ZodType<JsonObject>],
    ["layout.stack", layoutStackPropsSchema as unknown as z.ZodType<JsonObject>],
    ["layout.grid", layoutGridPropsSchema as unknown as z.ZodType<JsonObject>],
    ["analysis.report", analysisReportPropsSchema as unknown as z.ZodType<JsonObject>],
  ]);
  return createBrowserContractRegistry(catalog.componentContracts.map((contract) => {
    const propsSchema = propsSchemas.get(contract.ref.componentType);
    if (!propsSchema) throw new TypeError(`No browser validator exists for ${contract.ref.componentType}.`);
    return {
      contract,
      validateResolvedProps: createZodClientValidator(propsSchema),
      eventPayloadValidators: Object.fromEntries(
        Object.entries(contract.events).map(([port, event]) => [
          port,
          createZodClientValidator(z.fromJSONSchema(event.payloadSchema) as z.ZodType<JsonValue>),
        ]),
      ),
    };
  }));
}
