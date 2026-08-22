import type { SurfaceController, SurfaceConsumeResult } from "@open-generative/client";
import {
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import { OPEN_GENERATIVE_AG_UI_EVENT, type OpenGenerativeAgUiEvent } from "./wire";

export type ConsumeAgUiEventResult =
  | Readonly<{ status: "ignored" }>
  | Readonly<{ status: "consumed"; event: SurfaceEventEnvelope; result: SurfaceConsumeResult }>;

export function isOpenGenerativeAgUiEvent(input: unknown): input is OpenGenerativeAgUiEvent {
  if (!isRecord(input) || input.type !== "CUSTOM" || input.name !== OPEN_GENERATIVE_AG_UI_EVENT) {
    return false;
  }
  return surfaceEventEnvelopeSchema.safeParse(input.value).success;
}

export async function decodeOpenGenerativeAgUiEvent(
  input: unknown,
): Promise<SurfaceEventEnvelope | undefined> {
  if (!isRecord(input) || input.type !== "CUSTOM" || input.name !== OPEN_GENERATIVE_AG_UI_EVENT) {
    return undefined;
  }
  const event = surfaceEventEnvelopeSchema.parse(input.value);
  if (!await verifySurfaceEventEnvelope(event)) {
    throw new TypeError("Surface event payload hash verification failed.");
  }
  return event;
}

export async function consumeOpenGenerativeAgUiEvent(
  controller: Pick<SurfaceController, "consume">,
  input: unknown,
): Promise<ConsumeAgUiEventResult> {
  const event = await decodeOpenGenerativeAgUiEvent(input);
  if (!event) return { status: "ignored" };
  return { status: "consumed", event, result: await controller.consume(event) };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
