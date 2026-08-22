import { randomUUID } from "node:crypto";
import {
  HASH_DOMAINS,
  actionStatusSchema,
  approvalRequestedSchema,
  canonicalStringify,
  correlationIdSchema,
  hashCanonical,
  resourceResolutionResultSchema,
  stateRevisionIdSchema,
  stateValueSnapshotSchema,
  streamIdSchema,
  streamPolicySchema,
  surfaceSessionIdSchema,
  verifyCommittedRevision,
  type ActionContractRef,
  type ActionInvocationId,
  type ActionStatus,
  type ApprovalRequested,
  type CommittedRevision,
  type CorrelationId,
  type HashProvider,
  type ResourceBindingId,
  type ResourceResolutionResult,
  type StateId,
  type StateValueSnapshot,
} from "@open-generative/protocol";
import {
  actionContractRefKey,
  contractRefKey,
  createCatalogSetSlice,
  negotiateRendererCapabilities,
  verifyRendererCapabilityManifest,
  type CatalogManifest,
  type GenerationLimits,
  type ModelVisibleEvidenceOffer,
  type ModelVisibleResourceOffer,
  type PlacementContext,
  type RendererCapabilityManifest,
  type RendererCapabilityRequirement,
} from "@open-generative/catalog";
import { z } from "zod";
import { createAuthorityContext, hashAudienceBinding, type AuthorityContext } from "./authority";
import type { SurfaceSessionJournal } from "./surface-journal";
import type { SurfaceSessionRecord } from "./surface-store";

export type OpenSurfaceSessionInput = Readonly<{
  authority: AuthorityContext;
  rendererCapabilityManifest: RendererCapabilityManifest;
  catalogs: readonly CatalogManifest[];
  rendererRequirements: readonly RendererCapabilityRequirement[];
  actionContracts: readonly ActionContractRef[];
  resourceOffers: readonly ModelVisibleResourceOffer[];
  evidenceOffers: readonly ModelVisibleEvidenceOffer[];
  placement: PlacementContext;
  generationLimits: GenerationLimits;
  providerSchemaProfile: string;
  committedRevision: CommittedRevision;
  state?: Readonly<Partial<Record<StateId, StateValueSnapshot>>>;
  resources?: Readonly<Partial<Record<ResourceBindingId, ResourceResolutionResult>>>;
  actions?: Readonly<Partial<Record<ActionInvocationId, ActionStatus>>>;
  approvals?: readonly ApprovalRequested[];
  streamPolicy: Omit<SurfaceSessionRecord["streamPolicy"], "cursorExpiresAt">;
  expiresAt: string;
  correlationId: CorrelationId;
}>;

export type OpenSurfaceSessionResult = Awaited<ReturnType<SurfaceSessionJournal["create"]>>;

export class SurfaceSessionManager {
  readonly #journal: SurfaceSessionJournal;
  readonly #now: () => Date;
  readonly #surfaceSessionIdFactory: () => string;
  readonly #streamIdFactory: () => string;
  readonly #hashProvider?: HashProvider;

  constructor(input: Readonly<{
    journal: SurfaceSessionJournal;
    now?: () => Date;
    surfaceSessionIdFactory?: () => string;
    streamIdFactory?: () => string;
    hashProvider?: HashProvider;
  }>) {
    this.#journal = input.journal;
    this.#now = input.now ?? (() => new Date());
    this.#surfaceSessionIdFactory = input.surfaceSessionIdFactory ?? (() => `surface:${randomUUID()}`);
    this.#streamIdFactory = input.streamIdFactory ?? (() => `stream:${randomUUID()}`);
    this.#hashProvider = input.hashProvider;
  }

