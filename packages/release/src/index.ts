import { createHash } from "node:crypto";
import {
  canonicalize,
  catalogCompatibilityManifestSchema,
  durableStateKey,
  type DurableStateStorePort,
  type CatalogCompatibilityManifest,
} from "@data-elements/runtime";
import { z } from "zod";

const identifier = z.string().min(1).max(512);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const artifactUIReleaseManifestSchema = z.object({
  releaseId: identifier,
  catalog: catalogCompatibilityManifestSchema,
  packages: z.record(identifier, z.object({
    version: z.string().min(1).max(128),
    tarballIntegrity: z.string().regex(/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/),
  }).strict()),
  registryItems: z.record(identifier, z.object({
    immutableUrl: z.url(),
    sha256: digest,
  }).strict()),
  migrationRanges: z.array(z.string().min(1).max(256)),
  conformanceReportId: identifier,
  publishedAt: z.iso.datetime({ offset: true }),
}).strict();

export type ArtifactUIReleaseManifest = z.infer<typeof artifactUIReleaseManifestSchema>;
export type ArtifactUIReleaseManifestInput = z.input<typeof artifactUIReleaseManifestSchema>;

export function createArtifactUIReleaseManifest(
  input: ArtifactUIReleaseManifestInput,
): Readonly<ArtifactUIReleaseManifest> {
  const manifest = artifactUIReleaseManifestSchema.parse(input);
  assertReleaseInvariants(manifest);
  return deepFreeze(manifest);
}

export function artifactUIReleaseDigest(manifest: ArtifactUIReleaseManifest): string {
  return `sha256:${createHash("sha256").update(canonicalize(manifest)).digest("hex")}`;
}

export function verifyArtifactUIReleaseManifest(
  input: unknown,
  expectedDigest?: string,
):
  | { success: true; manifest: Readonly<ArtifactUIReleaseManifest>; digest: string }
  | { success: false; reasons: readonly string[] } {
  const parsed = artifactUIReleaseManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, reasons: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  try {
    assertReleaseInvariants(parsed.data);
  } catch (error) {
    return { success: false, reasons: [error instanceof Error ? error.message : "Release invariant failed."] };
  }
  const actual = artifactUIReleaseDigest(parsed.data);
  if (expectedDigest !== undefined && actual !== expectedDigest) {
    return { success: false, reasons: ["Release manifest digest mismatch."] };
  }
  return { success: true, manifest: deepFreeze(parsed.data), digest: actual };
}

function assertReleaseInvariants(manifest: ArtifactUIReleaseManifest): void {
  if (Object.keys(manifest.packages).length === 0) throw new Error("A release must contain at least one package tarball.");
  if (Object.keys(manifest.registryItems).length === 0) throw new Error("A release must contain at least one immutable registry item.");
  if (manifest.catalog.catalogReleaseId !== manifest.releaseId) {
    throw new Error("Catalog release identity must equal the release manifest identity.");
  }
  const releasePath = `/r/${encodeURIComponent(manifest.releaseId)}/`;
  for (const item of Object.values(manifest.registryItems)) {
    const url = new URL(item.immutableUrl);
    if (url.protocol !== "https:" || !url.pathname.includes(releasePath) || url.search || url.hash) {
      throw new Error(`Registry URLs must be immutable HTTPS paths below ${releasePath}.`);
    }
  }
}

export const rolloutStages = [
  "shadow",
  "internal",
  "tenant-canary",
  "provider-canary",
  "opt-in",
  "default",
] as const;
export type RolloutStage = typeof rolloutStages[number];

export type ArtifactUIRolloutPolicy = {
  releaseId: string;
  stage: RolloutStage;
  internalWorkspaceIds?: readonly string[];
  tenantCanaryIds?: readonly string[];
  providerCanaryIds?: readonly string[];
  catalogCanaryIds?: readonly string[];
  percentage?: number;
};

export type ArtifactUIRolloutContext = {
  tenantId: string;
  conversationId: string;
  providerId: string;
  catalogReleaseId: string;
  workspaceId?: string;
  optedIn?: boolean;
  clientSupportsV2: boolean;
  manifestCompatible: boolean;
};

export type ArtifactUIRolloutDecision = Readonly<{
  releaseId: string;
  mode: "v1" | "shadow-v2" | "v2";
  reason: string;
}>;

