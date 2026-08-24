import type { OpenGenerativeSurfaceStream } from "@open-generative/protocol";
import type { UIMessage } from "ai";

export const OPEN_GENERATIVE_AI_SDK_DATA_NAME = "openGenerativeSurface" as const;
export const OPEN_GENERATIVE_AI_SDK_DATA_TYPE = "data-openGenerativeSurface" as const;

export type OpenGenerativeAIData = Readonly<{
  openGenerativeSurface: OpenGenerativeSurfaceStream;
}>;

export type OpenGenerativeUIMessage = UIMessage<unknown, OpenGenerativeAIData>;

export type OpenGenerativeSurfaceDataPart = Readonly<{
  type: typeof OPEN_GENERATIVE_AI_SDK_DATA_TYPE;
  id?: string;
  data: OpenGenerativeSurfaceStream;
}>;

export type OpenGenerativeSurfaceDataChunk = OpenGenerativeSurfaceDataPart & Readonly<{
  /**
   * AI SDK excludes transient data from UIMessage.parts. Use this only when
   * the consumer handles the event through useChat({ onData }) instead of a
   * message-part renderer.
   */
  transient?: true;
}>;