  async open(input: OpenSurfaceSessionInput): Promise<OpenSurfaceSessionResult> {
    const authority = createAuthorityContext(input.authority);
    const [rendererCapabilityManifest, validRevision, rendererNegotiation] = await Promise.all([
      verifyRendererCapabilityManifest(input.rendererCapabilityManifest, this.#hashProvider),
      verifyCommittedRevision(input.committedRevision, this.#hashProvider),
      negotiateRendererCapabilities({
        catalogs: [...input.catalogs],
        renderer: input.rendererCapabilityManifest,
        placement: input.placement,
        requirements: [...input.rendererRequirements],
      }, this.#hashProvider),
    ]);
    if (!validRevision) {
      throw new SurfaceSessionError("surface.revision-invalid", "Committed revision failed content-hash verification.");
    }
    if (rendererNegotiation.rejected.length > 0) {
      throw new SurfaceSessionError(
        "surface.renderer-incomplete",
        `Renderer rejected ${rendererNegotiation.rejected.length} required Component Contracts.`,
      );
    }
    const catalogSlice = await createCatalogSetSlice({
      catalogs: [...input.catalogs],
      rendererNegotiation,
      components: input.rendererRequirements.map((requirement) => requirement.contract.ref),
      actions: [...input.actionContracts],
      resources: [...input.resourceOffers],
      evidence: [...input.evidenceOffers],
      limits: input.generationLimits,
      providerSchemaProfile: input.providerSchemaProfile,
    }, this.#hashProvider);
    assertRevisionCatalogLock(input.committedRevision, catalogSlice);

    const createdAt = this.#now().toISOString();
    const expiresAt = new Date(input.expiresAt).toISOString();
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new SurfaceSessionError("surface.expiry-invalid", "Surface session expiry must be in the future.");
    }
    const surfaceSessionId = surfaceSessionIdSchema.parse(this.#surfaceSessionIdFactory());
    const streamId = streamIdSchema.parse(this.#streamIdFactory());
    const [state, resources, actions, approvals] = await Promise.all([
      initializeState(surfaceSessionId, input.committedRevision, input.state ?? {}, this.#hashProvider),
      Promise.resolve(validateResources(input.committedRevision, input.resources ?? {})),
      Promise.resolve(validateActions(input.actions ?? {})),
      Promise.resolve(input.approvals?.map((approval) => approvalRequestedSchema.parse(approval)) ?? []),
    ]);
    const streamPolicy = streamPolicySchema.parse({ ...input.streamPolicy, cursorExpiresAt: expiresAt });
    const record: SurfaceSessionRecord = {
      surfaceSessionId,
      streamId,
      epoch: 1,
      authority,
      audienceBindingHash: hashAudienceBinding(authority),
      rendererCapabilityManifest,
      catalogSlice,
      committedRevision: input.committedRevision,
      streamPolicy,
      state,
      resources,
      actions,
      approvals,
      commandReceipts: {},
      acknowledgedThrough: 0,
      createdAt,
      expiresAt,
    };
    return this.#journal.create(record, {
      correlationId: correlationIdSchema.parse(input.correlationId),
      payload: {
        type: "snapshot-published",
        snapshot: {
          revision: record.committedRevision,
          state: record.state,
          resources: record.resources,
          actions: record.actions,
          approvals: record.approvals,
        },
        streamPolicy: record.streamPolicy,
      },
    });
  }
}

export class SurfaceSessionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SurfaceSessionError";
  }
}

async function initializeState(
  surfaceSessionId: ReturnType<typeof surfaceSessionIdSchema.parse>,
  revision: CommittedRevision,
  supplied: Readonly<Partial<Record<StateId, StateValueSnapshot>>>,
  provider?: HashProvider,
): Promise<Record<StateId, StateValueSnapshot>> {
  for (const stateId of Object.keys(supplied) as StateId[]) {
    if (!revision.content.stateDefinitions[stateId]) {
      throw new SurfaceSessionError("surface.state-unknown", `Initial state ${stateId} has no committed definition.`);
    }
  }
  const entries = await Promise.all((Object.entries(revision.content.stateDefinitions) as Array<[
    StateId,
    CommittedRevision["content"]["stateDefinitions"][StateId],
  ]>).map(async ([stateId, definition]) => {
    const existing = supplied[stateId];
    if (existing) {
      const parsed = stateValueSnapshotSchema.parse(existing);
      if (
        parsed.stateId !== stateId
        || parsed.schemaHash !== definition.schemaHash
        || parsed.scope !== definition.scope
      ) throw new SurfaceSessionError("surface.state-mismatch", `Initial state ${stateId} does not match its definition.`);
      validateJsonSchema(definition.schema, parsed.value, `Initial state ${stateId}`);
      return [stateId, parsed] as const;
    }
    validateJsonSchema(definition.schema, definition.initial, `Initial state ${stateId}`);
    const stateRevisionId = stateRevisionIdSchema.parse(await hashCanonical(HASH_DOMAINS.operationPayload, {
      kind: "surface-session-initial-state",
      surfaceSessionId,
      revisionId: revision.envelope.revisionId,
      stateId,
      schemaHash: definition.schemaHash,
      value: definition.initial,
    }, provider));
    return [stateId, stateValueSnapshotSchema.parse({
      stateId,
      stateRevisionId,
      schemaHash: definition.schemaHash,
      scope: definition.scope,
      value: definition.initial,
    })] as const;
  }));
  return Object.fromEntries(entries) as Record<StateId, StateValueSnapshot>;
}

function validateResources(
  revision: CommittedRevision,
  supplied: Readonly<Partial<Record<ResourceBindingId, ResourceResolutionResult>>>,
): Record<ResourceBindingId, ResourceResolutionResult> {
  const resources = {} as Record<ResourceBindingId, ResourceResolutionResult>;
  for (const [bindingIdText, value] of Object.entries(supplied)) {
    const bindingId = bindingIdText as ResourceBindingId;
    if (!revision.content.resourceBindings[bindingId]) {
      throw new SurfaceSessionError("surface.resource-unknown", `Initial resource ${bindingId} has no committed binding.`);
    }
    const parsed = resourceResolutionResultSchema.parse(value);
    const parsedId = parsed.status === "resolved" ? parsed.snapshot.bindingId : parsed.unavailable.bindingId;
    if (parsedId !== bindingId) {
      throw new SurfaceSessionError("surface.resource-mismatch", `Initial resource ${bindingId} has mismatched identity.`);
    }
    resources[bindingId] = parsed;
  }
  return resources;
}

function validateActions(
  supplied: Readonly<Partial<Record<ActionInvocationId, ActionStatus>>>,
): Record<ActionInvocationId, ActionStatus> {
  const actions = {} as Record<ActionInvocationId, ActionStatus>;
  for (const [invocationIdText, value] of Object.entries(supplied)) {
    const invocationId = invocationIdText as ActionInvocationId;
    const parsed = actionStatusSchema.parse(value);
    if (parsed.invocationId !== invocationId) {
      throw new SurfaceSessionError("surface.action-mismatch", `Initial action ${invocationId} has mismatched identity.`);
    }
    actions[invocationId] = parsed;
  }
  return actions;
}

export function assertRevisionCatalogLock(
  revision: CommittedRevision,
  slice: Awaited<ReturnType<typeof createCatalogSetSlice>>,
): void {
  if (
    revision.content.contracts.contractSetHash !== slice.contractSetHash
    || canonicalStringify(revision.content.contracts.manifestRefs) !== canonicalStringify(slice.manifests)
  ) throw new SurfaceSessionError("surface.catalog-lock-mismatch", "Revision Contract lock does not match the negotiated Catalog slice.");
  const components = new Set(slice.components.map((entry) => contractRefKey(entry.contract)));
  for (const node of Object.values(revision.content.nodes)) {
    if (!components.has(contractRefKey(node.contract))) {
      throw new SurfaceSessionError("surface.component-not-negotiated", "Revision contains a Component Contract not negotiated by the renderer.");
    }
  }
  const actions = new Set(slice.actions.map((entry) => actionContractRefKey(entry.contract)));
  for (const action of Object.values(revision.content.actions)) {
    if (action.kind === "host-intent" && !actions.has(actionContractRefKey(action.contract))) {
      throw new SurfaceSessionError("surface.action-not-negotiated", "Revision contains a HostIntent Contract outside the Catalog slice.");
    }
  }
}

function validateJsonSchema(schema: Parameters<typeof z.fromJSONSchema>[0], value: unknown, label: string): void {
  const parsed = z.fromJSONSchema(schema).safeParse(value);
  if (!parsed.success) throw new SurfaceSessionError("surface.state-schema-invalid", `${label} failed its exact JSON Schema.`);
}
