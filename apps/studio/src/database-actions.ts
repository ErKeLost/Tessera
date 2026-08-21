import { createHash, randomUUID } from "node:crypto";
import {
  CapabilityBroker,
  DefaultCapabilityOutputPolicy,
  DurableCapabilityGrantStore,
  DurableEffectStore,
  InMemoryCapabilityHandlerRegistry,
  JsonOutputCodec,
  type ActorContext,
  type ApprovalCheckpoint,
  type CapabilityAuthorityPort,
  type CapabilityGrant,
  type CapabilityHandler,
  type CapabilityOutputCommitPort,
  type EffectCancellationReceipt,
  type EffectExecutionResult,
  type JsonSchema,
  type ModelVisibleGrantSet,
  type PolicyEvaluatorPort,
  type PublicationResult,
  type Sensitivity,
  type ValidatedOutputCommit,
} from "@data-elements/capability-broker";
import { compilerSchemaProfile } from "@data-elements/compiler";
import {
  compileDatabaseMutation,
  assertDatabaseActionCatalogBinding,
  bindDatabaseActionRowPredicates,
  createDatabaseActionHash,
  databaseActionSchema,
  databaseRowPredicateBindingSchema,
  databaseMutationResultSchema,
  evaluateDatabaseActionPolicy,
  isDatabaseMutationExecutor,
  type DatabaseAction,
  type DatabaseActionPermissionGrant,
  type DatabaseCatalog,
  type DatabaseConnector,
  type DatabaseMutationResult,
  type DatabasePermissionActor,
  type DatabaseRowPredicateBinding,
  type DatabaseScopedPermissionPolicy,
} from "@data-elements/database";
import {
  canonicalHash,
  canonicalize,
  type DurableStateStorePort,
  type JsonValue,
} from "@data-elements/runtime";
import { z } from "zod";

const HANDLER_REF = "studio.database-mutate";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CALLS = 256;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DATABASE_ACTION_DOCUMENT_PREFIX = "database-action-document";

const databaseActionInvocationSchema = z.object({
  action: databaseActionSchema,
  purpose: z.string().trim().min(1).max(1_000),
  requireApproval: z.boolean(),
  /** Internal server binding; public submit input never accepts this field. */
  boundRowPredicates: z.array(databaseRowPredicateBindingSchema).max(1_024).optional(),
}).strict();

