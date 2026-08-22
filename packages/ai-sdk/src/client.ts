import type { SurfaceController, SurfaceConsumeResult } from "@open-generative/client";
import {
  surfaceEventEnvelopeSchema,
  verifySurfaceEventEnvelope,
  type SurfaceEventEnvelope,
} from "@open-generative/protocol";
import {
  OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
  type OpenGenerativeSurfaceDataPart,
} from "./wire";

export type ConsumeOpenGenerativeDataPartResult =
  | Readonly<{ status: "ignored" }>
  | Readonly<{ status: "consumed"; event: SurfaceEventEnvelope; result: SurfaceConsumeResult }>;

export function isOpenGenerativeSurfaceDataPart(
  input: unknown,
): input is OpenGenerativeSurfaceDataPart {
  if (!isRecord(input) || input.type !== OPEN_GENERATIVE_AI_SDK_DATA_TYPE) return false;
  return surfaceEventEnvelopeSchema.safeParse(input.data).success;
}

export async function decodeOpenGenerativeSurfaceDataPart(
  input: unknown,
): Promise<SurfaceEventEnvelope | undefined> {
  if (!isRecord(input) || input.type !== OPEN_GENERATIVE_AI_SDK_DATA_TYPE) return undefined;
  const event = surfaceEventEnvelopeSchema.parse(input.data);
  if (!await verifySurfaceEventEnvelope(event)) {
    throw new TypeError("Surface event payload hash verification failed.");
  }
  return event;
}

export async function consumeOpenGenerativeSurfaceDataPart(
  controller: Pick<SurfaceController, "consume">,
  input: unknown,
): Promise<ConsumeOpenGenerativeDataPartResult> {
  const event = await decodeOpenGenerativeSurfaceDataPart(input);
  if (!event) return { status: "ignored" };
  return { status: "consumed", event, result: await controller.consume(event) };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