export function evaluateArtifactUIRollout(
  policy: ArtifactUIRolloutPolicy,
  context: ArtifactUIRolloutContext,
): ArtifactUIRolloutDecision {
  validateRolloutPolicy(policy);
  if (!context.clientSupportsV2 || !context.manifestCompatible) {
    return Object.freeze({ releaseId: policy.releaseId, mode: "v1", reason: "client-or-manifest-incompatible" });
  }
  if (policy.stage === "shadow") {
    return Object.freeze({ releaseId: policy.releaseId, mode: "shadow-v2", reason: "shadow-validation-only" });
  }
  const internal = context.workspaceId !== undefined && policy.internalWorkspaceIds?.includes(context.workspaceId);
  const tenant = policy.tenantCanaryIds?.includes(context.tenantId);
  const provider = policy.providerCanaryIds?.includes(context.providerId)
    && (!policy.catalogCanaryIds?.length || policy.catalogCanaryIds.includes(context.catalogReleaseId));
  const eligible = policy.stage === "internal" ? internal
    : policy.stage === "tenant-canary" ? internal || tenant
    : policy.stage === "provider-canary" ? internal || tenant || provider
    : policy.stage === "opt-in" ? internal || tenant || provider || context.optedIn === true
    : true;
  const bucketEligible = stableRolloutBucket(policy.releaseId, context) < (policy.percentage ?? 100);
  return eligible && bucketEligible
    ? Object.freeze({ releaseId: policy.releaseId, mode: "v2", reason: `${policy.stage}-eligible` })
    : Object.freeze({ releaseId: policy.releaseId, mode: "v1", reason: `${policy.stage}-not-eligible` });
}

function validateRolloutPolicy(policy: ArtifactUIRolloutPolicy): void {
  if (!policy.releaseId.trim() || !rolloutStages.includes(policy.stage)) throw new TypeError("Invalid rollout policy.");
  const percentage = policy.percentage ?? 100;
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new TypeError("Rollout percentage must be between zero and one hundred.");
  }
}

function stableRolloutBucket(releaseId: string, context: ArtifactUIRolloutContext): number {
  const key = [releaseId, context.tenantId, context.conversationId, context.providerId, context.catalogReleaseId].join("\u0000");
  return createHash("sha256").update(key).digest().readUInt32BE(0) / 0x1_0000_0000 * 100;
}

export type PersistedArtifactPart =
  | { artifactProtocol: "1.0"; value: unknown }
  | { artifactProtocol: "2.0"; value: unknown };

export type ArtifactProtocolReaders<TV1, TV2> = {
  readV1(value: unknown): TV1;
  readV2(value: unknown): TV2;
};

export function readPersistedArtifactPart<TV1, TV2>(
  part: PersistedArtifactPart,
  readers: ArtifactProtocolReaders<TV1, TV2>,
): TV1 | TV2 {
  return part.artifactProtocol === "1.0" ? readers.readV1(part.value) : readers.readV2(part.value);
}

export async function writeArtifactTurn<T>(
  decision: ArtifactUIRolloutDecision,
  generate: (protocol: "1.0" | "2.0") => T | Promise<T>,
  persist: (part: PersistedArtifactPart) => void | Promise<void>,
): Promise<PersistedArtifactPart> {
  const protocol = decision.mode === "v2" ? "2.0" : "1.0";
  const value = await generate(protocol);
  const part = { artifactProtocol: protocol, value } as PersistedArtifactPart;
  await persist(part);
  return part;
}

export class InMemoryReleaseAliasStore {
  readonly #releases = new Map<string, { manifest: Readonly<ArtifactUIReleaseManifest>; digest: string }>();
  readonly #aliases = new Map<string, string>();

  register(manifestInput: ArtifactUIReleaseManifest): string {
    const manifest = createArtifactUIReleaseManifest(manifestInput);
    const hash = artifactUIReleaseDigest(manifest);
    const existing = this.#releases.get(manifest.releaseId);
    if (existing && existing.digest !== hash) throw new Error("An immutable release id cannot be overwritten.");
    if (!existing) this.#releases.set(manifest.releaseId, { manifest, digest: hash });
    return hash;
  }

  resolve(aliasOrReleaseId: string): Readonly<ArtifactUIReleaseManifest> | undefined {
    const releaseId = this.#aliases.get(aliasOrReleaseId) ?? aliasOrReleaseId;
    return this.#releases.get(releaseId)?.manifest;
  }

  digest(releaseId: string): string | undefined {
    return this.#releases.get(releaseId)?.digest;
  }

  alias(alias: string): string | undefined {
    return this.#aliases.get(alias);
  }

