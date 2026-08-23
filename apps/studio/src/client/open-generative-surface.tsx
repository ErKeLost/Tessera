"use client";

import {
  SurfaceController,
  createBrowserContractRegistry,
  createZodClientValidator,
  type BrowserContractRegistry,
} from "@open-generative/client";
import { consumeOpenGenerativeSurfaceDataPart } from "@open-generative/ai-sdk/client";
import {
  createOfficialCatalog,
  dataChartPropsSchema,
  officialRendererReleaseSchema,
  type OfficialCatalogBundle,
} from "@open-generative/components";
import {
  jsonObjectSchema,
  surfaceEventEnvelopeSchema,
  type HostCommandEnvelope,
  type JsonObject,
  type JsonValue,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { GenerativeSurface, type RendererRegistry } from "@open-generative/react";
import { createVerifiedOfficialRendererRegistry } from "@open-generative/ui";
import rendererRelease from "@open-generative/ui/renderer-release.json";
import { useEffect, useState } from "react";
import { z } from "zod";

type Foundation = Readonly<{
  contracts: BrowserContractRegistry;
  renderers: RendererRegistry;
}>;

type SurfaceState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; controller: SurfaceController; registry: RendererRegistry }>
  | Readonly<{ status: "error" }>;

let foundationPromise: Promise<Foundation> | undefined;

function getFoundation(): Promise<Foundation> {
  foundationPromise ??= createFoundation();
  return foundationPromise;
}

async function createFoundation(): Promise<Foundation> {
  const catalog = await createOfficialCatalog();
  const release = officialRendererReleaseSchema.parse(rendererRelease);
  const registrations = catalog.componentContracts.map((contract) => ({
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
    throw new Error("The Studio browser contract registry does not match the official catalog.");
  }
  return Object.freeze({ contracts, renderers });
}

export function OpenGenerativeSurfaceDataRenderer({ data }: { data: SurfaceEventEnvelope }) {
  return <OpenGenerativeSurface event={data} />;
}

function OpenGenerativeSurface({ event: eventInput }: { event: SurfaceEventEnvelope }) {
  const [state, setState] = useState<SurfaceState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let controller: SurfaceController | undefined;
    setState({ status: "loading" });
    void (async () => {
      try {
        const event = surfaceEventEnvelopeSchema.parse(eventInput);
        const foundation = await getFoundation();
        controller = new SurfaceController({
          surfaceSessionId: event.surfaceSessionId,
          audienceBindingHash: event.audienceBindingHash,
          contracts: foundation.contracts,
          transport: {
            async send(command) {
              const result = await sendGenerativeCommand(command);
              if (result.status !== "events") return;
              for (const nextEvent of result.events) await controller?.consume(nextEvent);
            },
          },
          context: { locale: "en-US", timezone: "Asia/Shanghai" },
          stateValidation: { validateSurfaceStateValue: () => [] },
        });
        const consumed = await consumeOpenGenerativeSurfaceDataPart(controller, {
          type: "data-openGenerativeSurface",
          data: event,
        });
        if (consumed.status !== "consumed" || consumed.result.status === "rejected") {
          throw new Error("The trusted generative surface could not be applied.");
        }
        if (!active) {
          controller.dispose();
          return;
        }
        setState({ status: "ready", controller, registry: foundation.renderers });
      } catch {
        controller?.dispose();
        if (active) setState({ status: "error" });
      }
    })();
    return () => {
      active = false;
      controller?.dispose();
    };
  }, [eventInput]);

  if (state.status === "loading") {
    return <div aria-busy="true" className="tessera-generative-surface tessera-generative-surface-loading" />;
  }
  if (state.status === "error") return null;
  return (
    <div className="tessera-generative-surface">
      <GenerativeSurface
        controller={state.controller}
        placement={{ kind: "inline", width: 720, height: 520 }}
        registry={state.registry}
      />
    </div>
  );
}

async function sendGenerativeCommand(command: HostCommandEnvelope) {
  const response = await fetch("/api/generative/command", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(command),
  });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`Generative command failed with ${response.status}.`);
  const parsed = jsonObjectSchema.safeParse(payload);
  if (!parsed.success || typeof parsed.data.status !== "string") {
    throw new Error("Generative command returned an invalid response.");
  }
  if (parsed.data.status === "events") {
    const events = Array.isArray(parsed.data.events)
      ? parsed.data.events.map((event) => surfaceEventEnvelopeSchema.parse(event))
      : undefined;
    if (!events) throw new Error("Generative command events were invalid.");
    return { status: "events" as const, events };
  }
  return { status: "other" as const };
}
