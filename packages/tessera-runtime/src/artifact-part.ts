import type { HashProvider } from "./canonical";
import { createDiagnostic, diagnosticsFromZodError } from "./diagnostics";
import { createClientReplayState, reduceClientArtifactEvent } from "./replay";
import { validateRuntimeSnapshot } from "./snapshot";
import { z } from "zod";
import {
  clientArtifactEventSchema,
  runtimeSnapshotSchema,
  type ArtifactDocument,
  type Diagnostic,
  type RuntimeSnapshot,
} from "./schemas";

const validatedArtifactPart = Symbol("data-elements.validated-artifact-part");
const validatedArtifactParts = new WeakSet<object>();

export const artifactPartWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact-snapshot"),
    snapshot: runtimeSnapshotSchema,
  }).strict(),
  z.object({
    kind: z.literal("artifact-stream"),
    base: runtimeSnapshotSchema.optional(),
    events: z.array(clientArtifactEventSchema),
  }).strict(),
]);

export type ArtifactPartWire = z.infer<typeof artifactPartWireSchema>;

export type ArtifactPart = ArtifactPartWire & {
  readonly [validatedArtifactPart]: true;
};

export type DecodeArtifactPartOptions = {
  contractFingerprint: string;
  hashProvider?: HashProvider;
};

export async function decodeArtifactPart(
  input: unknown,
  options: DecodeArtifactPartOptions,
): Promise<{ success: true; part: ArtifactPart } | { success: false; diagnostics: Diagnostic[] }> {
  const parsed = artifactPartWireSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, diagnostics: diagnosticsFromZodError(parsed.error, "transport") };
  }
  const wire = parsed.data;

  if (wire.kind === "artifact-snapshot") {
    const diagnostics = await validateSnapshot(wire.snapshot, options);
    if (diagnostics.length > 0) return { success: false, diagnostics };
    return { success: true, part: brandPart(wire) };
  }

  const diagnostics: Diagnostic[] = [];
  if (wire.base) diagnostics.push(...await validateSnapshot(wire.base, options));
  if (diagnostics.length > 0) return { success: false, diagnostics };
  const firstEvent = wire.events[0];
  let replay = createClientReplayState(wire.base);
  if (firstEvent) {
    replay.acceptedThroughSeq = firstEvent.seq - 1;
    replay.streamId = firstEvent.streamId;
    replay.contractFingerprint = firstEvent.contractFingerprint;
  }
  for (const event of wire.events) {
    if (event.contractFingerprint !== options.contractFingerprint) {
      diagnostics.push(invalidPart("Artifact stream fingerprint does not match the negotiated manifest."));
      continue;
    }
    const previousDiagnosticCount = replay.diagnostics.length;
    const reduced = await reduceClientArtifactEvent(replay, event, { hashProvider: options.hashProvider });
    if (reduced.acceptedThroughSeq !== event.seq) {
      diagnostics.push(...reduced.diagnostics.slice(previousDiagnosticCount));
      if (reduced.diagnostics.length === previousDiagnosticCount) {
        diagnostics.push(invalidPart("Artifact stream event failed semantic replay validation."));
      }
      continue;
    }
    replay = reduced;
  }
  if (diagnostics.length > 0) return { success: false, diagnostics };
  return {
    success: true,
    part: brandPart({
      kind: "artifact-stream",
      ...(wire.base ? { base: wire.base } : {}),
      events: wire.events,
    }),
  };
}

export function isArtifactPart(input: unknown): input is ArtifactPart {
  return isRecord(input)
    && input[validatedArtifactPart] === true
    && validatedArtifactParts.has(input);
}

export type ArtifactRendererValue = ArtifactPart | ArtifactDocument;

function brandPart(part: ArtifactPartWire): ArtifactPart {
  Object.defineProperty(part, validatedArtifactPart, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
  validatedArtifactParts.add(part);
  return deepFreeze(part) as ArtifactPart;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

async function validateSnapshot(
  snapshot: RuntimeSnapshot,
  options: DecodeArtifactPartOptions,
): Promise<Diagnostic[]> {
  const validation = await validateRuntimeSnapshot(snapshot, {
    expectedContractFingerprint: options.contractFingerprint,
    verifyContentHash: true,
    hashProvider: options.hashProvider,
  });
  return validation.success ? [] : validation.diagnostics;
}

function invalidPart(message: string): Diagnostic {
  return createDiagnostic({
    phase: "transport",
    code: "artifact-part.invalid",
    severity: "fatal",
    recoverable: false,
    modelCorrectable: false,
    message,
  });
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