  compareAndSwapAlias(alias: string, expected: string | undefined, next: string): boolean {
    if (!this.#releases.has(next)) throw new Error(`Unknown release "${next}".`);
    if (this.#aliases.get(alias) !== expected) return false;
    this.#aliases.set(alias, next);
    return true;
  }
}

export type Awaitable<T> = T | Promise<T>;

/**
 * Minimal release read/write port. Existing synchronous stores remain valid;
 * production adapters can be asynchronous without changing callers.
 */
export interface ArtifactUIReleaseStorePort {
  register(manifestInput: ArtifactUIReleaseManifest): Awaitable<string>;
  resolve(aliasOrReleaseId: string): Awaitable<Readonly<ArtifactUIReleaseManifest> | undefined>;
  digest(releaseId: string): Awaitable<string | undefined>;
  alias(alias: string): Awaitable<string | undefined>;
  compareAndSwapAlias(alias: string, expected: string | undefined, next: string): Awaitable<boolean>;
}

export type ReleaseAliasState = Readonly<{
  releaseId?: string;
  version: number;
}>;

export type ReleaseAliasTransition = {
  alias: string;
  expected: ReleaseAliasState;
  nextReleaseId: string;
  idempotencyKey: string;
  actorId: string;
  correlationId: string;
};

export type ReleaseAliasEvent = Readonly<{
  eventId: string;
  alias: string;
  fromReleaseId?: string;
  toReleaseId: string;
  version: number;
  actorId: string;
  correlationId: string;
  idempotencyKey: string;
  recordedAt: string;
}>;

export type ReleaseAliasTransitionResult =
  | { status: "moved"; state: ReleaseAliasState; eventId: string }
  | { status: "conflict"; state: ReleaseAliasState }
  | { status: "unknown-release" }
  | { status: "idempotency-conflict" };

/**
 * Versioned control-plane operations prevent the legacy value-only CAS API
 * from accepting an ABA transition. Each successful move produces one
 * immutable audit event under the same durable transaction.
 */
export interface ReleaseAliasControlPort extends ArtifactUIReleaseStorePort {
  readAliasState(alias: string): Promise<ReleaseAliasState>;
  transitionAlias(input: ReleaseAliasTransition): Promise<ReleaseAliasTransitionResult>;
  listAliasEvents(alias?: string): Promise<readonly ReleaseAliasEvent[]>;
}

type DurableReleaseRecord = {
  manifest: ArtifactUIReleaseManifest;
  digest: string;
};

type DurableAliasRecord = {
  releaseId: string;
  version: number;
};

type DurableTransitionReplay = {
  input: ReleaseAliasTransition;
  result: Extract<ReleaseAliasTransitionResult, { status: "moved" }>;
};

export type DurableReleaseAliasStoreState = {
  formatVersion: 1;
  releases: Record<string, DurableReleaseRecord>;
  aliases: Record<string, DurableAliasRecord>;
  events: ReleaseAliasEvent[];
  idempotency: Record<string, DurableTransitionReplay>;
  nextEventSequence: number;
};

export type DurableReleaseAliasStoreOptions = {
  state: DurableStateStorePort;
  /** Isolate releases by deployment environment and catalog authority. */
  storageKey?: string;
  now?: () => string;
  eventIdFactory?: (sequence: number) => string;
};

/**
 * Durable release-control implementation backed by the host's atomic state
 * store. The manifest is immutable, aliases use value CAS for compatibility,
 * and the versioned transition API writes alias plus audit event atomically.
 */
export class DurableReleaseAliasStore implements ReleaseAliasControlPort {
  readonly #state: DurableStateStorePort;
  readonly #storageKey: string;
  readonly #now: () => string;
  readonly #eventId: (sequence: number) => string;

  constructor(options: DurableReleaseAliasStoreOptions) {
    this.#state = options.state;
    this.#storageKey = options.storageKey ?? durableStateKey("artifact-releases");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#eventId = options.eventIdFactory ?? ((sequence) => `release-alias-event:${sequence}`);
  }

  async register(manifestInput: ArtifactUIReleaseManifest): Promise<string> {
    return this.#withState(async (state) => {
      const manifest = createArtifactUIReleaseManifest(manifestInput);
      const digest = artifactUIReleaseDigest(manifest);
      const existing = state.releases[manifest.releaseId];
      if (existing && existing.digest !== digest) throw new Error("An immutable release id cannot be overwritten.");
      if (!existing) state.releases[manifest.releaseId] = { manifest, digest };
      return digest;
    }, true);
  }

