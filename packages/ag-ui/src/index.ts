import {
  decodeArtifactPart,
  type ArtifactPart,
  type ArtifactPartWire,
  type ClientArtifactEvent,
  type DecodeArtifactPartOptions,
  type Diagnostic,
  type RuntimeSnapshot,
} from "@data-elements/runtime";

export const AG_UI_ARTIFACT_SNAPSHOT_EVENT = "data-elements.artifact.snapshot" as const;
export const AG_UI_ARTIFACT_EVENT = "data-elements.artifact.event" as const;

export type AgUiArtifactCustomEvent =
  | {
      type: "CUSTOM";
      name: typeof AG_UI_ARTIFACT_SNAPSHOT_EVENT;
      value: RuntimeSnapshot;
    }
  | {
      type: "CUSTOM";
      name: typeof AG_UI_ARTIFACT_EVENT;
      value: ClientArtifactEvent;
    };

export function artifactSnapshotToAgUiEvent(
  snapshot: RuntimeSnapshot,
): AgUiArtifactCustomEvent {
  return { type: "CUSTOM", name: AG_UI_ARTIFACT_SNAPSHOT_EVENT, value: snapshot };
}

export function artifactEventToAgUiEvent(
  event: ClientArtifactEvent,
): AgUiArtifactCustomEvent {
  return { type: "CUSTOM", name: AG_UI_ARTIFACT_EVENT, value: event };
}

export function agUiEventToArtifactWire(input: unknown): ArtifactPartWire | undefined {
  if (!isRecord(input) || input.type !== "CUSTOM" || typeof input.name !== "string") return undefined;
  if (input.name === AG_UI_ARTIFACT_SNAPSHOT_EVENT) {
    return { kind: "artifact-snapshot", snapshot: input.value as RuntimeSnapshot };
  }
  if (input.name === AG_UI_ARTIFACT_EVENT) {
    return { kind: "artifact-stream", events: [input.value as ClientArtifactEvent] };
  }
  return undefined;
}

export async function decodeAgUiArtifactEvent(
  input: unknown,
  options: DecodeArtifactPartOptions,
): Promise<
  | { success: true; part: ArtifactPart }
  | { success: false; diagnostics: Diagnostic[] }
  | { success: false; ignored: true }
> {
  const wire = agUiEventToArtifactWire(input);
  if (!wire) return { success: false, ignored: true };
  return decodeArtifactPart(wire, options);
}

export function artifactPartToAgUiEvents(part: ArtifactPartWire): AgUiArtifactCustomEvent[] {
  if (part.kind === "artifact-snapshot") return [artifactSnapshotToAgUiEvent(part.snapshot)];
  return [
    ...(part.base ? [artifactSnapshotToAgUiEvent(part.base)] : []),
    ...part.events.map(artifactEventToAgUiEvent),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
