import {
  openGenerativeSurfaceStreamSchema,
  verifySurfaceEventEnvelope,
  type OpenGenerativeSurfaceStream,
} from "@open-generative/protocol";
import {
  OPEN_GENERATIVE_AI_SDK_DATA_TYPE,
  type OpenGenerativeSurfaceDataPart,
} from "./wire";

export function isOpenGenerativeSurfaceDataPart(
  input: unknown,
): input is OpenGenerativeSurfaceDataPart {
  return isRecord(input)
    && input.type === OPEN_GENERATIVE_AI_SDK_DATA_TYPE
    && openGenerativeSurfaceStreamSchema.safeParse(input.data).success;
}

export async function decodeOpenGenerativeSurfaceDataPart(
  input: unknown,
): Promise<OpenGenerativeSurfaceStream | undefined> {
  if (!isRecord(input) || input.type !== OPEN_GENERATIVE_AI_SDK_DATA_TYPE) return undefined;
  const stream = openGenerativeSurfaceStreamSchema.parse(input.data);
  for (const event of stream.events) {
    if (!await verifySurfaceEventEnvelope(event)) {
      throw new TypeError("Surface event payload hash verification failed.");
    }
  }
  return stream;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