const databaseActionResultSchema = databaseMutationResultSchema.extend({
  actionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  catalogFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

const databaseActionInputSchema = boundedObjectSchema({
  action: boundedObjectSchema({}, [], 64, boundedJsonSchema(6)),
  purpose: { type: "string", minLength: 1, maxLength: 1_000 },
  requireApproval: { type: "boolean" },
  boundRowPredicates: {
    type: "array",
    minItems: 0,
    maxItems: 1_024,
    items: boundedObjectSchema({}, ["ref", "predicate"], 2, boundedJsonSchema(6)),
  },
}, ["action", "purpose", "requireApproval"]);

const databaseActionOutputSchema = boundedObjectSchema({
  mutationId: { type: "string", minLength: 1, maxLength: 256 },
  queryId: { type: "string", minLength: 1, maxLength: 256 },
  affectedRows: { type: "integer", minimum: 0, maximum: 10_000 },
  columns: {
    type: "array",
    minItems: 0,
    maxItems: 2_000,
    items: boundedObjectSchema({
      name: { type: "string", minLength: 1, maxLength: 256 },
      dataTypeId: { type: "integer", minimum: 0, maximum: 4_294_967_295 },
    }, ["name"]),
  },
  rows: {
    type: "array",
    minItems: 0,
    maxItems: 10_000,
    items: boundedObjectSchema({}, [], 2_000, boundedJsonSchema(6)),
  },
  truncated: { type: "boolean" },
  durationMs: { type: "number", minimum: 0, maximum: 120_000 },
  actionHash: { type: "string", minLength: 71, maxLength: 71 },
  catalogFingerprint: { type: "string", minLength: 71, maxLength: 71 },
}, [
  "mutationId",
  "queryId",
  "affectedRows",
  "columns",
  "rows",
  "truncated",
  "durationMs",
  "actionHash",
  "catalogFingerprint",
]);

const capabilitySchemaHashes = Promise.all([
  canonicalHash(databaseActionInputSchema),
  canonicalHash(databaseActionOutputSchema),
]);

export type TesseraDatabaseActionActor = Readonly<{
  /** Authenticated tenant identity. Never source this from a model request. */
  tenantRef: string;
  /** Authenticated subject identity. Never source this from a model request. */
  actorRef: string;
  /** Stable server-side session or principal-context reference. */
  actorContextRef?: string;
  /** Server-derived role memberships used by scoped permission rules. */
  roleRefs?: readonly string[];
  /** Additional server-issued resource scopes. The database scope is added automatically. */
  resourceScopeRefs?: readonly string[];
  /** Defaults to public and private. Database mutation output is private. */
  allowedSensitivity?: readonly Sensitivity[];
}>;

export type TesseraDatabaseActionResult = DatabaseMutationResult & Readonly<{
  actionHash: `sha256:${string}`;
  catalogFingerprint: `sha256:${string}`;
}>;

export type TesseraDatabaseActionEffect = EffectExecutionResult & Readonly<{
  result?: TesseraDatabaseActionResult;
}>;

export type TesseraDatabaseActionSubmitInput = Readonly<{
  actor: TesseraDatabaseActionActor;
  action: DatabaseAction;
  purpose: string;
  /** Tightens policy for this request. It can require approval, never bypass it. */
  requireApproval?: boolean;
  /** Supplying the same request id makes transport retries replay-safe. */
  requestId?: string;
  invocationId?: string;
  stepId?: string;
  actionId?: string;
  /** Defaults to requestId. Use a stable client operation id for retry-safe writes. */
  idempotencyKey?: string;
}>;

export type TesseraDatabaseActionGetInput = Readonly<{
  actor: TesseraDatabaseActionActor;
  requestId: string;
}>;

export type TesseraDatabaseActionApprovalInput = TesseraDatabaseActionGetInput & Readonly<{
  checkpointId: string;
}>;

export type TesseraDatabaseActionCancelInput = TesseraDatabaseActionGetInput & Readonly<{
  cancelRequestId?: string;
}>;

type ResolveValue<T> = T | (() => T | Promise<T>);

export type CreateTesseraDatabaseActionServiceOptions = Readonly<{
  connector: DatabaseConnector;
  state: DurableStateStorePort;
  /** Uses connector introspection when omitted. Pass the Studio catalog boundary when one is available. */
  getCatalog?: (signal?: AbortSignal) => Promise<DatabaseCatalog>;
  /** May be a live provider so changing Settings invalidates pending approvals. */
  policy: ResolveValue<DatabaseScopedPermissionPolicy>;
  /** Server-issued session/project grants. They can resolve ASK, never DENY. */
  permissionGrants?: (actor: DatabasePermissionActor) => readonly DatabaseActionPermissionGrant[] | Promise<readonly DatabaseActionPermissionGrant[]>;
  /** Resolves role memberships after a process restart when roles are not supplied with the actor. */
  resolveRoleRefs?: (actor: Pick<DatabasePermissionActor, "tenantRef" | "actorRef">) => readonly string[] | Promise<readonly string[]>;
  /**
   * Server-generated row predicates. They are bound into the effective action
   * before policy evaluation, approval, hashing, and SQL compilation.
   */
  resolveRowPredicates?: (input: {
    actor: DatabasePermissionActor;
    action: DatabaseAction;
  }) => readonly DatabaseRowPredicateBinding[] | Promise<readonly DatabaseRowPredicateBinding[]>;
  /** Defaults to same-tenant confirmation by the requesting actor. */
  authorizeApproval?: (input: {
    requester: DatabasePermissionActor;
    approver: DatabasePermissionActor;
    checkpoint: ApprovalCheckpoint;
  }) => boolean | Promise<boolean>;
  timeoutMs?: number;
  approvalTtlMs?: number;
  idempotencyRetentionMs?: number;
  maxCalls?: number;
  maxOutputBytes?: number;
  now?: () => string;
  idFactory?: (prefix: string) => string;
}>;

export type TesseraDatabaseActionService = Readonly<{
  submit(input: TesseraDatabaseActionSubmitInput): Promise<TesseraDatabaseActionEffect>;
  get(input: TesseraDatabaseActionGetInput): Promise<TesseraDatabaseActionEffect>;
  approve(input: TesseraDatabaseActionApprovalInput): Promise<TesseraDatabaseActionEffect>;
  reject(input: TesseraDatabaseActionApprovalInput): Promise<TesseraDatabaseActionEffect>;
  cancel(input: TesseraDatabaseActionCancelInput): Promise<EffectCancellationReceipt>;
  capabilities(input: { actor: TesseraDatabaseActionActor }): Promise<ModelVisibleGrantSet>;
}>;

/**
 * A durable execution boundary for typed database mutations. Existing Data
 * Agent reads remain untouched: this service has no raw-SQL entry point.
 */
export function createTesseraDatabaseActionService(
  options: CreateTesseraDatabaseActionServiceOptions,
): TesseraDatabaseActionService {
  const catalogProvider = options.getCatalog ?? ((signal?: AbortSignal) => options.connector.introspect(undefined, signal));
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.idFactory ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const databaseScopeRef = `database:${options.connector.id}`;
  const documentId = `${DATABASE_ACTION_DOCUMENT_PREFIX}-${stableToken(options.connector.id)}`;
  const actorProfiles = new Map<string, DatabasePermissionActor>();

  const normalizeConnectionRef = (action: DatabaseAction): DatabaseAction => (
    action.connectionRef === "tessera"
      ? databaseActionSchema.parse({ ...action, connectionRef: options.connector.id })
      : action
  );

  const getCatalog = async (signal?: AbortSignal): Promise<DatabaseCatalog> => {
    const catalog = await catalogProvider(signal);
    if (catalog.connectorId !== options.connector.id || catalog.dialect !== options.connector.dialect) {
      throw new Error("Database action catalog does not belong to the configured connector.");
    }
    return catalog;
  };

  const resolvePolicy = async (): Promise<DatabaseScopedPermissionPolicy> => resolveValue(options.policy);

  const resolveRowPredicates = async (
    action: DatabaseAction,
    actor: DatabasePermissionActor,
  ): Promise<readonly DatabaseRowPredicateBinding[]> => {
    const bindings = (await options.resolveRowPredicates?.({ actor, action }) ?? [])
      .map((binding) => databaseRowPredicateBindingSchema.parse(binding))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const duplicate = bindings.find((binding, index) => binding.ref === bindings[index - 1]?.ref);
    if (duplicate) throw new Error(`Row predicate binding "${duplicate.ref}" is duplicated.`);
    return bindings;
  };

  const bindAction = async (
    action: DatabaseAction,
    catalog: DatabaseCatalog,
    actor: DatabasePermissionActor,
  ): Promise<{
    action: DatabaseAction;
    bindings: readonly DatabaseRowPredicateBinding[];
    rowPredicateRefs: readonly string[];
  }> => {
    const catalogBound = assertDatabaseActionCatalogBinding(normalizeConnectionRef(action), catalog);
    const bindings = await resolveRowPredicates(catalogBound, actor);
    return {
      action: bindDatabaseActionRowPredicates(catalogBound, bindings),
      bindings,
      rowPredicateRefs: bindings.map((binding) => binding.ref),
    };
  };

  const verifyBoundAction = async (
    invocation: z.infer<typeof databaseActionInvocationSchema>,
    catalog: DatabaseCatalog,
    actor: DatabasePermissionActor,
  ): Promise<{ action: DatabaseAction; rowPredicateRefs: readonly string[] } | undefined> => {
    try {
      const action = assertDatabaseActionCatalogBinding(normalizeConnectionRef(invocation.action), catalog);
      const [stored, expected] = await Promise.all([
        Promise.resolve(normalizeRowPredicates(invocation.boundRowPredicates ?? [])),
        resolveRowPredicates(action, actor),
      ]);
      if (canonicalize(stored) !== canonicalize(expected)) return undefined;
      return {
        action: bindDatabaseActionRowPredicates(action, expected),
        rowPredicateRefs: expected.map((binding) => binding.ref),
      };
    } catch {
      return undefined;
    }
  };

  const toActorContext = async (input: TesseraDatabaseActionActor): Promise<ActorContext> => {
    const actorContextRef = input.actorContextRef ?? `database-actor-${stableToken(`${input.tenantRef}\u0000${input.actorRef}`)}`;
    const roleRefs = input.roleRefs ?? await options.resolveRoleRefs?.({
      tenantRef: input.tenantRef,
      actorRef: input.actorRef,
    }) ?? [];
    const permissionActor: DatabasePermissionActor = {
      tenantRef: input.tenantRef,
      actorRef: input.actorRef,
      roleRefs: [...new Set(roleRefs)],
    };
    actorProfiles.set(actorContextRef, permissionActor);
    return {
      tenantRef: input.tenantRef,
      actorRef: input.actorRef,
      actorContextRef,
      resourceScopeRefs: [...new Set([databaseScopeRef, ...(input.resourceScopeRefs ?? [])])],
      allowedSensitivity: [...new Set<Sensitivity>(input.allowedSensitivity ?? ["public", "private"])],
    };
  };

  const resolvePermissionActor = async (actor: ActorContext): Promise<DatabasePermissionActor> => {
    const known = actorProfiles.get(actor.actorContextRef);
    if (known) return known;
    const roleRefs = await options.resolveRoleRefs?.({ tenantRef: actor.tenantRef, actorRef: actor.actorRef }) ?? [];
    return { tenantRef: actor.tenantRef, actorRef: actor.actorRef, roleRefs: [...new Set(roleRefs)] };
  };

  const createAuthority = (): CapabilityAuthorityPort => ({
    authorize: async ({ actor, request }) => {
      const [policy, catalog] = await Promise.all([resolvePolicy(), getCatalog()]);
      const reasonCodes: string[] = [];
      if (request.documentId !== documentId) reasonCodes.push("authority.document-mismatch");
      if (request.branchId !== "main") reasonCodes.push("authority.branch-mismatch");
      if (request.revisionId !== policy.policyHash) reasonCodes.push("authority.policy-stale");
      if (request.expectedHeadToken !== catalog.fingerprint) reasonCodes.push("authority.catalog-stale");
      if (!actor.resourceScopeRefs.includes(databaseScopeRef)) reasonCodes.push("authority.resource-denied");
      return {
        allowed: reasonCodes.length === 0,
        reasonCodes,
        revisionId: policy.policyHash,
        headToken: catalog.fingerprint,
        stateRevisions: {},
      };
    },
    authorizeApproval: async ({ actor, approver, checkpoint }) => {
      const [requester, approverActor] = await Promise.all([
        resolvePermissionActor(actor),
        resolvePermissionActor(approver),
      ]);
      const allowed = options.authorizeApproval
        ? await options.authorizeApproval({ requester, approver: approverActor, checkpoint })
        : requester.tenantRef === approverActor.tenantRef && requester.actorRef === approverActor.actorRef;
      return { allowed, reasonCodes: allowed ? ["approval.authorized"] : ["approval.actor-denied"] };
    },
  });

  const createPolicyEvaluator = (): PolicyEvaluatorPort => ({
    evaluate: async ({ phase, request, actor, authority, approved }) => {
      const [policy, catalog] = await Promise.all([resolvePolicy(), getCatalog()]);
      if (!authority.allowed) {
        return { outcome: "deny", reasonCodes: authority.reasonCodes, policyHash: policy.policyHash };
      }
      const invocation = databaseActionInvocationSchema.parse(request.resolvedInput);
      const permissionActor = await resolvePermissionActor(actor);
      const [grants, bound] = await Promise.all([
        options.permissionGrants?.(permissionActor) ?? [],
        verifyBoundAction(invocation, catalog, permissionActor),
      ]);
      if (!bound) return { outcome: "deny", reasonCodes: ["database.row-predicate-stale"], policyHash: policy.policyHash };
      const evaluation = evaluateDatabaseActionPolicy(policy, {
        action: bound.action,
        actor: permissionActor,
        grants,
        trustedRowPredicateRefs: bound.rowPredicateRefs,
      });
      if (evaluation.outcome === "deny") {
        return { outcome: "deny", reasonCodes: [...evaluation.reasonCodes], policyHash: evaluation.policyHash };
      }
      if (invocation.requireApproval) {
        if (phase === "initial") {
          return {
            outcome: "require-approval",
            reasonCodes: ["request.approval-required", ...evaluation.reasonCodes],
            policyHash: evaluation.policyHash,
          };
        }
        return approved
          ? { outcome: "allow", reasonCodes: ["request.approved", ...evaluation.reasonCodes], policyHash: evaluation.policyHash }
          : { outcome: "deny", reasonCodes: ["request.approval-missing"], policyHash: evaluation.policyHash };
      }
      if (evaluation.outcome === "require-approval") {
        if (phase === "initial") {
          return { outcome: "require-approval", reasonCodes: [...evaluation.reasonCodes], policyHash: evaluation.policyHash };
        }
        return approved
          ? { outcome: "allow", reasonCodes: [...evaluation.reasonCodes], policyHash: evaluation.policyHash }
          : { outcome: "deny", reasonCodes: ["policy.approval-missing"], policyHash: evaluation.policyHash };
      }
      return { outcome: evaluation.outcome, reasonCodes: [...evaluation.reasonCodes], policyHash: evaluation.policyHash };
    },
  });

  const createMutationHandler = (): CapabilityHandler => ({
    execute: async ({ request, actor, signal }) => {
      const invocation = databaseActionInvocationSchema.parse(request.resolvedInput);
      if (invocation.action.kind === "data.read") throw new Error("Read actions stay on the Data Agent path.");
      const [catalog, policy, permissionActor] = await Promise.all([
        getCatalog(signal),
        resolvePolicy(),
        resolvePermissionActor(actor),
      ]);
      const [grants, bound] = await Promise.all([
        options.permissionGrants?.(permissionActor) ?? [],
        verifyBoundAction(invocation, catalog, permissionActor),
      ]);
      if (!bound) throw new Error("Database action row-predicate binding is stale.");
      if (bound.action.kind === "data.read") throw new Error("Read actions stay on the Data Agent path.");
      const evaluation = evaluateDatabaseActionPolicy(policy, {
        action: bound.action,
        actor: permissionActor,
        grants,
        trustedRowPredicateRefs: bound.rowPredicateRefs,
      });
      if (evaluation.outcome === "deny") throw new Error("Database action is denied by the current permission policy.");
      if (!isDatabaseMutationExecutor(options.connector)) {
        throw new Error("The configured database connector does not implement mutations.");
      }
      const plan = compileDatabaseMutation({
        action: bound.action,
        catalog,
        purpose: invocation.purpose,
      });
      const mutation = await options.connector.mutate({
        mutationId: mutationIdFor(request.requestId),
        plan,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }, signal);
      const result = databaseActionResultSchema.parse({
        ...mutation,
        actionHash: createDatabaseActionHash(bound.action),
        catalogFingerprint: catalog.fingerprint,
      }) as TesseraDatabaseActionResult;
      return {
        bytes: new TextEncoder().encode(JSON.stringify(result)),
        mediaType: "application/json",
        scopeRef: databaseScopeRef,
        sensitivity: "private",
        validationIds: ["database.catalog-bound", "database.policy-rechecked", "database.parameterized-mutation"],
      };
    },
  });

  const bindActor = async (actor: ActorContext) => {
    const policy = await resolvePolicy();
    const capabilityId = capabilityIdFor(actor);
    const partition = stableToken(`${actor.tenantRef}\u0000${options.connector.id}`);
    const grants = new DurableCapabilityGrantStore({
      state: options.state,
      storageKey: `tessera.database-actions.grants.${partition}`,
    });
    const effects = new DurableEffectStore({
      state: options.state,
      storageKey: `tessera.database-actions.effects.${partition}`,
    });
    const outputCommit = new DurableDatabaseActionOutputCommitter({
      state: options.state,
      storagePrefix: `tessera.database-actions.results.${partition}`,
    });
    const grant = await ensureMutationGrant({
      grants,
      actor,
      policy,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idempotencyRetentionMs: options.idempotencyRetentionMs ?? DEFAULT_IDEMPOTENCY_RETENTION_MS,
      maxCalls: options.maxCalls ?? DEFAULT_MAX_CALLS,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      capabilityId,
    });
    const broker = new CapabilityBroker({
      schemaProfile: compilerSchemaProfile,
      approvalTtlMs: options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      now,
      idFactory: id,
      ports: {
        grants,
        effects,
        handlers: new InMemoryCapabilityHandlerRegistry({ [HANDLER_REF]: createMutationHandler() }),
        authority: createAuthority(),
        policy: createPolicyEvaluator(),
        codecs: new JsonOutputCodec(),
        outputPolicy: new DefaultCapabilityOutputPolicy(),
        outputCommit,
      },
    });
    return { actor, broker, grant, outputCommit };
  };

  const bind = async (input: TesseraDatabaseActionActor) => bindActor(await toActorContext(input));

  const withResult = async (
    execution: EffectExecutionResult,
    outputCommit: DurableDatabaseActionOutputCommitter,
  ): Promise<TesseraDatabaseActionEffect> => {
    if (execution.summary.status !== "succeeded") return execution;
    const result = await outputCommit.get(execution.summary.requestId);
    return result === undefined ? execution : { ...execution, result };
  };

  return Object.freeze({
    async submit(input: TesseraDatabaseActionSubmitInput): Promise<TesseraDatabaseActionEffect> {
      const inputInvocation = databaseActionInvocationSchema.parse({
        action: input.action,
        purpose: input.purpose,
        requireApproval: input.requireApproval ?? false,
      });
      if (inputInvocation.action.kind === "data.read") throw new TypeError("Read actions must use the existing Data Agent.");
      const actor = await toActorContext(input.actor);
      const [permissionActor, catalog] = await Promise.all([resolvePermissionActor(actor), getCatalog()]);
      const invocation = databaseActionInvocationSchema.parse({
        action: normalizeConnectionRef(inputInvocation.action),
        purpose: inputInvocation.purpose,
        requireApproval: inputInvocation.requireApproval,
      });
      const bound = await bindAction(invocation.action, catalog, permissionActor);
      const { broker, grant, outputCommit } = await bindActor(actor);
      const requestId = input.requestId ?? id("database-action-request");
      const execution = await broker.submit({
        requestId,
        invocationId: input.invocationId ?? id("database-action-invocation"),
        stepId: input.stepId ?? id("database-action-step"),
        documentId,
        branchId: "main",
        revisionId: (await resolvePolicy()).policyHash,
        expectedHeadToken: bound.action.catalogFingerprint,
        nodeId: "database-mutation",
        eventPort: "submit",
        actionId: input.actionId ?? createDatabaseActionHash(bound.action),
        capabilityId: grant.capabilityId,
        grantVersion: grant.grantVersion,
        grantSetVersion: grant.grantSetVersion,
        input: toJsonValue({
          action: invocation.action,
          purpose: invocation.purpose,
          requireApproval: invocation.requireApproval,
          boundRowPredicates: bound.bindings,
        }),
        statePreconditions: {},
        idempotencyKey: input.idempotencyKey ?? requestId,
      }, actor);
      return withResult(execution, outputCommit);
    },

    async get(input: TesseraDatabaseActionGetInput): Promise<TesseraDatabaseActionEffect> {
      const { actor, broker, outputCommit } = await bind(input.actor);
      return withResult(await broker.getEffect(input.requestId, actor), outputCommit);
    },

    async approve(input: TesseraDatabaseActionApprovalInput): Promise<TesseraDatabaseActionEffect> {
      const { actor, broker, outputCommit } = await bind(input.actor);
      return withResult(await broker.respondToApproval({
        requestId: input.requestId,
        checkpointId: input.checkpointId,
        decision: "approve",
        approver: actor,
      }), outputCommit);
    },

    async reject(input: TesseraDatabaseActionApprovalInput): Promise<TesseraDatabaseActionEffect> {
      const { actor, broker, outputCommit } = await bind(input.actor);
      return withResult(await broker.respondToApproval({
        requestId: input.requestId,
        checkpointId: input.checkpointId,
        decision: "reject",
        approver: actor,
      }), outputCommit);
    },

    async cancel(input: TesseraDatabaseActionCancelInput): Promise<EffectCancellationReceipt> {
      const { actor, broker } = await bind(input.actor);
      await broker.getEffect(input.requestId, actor);
      return broker.cancel({
        cancelRequestId: input.cancelRequestId ?? id("database-action-cancel"),
        effectRequestId: input.requestId,
      });
    },

    async capabilities(input: { actor: TesseraDatabaseActionActor }): Promise<ModelVisibleGrantSet> {
      const { actor, broker } = await bind(input.actor);
      const visible = await broker.modelVisibleGrantSet();
      return {
        ...visible,
        capabilities: visible.capabilities.filter((candidate) => candidate.capabilityId === capabilityIdFor(actor)),
      };
    },
  });
}

type EnsureMutationGrantInput = Readonly<{
  grants: DurableCapabilityGrantStore;
  actor: ActorContext;
  policy: DatabaseScopedPermissionPolicy;
  timeoutMs: number;
  idempotencyRetentionMs: number;
  maxCalls: number;
  maxOutputBytes: number;
  capabilityId: string;
}>;

async function ensureMutationGrant(input: EnsureMutationGrantInput): Promise<CapabilityGrant> {
  const [inputSchemaHash, outputSchemaHash] = await capabilitySchemaHashes;
  const existing = await input.grants.getCapability(input.capabilityId);
  if (
    existing
    && existing.policyProfileHash === input.policy.policyHash
    && existing.inputSchemaHash === inputSchemaHash
    && existing.outputSchemaHash === outputSchemaHash
    && existing.scope.tenantRef === input.actor.tenantRef
    && existing.scope.actorRef === input.actor.actorRef
    && canonicalize(existing.scope.resourceScopeRefs) === canonicalize(input.actor.resourceScopeRefs)
    && canonicalize(existing.disclosure.allowedSensitivity) === canonicalize(input.actor.allowedSensitivity)
  ) return existing;

  const currentGrantSetVersion = await input.grants.getGrantSetVersion();
  const grantSetVersion = existing === undefined
    ? Math.max(1, currentGrantSetVersion)
    : currentGrantSetVersion + 1;
  const grant: CapabilityGrant = {
    capabilityId: input.capabilityId,
    grantVersion: (existing?.grantVersion ?? 0) + 1,
    grantSetVersion,
    schemaProfile: compilerSchemaProfile,
    kind: "write",
    summary: "Execute a typed, catalog-bound database mutation",
    inputSchemaId: "studio.database-action.input",
    inputSchemaVersion: 1,
    inputSchema: databaseActionInputSchema,
    inputSchemaHash,
    outputSchemaId: "studio.database-action.result",
    outputSchemaVersion: 1,
    outputSchema: databaseActionOutputSchema,
    outputSchemaHash,
    outputCodec: { id: "json", version: "1" },
    outputMediaType: "application/json",
    scope: {
      tenantRef: input.actor.tenantRef,
      actorRef: input.actor.actorRef,
      resourceScopeRefs: [...input.actor.resourceScopeRefs],
    },
    risk: "critical",
    approval: "risk-based",
    idempotency: { required: true, retentionMs: input.idempotencyRetentionMs },
    budgets: {
      timeoutMs: input.timeoutMs,
      maxCalls: input.maxCalls,
      maxInputBytes: 256 * 1024,
      maxOutputBytes: input.maxOutputBytes,
    },
    disclosure: {
      allowedSensitivity: [...input.actor.allowedSensitivity],
      requireModelReadableState: false,
      allowedResourceScopeRefs: [...input.actor.resourceScopeRefs],
    },
    policyProfileHash: input.policy.policyHash,
    handlerRef: HANDLER_REF,
  };
  await input.grants.setCapability(grant);
  return grant;
}

class DurableDatabaseActionOutputCommitter implements CapabilityOutputCommitPort {
  readonly #state: DurableStateStorePort;
  readonly #storagePrefix: string;

  constructor(input: { state: DurableStateStorePort; storagePrefix: string }) {
    this.#state = input.state;
    this.#storagePrefix = input.storagePrefix;
  }

  async commit(input: ValidatedOutputCommit): Promise<{
    evidence: [];
    publication: PublicationResult;
  }> {
    const result = databaseActionResultSchema.parse(input.value) as TesseraDatabaseActionResult;
    const key = this.#key(input.request.requestId);
    await this.#state.transaction([key], async (transaction) => {
      await transaction.set(key, result);
    });
    return {
      evidence: [],
      publication: { status: "not-requested", expectedHeadToken: input.request.expectedHeadToken },
    };
  }

  async get(requestId: string): Promise<TesseraDatabaseActionResult | undefined> {
    const value = await this.#state.read<unknown>(this.#key(requestId));
    return value === undefined ? undefined : databaseActionResultSchema.parse(value) as TesseraDatabaseActionResult;
  }

  #key(requestId: string): string {
    return `${this.#storagePrefix}.${stableToken(requestId)}`;
  }
}

