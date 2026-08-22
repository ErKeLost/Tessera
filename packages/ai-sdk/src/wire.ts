import type { SurfaceEventEnvelope } from "@open-generative/protocol";
import type { UIMessage } from "ai";

export const OPEN_GENERATIVE_AI_SDK_DATA_NAME = "openGenerativeSurface" as const;
export const OPEN_GENERATIVE_AI_SDK_DATA_TYPE = "data-openGenerativeSurface" as const;

export type OpenGenerativeAIData = Readonly<{
  openGenerativeSurface: SurfaceEventEnvelope;
}>;

export type OpenGenerativeUIMessage = UIMessage<unknown, OpenGenerativeAIData>;

export type OpenGenerativeSurfaceDataPart = Readonly<{
  type: typeof OPEN_GENERATIVE_AI_SDK_DATA_TYPE;
  id?: string;
  data: SurfaceEventEnvelope;
}>;

export type OpenGenerativeSurfaceDataChunk = OpenGenerativeSurfaceDataPart & Readonly<{
  transient: true;
}>;
