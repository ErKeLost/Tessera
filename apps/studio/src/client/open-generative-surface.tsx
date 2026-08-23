"use client";

import {
  officialRendererReleaseSchema,
} from "@open-generative/components";
import {
  jsonObjectSchema,
  surfaceEventEnvelopeSchema,
  type HostCommandEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { OpenGenerativeRenderer } from "@open-generative/ui";
import rendererRelease from "@open-generative/ui/renderer-release.json";

const verifiedRendererRelease = officialRendererReleaseSchema.parse(rendererRelease);

export function OpenGenerativeSurfaceDataRenderer({ data }: { data: SurfaceEventEnvelope }) {
  return (
    <OpenGenerativeRenderer
      className="tessera-generative-surface"
      event={data}
      locale="en-US"
      onCommand={sendGenerativeCommand}
      rendererRelease={verifiedRendererRelease}
      timezone="Asia/Shanghai"
    />
  );
}

async function sendGenerativeCommand(command: HostCommandEnvelope): Promise<readonly SurfaceEventEnvelope[] | undefined> {
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
  if (parsed.data.status !== "events") return undefined;
  if (!Array.isArray(parsed.data.events)) {
    throw new Error("Generative command events were invalid.");
  }
  return parsed.data.events.map((event) => surfaceEventEnvelopeSchema.parse(event));
}