function boundedObjectSchema(
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
  maxProperties = Object.keys(properties).length,
  additionalProperties: JsonSchema | false = false,
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    maxProperties,
    additionalProperties,
  };
}

function boundedJsonSchema(depth: number): JsonSchema {
  const primitive: JsonSchema = {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string", maxLength: 8_192 },
    ],
  };
  if (depth === 0) return primitive;
  const child = boundedJsonSchema(depth - 1);
  return {
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string", maxLength: 8_192 },
      { type: "array", maxItems: 1_024, items: child },
      boundedObjectSchema({}, [], 256, child),
    ],
  };
}

function mutationIdFor(requestId: string): string {
  return `mutation-${stableToken(requestId)}`;
}

function capabilityIdFor(actor: Pick<ActorContext, "tenantRef" | "actorRef">): string {
  return `database.mutate.${stableToken(`${actor.tenantRef}\u0000${actor.actorRef}`).slice(0, 24)}`;
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRowPredicates(
  bindings: readonly DatabaseRowPredicateBinding[],
): readonly DatabaseRowPredicateBinding[] {
  const normalized = bindings
    .map((binding) => databaseRowPredicateBindingSchema.parse(binding))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  const duplicate = normalized.find((binding, index) => binding.ref === normalized[index - 1]?.ref);
  if (duplicate) throw new Error(`Row predicate binding "${duplicate.ref}" is duplicated.`);
  return normalized;
}

async function resolveValue<T>(source: ResolveValue<T>): Promise<T> {
  if (typeof source !== "function") return source;
  return await (source as () => T | Promise<T>)();
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
