import type { SurfaceEventEnvelope } from "@open-generative/protocol";

export const OPEN_GENERATIVE_AG_UI_EVENT = "open-generative.surface.event" as const;

export type OpenGenerativeAgUiEvent = Readonly<{
  type: "CUSTOM";
  name: typeof OPEN_GENERATIVE_AG_UI_EVENT;
  value: SurfaceEventEnvelope;
}>;