  async resolve(aliasOrReleaseId: string): Promise<Readonly<ArtifactUIReleaseManifest> | undefined> {
    return this.#withState(async (state) => {
      const releaseId = state.aliases[aliasOrReleaseId]?.releaseId ?? aliasOrReleaseId;
      const stored = state.releases[releaseId];
      return verifyStoredRelease(releaseId, stored);
    });
  }

  async digest(releaseId: string): Promise<string | undefined> {
    return this.#withState(async (state) => {
      const stored = state.releases[releaseId];
      return verifyStoredRelease(releaseId, stored) ? stored?.digest : undefined;
    });
  }

  async alias(alias: string): Promise<string | undefined> {
    return this.#withState(async (state) => state.aliases[alias]?.releaseId);
  }

  async compareAndSwapAlias(alias: string, expected: string | undefined, next: string): Promise<boolean> {
    return this.#withState(async (state) => {
      if (!verifyStoredRelease(next, state.releases[next])) throw new Error(`Unknown release "${next}".`);
      const current = state.aliases[alias];
      if (current?.releaseId !== expected) return false;
      state.aliases[alias] = { releaseId: next, version: (current?.version ?? 0) + 1 };
      return true;
    }, true);
  }

  async readAliasState(alias: string): Promise<ReleaseAliasState> {
    return this.#withState(async (state) => toAliasState(state.aliases[alias]));
  }

  async transitionAlias(input: ReleaseAliasTransition): Promise<ReleaseAliasTransitionResult> {
    return this.#withState(async (state) => {
      assertReleaseAliasTransition(input);
      const replay = state.idempotency[input.idempotencyKey];
      if (replay) {
        return canonicalize(replay.input) === canonicalize(input)
          ? replay.result
          : { status: "idempotency-conflict" };
      }
      if (!verifyStoredRelease(input.nextReleaseId, state.releases[input.nextReleaseId])) return { status: "unknown-release" };
      const current = toAliasState(state.aliases[input.alias]);
      if (current.version !== input.expected.version || current.releaseId !== input.expected.releaseId) {
        return { status: "conflict", state: current };
      }
      const nextState: ReleaseAliasState = Object.freeze({ releaseId: input.nextReleaseId, version: current.version + 1 });
      state.aliases[input.alias] = { releaseId: input.nextReleaseId, version: nextState.version };
      const event: ReleaseAliasEvent = Object.freeze({
        eventId: this.#eventId(state.nextEventSequence),
        alias: input.alias,
        ...(current.releaseId ? { fromReleaseId: current.releaseId } : {}),
        toReleaseId: input.nextReleaseId,
        version: nextState.version,
        actorId: input.actorId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        recordedAt: this.#now(),
      });
      state.nextEventSequence += 1;
      state.events.push(event);
      const result: Extract<ReleaseAliasTransitionResult, { status: "moved" }> = {
        status: "moved",
        state: nextState,
        eventId: event.eventId,
      };
      state.idempotency[input.idempotencyKey] = { input: structuredClone(input), result };
      return result;
    }, true);
  }

  async listAliasEvents(alias?: string): Promise<readonly ReleaseAliasEvent[]> {
    return this.#withState(async (state) => Object.freeze(
      state.events.filter((event) => alias === undefined || event.alias === alias).map((event) => Object.freeze(structuredClone(event))),
    ));
  }

  async #withState<T>(
    operation: (state: DurableReleaseAliasStoreState) => Promise<T>,
    persist = false,
  ): Promise<T> {
    if (!persist) {
      const stored = await this.#state.read<DurableReleaseAliasStoreState>(this.#storageKey);
      return operation(readDurableReleaseState(stored));
    }
    return this.#state.transaction([this.#storageKey], async (transaction) => {
      const stored = await transaction.get<DurableReleaseAliasStoreState>(this.#storageKey);
      const state = readDurableReleaseState(stored);
      const result = await operation(state);
      await transaction.set(this.#storageKey, state);
      return result;
    });
  }
}

export type RollbackDrillResult = Readonly<{
  success: boolean;
  alias: string;
  previousReleaseId: string;
  candidateReleaseId: string;
  restoredReleaseId?: string;
  immutableHistoryPreserved: boolean;
}>;

