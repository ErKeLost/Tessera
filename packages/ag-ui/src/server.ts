import {
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { OPEN_GENERATIVE_AG_UI_EVENT, type OpenGenerativeAgUiEvent } from "./wire";

export async function surfaceEventToAgUiEvent(input: unknown): Promise<OpenGenerativeAgUiEvent> {
  const event = surfaceEventEnvelopeSchema.parse(input);
  if (!await verifySurfaceEventEnvelope(event)) {
    throw new TypeError("Surface event payload hash verification failed.");
  }
  return { type: "CUSTOM", name: OPEN_GENERATIVE_AG_UI_EVENT, value: event };
}

export async function* surfaceEventsToAgUiEvents(
  events: AsyncIterable<SurfaceEventEnvelope> | Iterable<SurfaceEventEnvelope>,
): AsyncGenerator<OpenGenerativeAgUiEvent> {
  for await (const event of events) yield surfaceEventToAgUiEvent(event);
}