export function runRollbackDrill(input: {
  store: InMemoryReleaseAliasStore;
  alias?: string;
  previous: ArtifactUIReleaseManifest;
  candidate: ArtifactUIReleaseManifest;
}): RollbackDrillResult {
  const alias = input.alias ?? "latest";
  const previousDigest = input.store.register(input.previous);
  const candidateDigest = input.store.register(input.candidate);
  const current = input.store.alias(alias);
  if (current === undefined && !input.store.compareAndSwapAlias(alias, undefined, input.previous.releaseId)) {
    throw new Error("Could not initialize the rollback alias.");
  }
  if (input.store.alias(alias) !== input.previous.releaseId) throw new Error("Rollback drill requires the previous release alias.");
  const promoted = input.store.compareAndSwapAlias(alias, input.previous.releaseId, input.candidate.releaseId);
  const restored = promoted && input.store.compareAndSwapAlias(alias, input.candidate.releaseId, input.previous.releaseId);
  const immutableHistoryPreserved = input.store.digest(input.previous.releaseId) === previousDigest
    && input.store.digest(input.candidate.releaseId) === candidateDigest;
  return Object.freeze({
    success: promoted && restored && immutableHistoryPreserved,
    alias,
    previousReleaseId: input.previous.releaseId,
    candidateReleaseId: input.candidate.releaseId,
    ...(restored ? { restoredReleaseId: input.previous.releaseId } : {}),
    immutableHistoryPreserved,
  });
}

export async function runRollbackDrillAsync(input: {
  store: ArtifactUIReleaseStorePort;
  alias?: string;
  previous: ArtifactUIReleaseManifest;
  candidate: ArtifactUIReleaseManifest;
}): Promise<RollbackDrillResult> {
  const alias = input.alias ?? "latest";
  const previousDigest = await input.store.register(input.previous);
  const candidateDigest = await input.store.register(input.candidate);
  const current = await input.store.alias(alias);
  if (current === undefined && !await input.store.compareAndSwapAlias(alias, undefined, input.previous.releaseId)) {
    throw new Error("Could not initialize the rollback alias.");
  }
  if (await input.store.alias(alias) !== input.previous.releaseId) throw new Error("Rollback drill requires the previous release alias.");
  const promoted = await input.store.compareAndSwapAlias(alias, input.previous.releaseId, input.candidate.releaseId);
  const restored = promoted && await input.store.compareAndSwapAlias(alias, input.candidate.releaseId, input.previous.releaseId);
  const immutableHistoryPreserved = await input.store.digest(input.previous.releaseId) === previousDigest
    && await input.store.digest(input.candidate.releaseId) === candidateDigest;
  return Object.freeze({
    success: promoted && restored && immutableHistoryPreserved,
    alias,
    previousReleaseId: input.previous.releaseId,
    candidateReleaseId: input.candidate.releaseId,
    ...(restored ? { restoredReleaseId: input.previous.releaseId } : {}),
    immutableHistoryPreserved,
  });
}

function readDurableReleaseState(state: DurableReleaseAliasStoreState | undefined): DurableReleaseAliasStoreState {
  if (!state) {
    return {
      formatVersion: 1,
      releases: {},
      aliases: {},
      events: [],
      idempotency: {},
      nextEventSequence: 1,
    };
  }
  const cloned = structuredClone(state);
  if (
    cloned.formatVersion !== 1
    || !isRecord(cloned.releases)
    || !isRecord(cloned.aliases)
    || !Array.isArray(cloned.events)
    || !isRecord(cloned.idempotency)
    || !Number.isSafeInteger(cloned.nextEventSequence)
    || cloned.nextEventSequence < 1
  ) throw new TypeError("Unsupported durable release alias store state.");
  return cloned;
}

function verifyStoredRelease(
  releaseId: string,
  stored: DurableReleaseRecord | undefined,
): Readonly<ArtifactUIReleaseManifest> | undefined {
  if (!stored) return undefined;
  const verified = verifyArtifactUIReleaseManifest(stored.manifest, stored.digest);
  if (!verified.success) throw new Error(`Stored release ${releaseId} failed verification: ${verified.reasons.join("; ")}`);
  return verified.manifest;
}

function toAliasState(record: DurableAliasRecord | undefined): ReleaseAliasState {
  return Object.freeze(record ? { releaseId: record.releaseId, version: record.version } : { version: 0 });
}

function assertReleaseAliasTransition(input: ReleaseAliasTransition): void {
  if (
    !input.alias.trim()
    || !input.nextReleaseId.trim()
    || !input.idempotencyKey.trim()
    || !input.actorId.trim()
    || !input.correlationId.trim()
    || !Number.isSafeInteger(input.expected.version)
    || input.expected.version < 0
  ) throw new TypeError("Invalid release alias transition.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export type { CatalogCompatibilityManifest };
