import {
  canonicalBytes,
  canonicalHash,
  canonicalize,
  createDiagnostic,
  evidenceReferenceSchema,
  jsonValueSchema,
  resourceReferenceSchema,
  type Diagnostic,
  type EvidenceReference,
  type JsonValue,
  type ResourceReference,
} from "@data-elements/runtime";
import { z } from "zod";
import {
  assertSchemaProfile,
  parseJsonWithSchema,
  prepareJsonSchema,
  SchemaContractError,
  type PreparedJsonSchema,
} from "./schema-contract";
import type {
  ActorContext,
  ApprovalCheckpoint,
  CapabilityBrokerPorts,
  CapabilityGrant,
  CapabilityHandler,
  CapabilityOutputBinding,
  ClientApprovalCheckpoint,
  ClientEffectReceipt,
  ClientEffectSummary,
  EffectCancellationReceipt,
  EffectExecutionResult,
  EffectReceipt,
  EffectRequest,
  EffectStatus,
  EffectSubmission,
  MessageTemplateBinding,
  MessageTemplateGrant,
  ModelVisibleCapability,
  ModelVisibleGrantSet,
  ModelVisibleMessageTemplate,
  PolicyDecision,
  SchemaProfileBinding,
  SchemaProfileLimits,
  Sensitivity,
  StoredEffect,
} from "./types";

const identifier = z.string().min(1).max(512);
const isoDate = z.iso.datetime({ offset: true });
const jsonSchema = z.union([z.boolean(), z.record(z.string(), jsonValueSchema)]);
const schemaProfile = z.object({
  profileId: z.literal("data-elements.schema-core"),
  profileVersion: z.number().int().positive(),
  profileHash: identifier,
}).strict();

const disclosureSchema = z.object({
  allowedSensitivity: z.array(z.enum(["public", "private", "sensitive"])).min(1),
  requireModelReadableState: z.boolean(),
  allowedResourceScopeRefs: z.array(identifier),
}).strict();

const grantSchema = z.object({
  capabilityId: identifier,
  grantVersion: z.number().int().positive(),
  grantSetVersion: z.number().int().nonnegative(),
  schemaProfile,
  kind: z.enum(["read", "write", "navigation", "export", "agent-message"]),
  summary: z.string().min(1).max(2_000),
  inputSchemaId: identifier,
  inputSchemaVersion: z.number().int().positive(),
  inputSchema: jsonSchema,
  inputSchemaHash: identifier,
  outputSchemaId: identifier,
  outputSchemaVersion: z.number().int().positive(),
  outputSchema: jsonSchema,
  outputSchemaHash: identifier,
  outputCodec: z.object({ id: identifier, version: identifier }).strict(),
  outputMediaType: z.string().min(1).max(256),
  scope: z.object({
    tenantRef: identifier,
    actorRef: identifier,
    resourceScopeRefs: z.array(identifier),
  }).strict(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  approval: z.enum(["never", "risk-based", "always"]),
  idempotency: z.object({ required: z.boolean(), retentionMs: z.number().int().positive() }).strict(),
  budgets: z.object({
    timeoutMs: z.number().int().positive(),
    maxCalls: z.number().int().positive(),
    maxInputBytes: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
  }).strict(),
  disclosure: disclosureSchema,
  navigationPolicy: z.object({
    allowedRouteIds: z.array(identifier),
    allowedResourceIds: z.array(identifier),
    allowedSchemes: z.array(z.string().min(1).max(32)),
    allowedOrigins: z.array(z.string().min(1).max(2_048)),
  }).strict().optional(),
  policyProfileHash: identifier,
  handlerRef: identifier,
  expiresAt: isoDate.optional(),
}).strict();

const templateSchema = z.object({
  templateGrantId: identifier,
  templateGrantVersion: z.number().int().positive(),
  grantSetVersion: z.number().int().nonnegative(),
  schemaProfile,
  capabilityId: identifier,
  capabilityGrantVersion: z.number().int().positive(),
  templateId: identifier,
  templateVersion: z.number().int().positive(),
  template: z.string().min(1).max(256 * 1024),
  templateHash: identifier,
  summary: z.string().min(1).max(2_000),
  variableSchema: jsonSchema,
  variableSchemaHash: identifier,
  disclosure: disclosureSchema,
  status: z.enum(["active", "revoked"]),
  expiresAt: isoDate.optional(),
}).strict();

const submissionSchema = z.object({
  requestId: identifier,
  invocationId: identifier,
  stepId: identifier,
  documentId: identifier,
  branchId: identifier,
  revisionId: identifier,
  expectedHeadToken: identifier,
  nodeId: identifier,
  eventPort: identifier,
  actionId: identifier,
  capabilityId: identifier,
  grantVersion: z.number().int().positive(),
  grantSetVersion: z.number().int().nonnegative(),
  input: jsonValueSchema,
  statePreconditions: z.record(identifier, identifier),
  idempotencyKey: identifier,
  messageTemplate: z.object({
    templateGrantId: identifier,
    templateGrantVersion: z.number().int().positive(),
    values: z.record(identifier, jsonValueSchema),
  }).strict().optional(),
}).strict();

export class CapabilityBrokerError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "CapabilityBrokerError";
    this.diagnostic = diagnostic;
  }
}

export type CapabilityBrokerOptions = {
  ports: CapabilityBrokerPorts;
  schemaProfile: SchemaProfileBinding;
  schemaLimits?: Partial<SchemaProfileLimits>;
  approvalTtlMs?: number;
  now?: () => string;
  idFactory?: (prefix: string) => string;
  auditRefFactory?: (requestId: string) => string;
};

type ValidatedGrant = {
  grant: CapabilityGrant;
  input: PreparedJsonSchema;
  output: PreparedJsonSchema;
};

type BoundRequest = ValidatedGrant & {
  request: EffectRequest;
};

export class CapabilityBroker {
  readonly #ports: CapabilityBrokerPorts;
  readonly #profile: SchemaProfileBinding;
  readonly #schemaLimits?: Partial<SchemaProfileLimits>;
  readonly #approvalTtlMs: number;
  readonly #now: () => string;
  readonly #id: (prefix: string) => string;
  readonly #auditRef: (requestId: string) => string;
  readonly #schemaCache = new Map<string, Promise<PreparedJsonSchema>>();
  readonly #schemaIdentities = new Map<string, string>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(options: CapabilityBrokerOptions) {
    this.#ports = options.ports;
    this.#profile = structuredClone(options.schemaProfile);
    this.#schemaLimits = options.schemaLimits;
    this.#approvalTtlMs = options.approvalTtlMs ?? 5 * 60_000;
    this.#now = options.now ?? (() => new Date().toISOString());
    let sequence = 0;
    this.#id = options.idFactory ?? ((prefix) => `${prefix}:${++sequence}`);
    this.#auditRef = options.auditRefFactory ?? ((requestId) => `audit:${requestId}`);
  }

  async modelVisibleCapability(capabilityId: string): Promise<ModelVisibleCapability> {
    const grant = await this.#ports.grants.getCapability(capabilityId);
    if (!grant) throw brokerError("capability.not-found", "Capability is unavailable.");
    await this.#validateGrant(grant);
    if (grant.grantSetVersion !== await this.#ports.grants.getGrantSetVersion()) {
      throw brokerError("grant-set.rotated", "Capability is not part of the active grant set.");
    }
    return projectModelVisibleCapability(grant);
  }

  async modelVisibleMessageTemplate(templateGrantId: string): Promise<ModelVisibleMessageTemplate> {
    const template = await this.#ports.grants.getMessageTemplate(templateGrantId);
    if (!template) throw brokerError("template.not-found", "Message template is unavailable.");
    const capability = await this.#requireGrant(template.capabilityId);
    const resolved = await this.#resolveTemplate(templateGrantId, capability.grant, capability.grant.grantSetVersion);
    return projectModelVisibleMessageTemplate(resolved.grant);
  }

  async modelVisibleGrantSet(): Promise<ModelVisibleGrantSet> {
    const grantSetVersion = await this.#ports.grants.getGrantSetVersion();
    const capabilities = await Promise.all((await this.#ports.grants.listCapabilities()).map(async (grant) => {
      await this.#validateGrant(grant);
      if (grant.grantSetVersion !== grantSetVersion || isExpired(grant.expiresAt, this.#now())) return undefined;
      return projectModelVisibleCapability(grant);
    }));
    const templates = await Promise.all((await this.#ports.grants.listMessageTemplates()).map(async (template) => {
      if (template.status !== "active" || template.grantSetVersion !== grantSetVersion || isExpired(template.expiresAt, this.#now())) return undefined;
      const capability = await this.#ports.grants.getCapability(template.capabilityId);
      if (!capability) return undefined;
      const resolved = await this.#resolveTemplate(template.templateGrantId, (await this.#validateGrant(capability)).grant, grantSetVersion);
      return projectModelVisibleMessageTemplate(resolved.grant);
    }));
    return {
      grantSetVersion,
      capabilities: capabilities.filter((item): item is ModelVisibleCapability => item !== undefined),
      messageTemplates: templates.filter((item): item is ModelVisibleMessageTemplate => item !== undefined),
    };
  }

  async submit(submissionInput: EffectSubmission, actorInput: ActorContext): Promise<EffectExecutionResult> {
    const submission = submissionSchema.parse(submissionInput) as EffectSubmission;
    const actor = validateActor(actorInput);
    const bound = await this.#bindSubmission(submission, actor);
    const now = this.#now();
    const payloadHash = await canonicalHash({ request: bound.request, actor });
    const effect: StoredEffect = {
      version: 0,
      payloadHash,
      idempotencyKey: bound.request.idempotencyKey,
      request: bound.request,
      actor,
      status: "pending",
      decisions: [],
      cancellations: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.parse(now) + bound.grant.idempotency.retentionMs).toISOString(),
    };
    const claim = await this.#ports.effects.claim(effect);
    if (claim.status === "conflict") throw brokerError("effect.idempotency-conflict", "Request or idempotency identity was reused with a different payload.");
    if (claim.status !== "claimed") return this.#view(claim.effect, bound.grant, true);
    return this.#authorizeAndContinue(claim.effect, "initial", false);
  }

  /** Returns a redacted effect view for a server-side owner check. */
  async getEffect(requestId: string, actorInput?: ActorContext): Promise<EffectExecutionResult> {
    const effect = await this.#requireEffect(requestId);
    if (actorInput) {
      const actor = validateActor(actorInput);
      if (effect.actor.tenantRef !== actor.tenantRef || effect.actor.actorRef !== actor.actorRef) {
        throw brokerError("effect.scope-denied", "Effect is outside the actor scope.");
      }
    }
    const grant = await this.#ports.grants.getCapability(effect.request.capabilityId);
    return this.#view(effect, grant, true);
  }

  async respondToApproval(input: {
    requestId: string;
    checkpointId: string;
    decision: "approve" | "reject";
    approver: ActorContext;
  }): Promise<EffectExecutionResult> {
    let effect = await this.#requireEffect(input.requestId);
    if (effect.receipt) {
      const grant = await this.#ports.grants.getCapability(effect.request.capabilityId);
      return this.#view(effect, grant, true);
    }
    const checkpoint = effect.checkpoint;
    if (!checkpoint || checkpoint.checkpointId !== input.checkpointId) throw brokerError("approval.not-found", "Approval checkpoint is unavailable.");
    let grant: ValidatedGrant;
    try {
      grant = await this.#requireGrant(effect.request.capabilityId);
    } catch {
      return this.#finish(effect, "denied", diagnostic("grant.revoked", "Capability grant was revoked before approval completed."));
    }
    if (checkpoint.status !== "pending") return this.#view(effect, grant.grant, true);
    if (isExpired(checkpoint.expiresAt, this.#now())) {
      const claimed = await this.#claimTransition(effect, (current) => (
        current.status === "awaiting-approval"
        && current.checkpoint?.checkpointId === input.checkpointId
        && current.checkpoint.status === "pending"
      ), (current) => ({
        ...current,
        status: "denied",
        checkpoint: { ...current.checkpoint!, status: "expired" },
      }));
      if (!claimed.claimed) return this.#view(claimed.effect, grant.grant, true);
      return this.#finish(claimed.effect, "denied", diagnostic("approval.expired", "Approval checkpoint expired."));
    }
    const approver = validateActor(input.approver);
    const authorized = await this.#ports.authority.authorizeApproval({
      actor: effect.actor,
      approver,
      grant: grant.grant,
      checkpoint,
    });
    if (!authorized.allowed) throw brokerError("approval.unauthorized", "Approver is not authorized for this checkpoint.");
    if (input.decision === "reject") {
      const claimed = await this.#claimTransition(effect, (current) => (
        current.status === "awaiting-approval"
        && current.checkpoint?.checkpointId === input.checkpointId
        && current.checkpoint.status === "pending"
      ), (current) => ({
        ...current,
        status: "denied",
        checkpoint: { ...current.checkpoint!, status: "rejected", approverContextRef: approver.actorContextRef },
      }));
      if (!claimed.claimed) return this.#view(claimed.effect, grant.grant, true);
      return this.#finish(claimed.effect, "denied", diagnostic("approval.rejected", "Capability execution was rejected."));
    }
    const claimed = await this.#claimTransition(effect, (current) => (
      current.status === "awaiting-approval"
      && current.checkpoint?.checkpointId === input.checkpointId
      && current.checkpoint.status === "pending"
    ), (current) => ({
      ...current,
      status: "approved",
      checkpoint: { ...current.checkpoint!, status: "approved", approverContextRef: approver.actorContextRef },
    }));
    if (!claimed.claimed) return this.#view(claimed.effect, grant.grant, true);
    return this.#authorizeAndContinue(claimed.effect, "pre-execution", true);
  }

  async cancel(input: { cancelRequestId: string; effectRequestId: string }): Promise<EffectCancellationReceipt> {
    let effect = await this.#requireEffect(input.effectRequestId);
    const prior = effect.cancellations.find((item) => item.cancelRequestId === input.cancelRequestId);
    if (prior) return structuredClone(prior);
    const now = this.#now();
    if (isTerminal(effect.status)) {
      const receipt = cancellation(this.#id("cancel"), input, "too-late", effect.status, now);
      await this.#appendCancellation(effect, receipt);
      return receipt;
    }
    if (effect.status !== "running" && effect.status !== "cancel-requested") {
      const receipt = cancellation(this.#id("cancel"), input, "cancelled", "cancelled", now);
      await this.#update(effect, (current) => ({
        ...current,
        status: "cancelled",
        cancellations: [...current.cancellations, receipt],
        checkpoint: current.checkpoint ? { ...current.checkpoint, status: "cancelled" } : undefined,
        receipt: makeReceipt(current, "cancelled", this.#id("effect-receipt"), this.#auditRef(current.request.requestId), undefined),
      }));
      return receipt;
    }
    effect = await this.#update(effect, (current) => ({ ...current, status: "cancel-requested" }));
    const handler = await this.#handlerFor(effect.request.capabilityId);
    const operationKey = operationKeyFor(effect);
    this.#controllers.get(operationKey)?.abort();
    const stopped = await handler.cancel?.(operationKey) ?? false;
    const latest = await this.#requireEffect(effect.request.requestId);
    if (isTerminal(latest.status)) {
      const outcome = latest.status === "cancelled" ? "cancelled" : "too-late";
      const receipt = cancellation(this.#id("cancel"), input, outcome, latest.status, this.#now());
      await this.#appendCancellation(latest, receipt);
      return receipt;
    }
    const receipt = cancellation(this.#id("cancel"), input, stopped ? "cancelled" : "too-late", stopped ? "cancelled" : "running", this.#now());
    await this.#update(latest, (current) => ({
      ...current,
      status: stopped ? "cancelled" : "running",
      cancellations: [...current.cancellations, receipt],
      ...(stopped ? { receipt: makeReceipt(current, "cancelled", this.#id("effect-receipt"), this.#auditRef(current.request.requestId), undefined) } : {}),
    }));
    return receipt;
  }

  async #authorizeAndContinue(
    effectInput: StoredEffect,
    phase: PolicyDecision["phase"],
    approved: boolean,
  ): Promise<EffectExecutionResult> {
    let effect = effectInput;
    let bound: ValidatedGrant;
    try {
      bound = await this.#revalidateEffect(effect);
    } catch (error) {
      return this.#finish(effect, "denied", diagnostic(
        error instanceof CapabilityBrokerError ? error.diagnostic.code : "authorization.stale-binding",
        "Capability authorization changed before execution.",
      ));
    }
    const authority = await this.#ports.authority.authorize({ phase, actor: effect.actor, grant: bound.grant, request: effect.request });
    const evaluated = await this.#ports.policy.evaluate({ phase, request: effect.request, grant: bound.grant, actor: effect.actor, authority, approved });
    const decision: PolicyDecision = {
      decisionId: this.#id("decision"),
      requestId: effect.request.requestId,
      phase,
      outcome: evaluated.outcome,
      policyHash: evaluated.policyHash,
      grantVersion: bound.grant.grantVersion,
      grantSetVersion: bound.grant.grantSetVersion,
      revisionId: authority.revisionId,
      headToken: authority.headToken,
      inputSchemaHash: effect.request.inputSchemaHash,
      inputHash: effect.request.inputHash,
      outputSchemaHash: effect.request.outputSchemaHash,
      messageTemplate: effect.request.messageTemplate,
      reasonCodes: [...new Set([...authority.reasonCodes, ...evaluated.reasonCodes])],
      evaluatedAt: this.#now(),
    };
    effect = await this.#update(effect, (current) => ({ ...current, decisions: [...current.decisions, decision] }));
    if (evaluated.outcome === "deny" || (phase === "pre-execution" && evaluated.outcome !== "allow")) {
      return this.#finish(effect, "denied", diagnostic("policy.denied", "Capability policy denied execution."));
    }
    if (evaluated.outcome === "require-approval") {
      const checkpoint: ApprovalCheckpoint = {
        checkpointId: this.#id("approval"),
        requestId: effect.request.requestId,
        documentId: effect.request.documentId,
        branchId: effect.request.branchId,
        decisionId: decision.decisionId,
        policyHash: decision.policyHash,
        grantVersion: decision.grantVersion,
        grantSetVersion: decision.grantSetVersion,
        revisionId: decision.revisionId,
        headToken: decision.headToken,
        inputSchemaHash: decision.inputSchemaHash,
        inputHash: decision.inputHash,
        outputSchemaHash: decision.outputSchemaHash,
        messageTemplate: decision.messageTemplate,
        status: "pending",
        expiresAt: new Date(Date.parse(this.#now()) + this.#approvalTtlMs).toISOString(),
      };
      effect = await this.#update(effect, (current) => ({ ...current, status: "awaiting-approval", checkpoint }));
      return this.#view(effect, bound.grant, false);
    }
    if (phase === "initial") return this.#authorizeAndContinue(effect, "pre-execution", false);
    return this.#execute(effect, bound);
  }

  async #execute(effectInput: StoredEffect, bound: ValidatedGrant): Promise<EffectExecutionResult> {
    let effect = effectInput;
    const since = new Date(Date.parse(this.#now()) - bound.grant.idempotency.retentionMs).toISOString();
    if (await this.#ports.effects.countCalls(effect.actor.actorContextRef, bound.grant.capabilityId, since) > bound.grant.budgets.maxCalls) {
      return this.#finish(effect, "denied", diagnostic("capability.call-budget", "Capability call budget was exceeded."));
    }
    const handler = await this.#ports.handlers.get(bound.grant.handlerRef);
    if (!handler) return this.#finish(effect, "failed", diagnostic("capability.handler-missing", "Capability handler is unavailable."));
    const claimed = await this.#claimTransition(effect, (current) => (
      current.status === "pending" || current.status === "approved"
    ), (current) => ({ ...current, status: "running" }));
    if (!claimed.claimed) return this.#view(claimed.effect, bound.grant, true);
    effect = claimed.effect;
    const operationKey = operationKeyFor(effect);
    const controller = new AbortController();
    this.#controllers.set(operationKey, controller);
    try {
      const output = await withTimeout(
        handler.execute({ request: effect.request, actor: effect.actor, grant: bound.grant, operationKey, signal: controller.signal }),
        bound.grant.budgets.timeoutMs,
        controller,
      );
      const latest = await this.#requireEffect(effect.request.requestId);
      if (latest.status === "cancelled") return this.#view(latest, bound.grant, false);
      const validated = await this.#validateOutput(latest, bound, output);
      return this.#finish(latest, "succeeded", undefined, validated.binding, validated.publication);
    } catch (error) {
      const latest = await this.#requireEffect(effect.request.requestId);
      if (latest.status === "cancelled") return this.#view(latest, bound.grant, false);
      return this.#finish(latest, "failed", diagnostic(
        error instanceof SchemaContractError ? error.code : "capability.execution-failed",
        error instanceof SchemaContractError ? error.message : "Capability execution failed.",
      ));
    } finally {
      this.#controllers.delete(operationKey);
    }
  }

  async #validateOutput(
    effect: StoredEffect,
    bound: ValidatedGrant,
    output: Awaited<ReturnType<CapabilityHandler["execute"]>>,
  ): Promise<{ binding: CapabilityOutputBinding; publication: EffectReceipt["publication"] }> {
    if (!(output.bytes instanceof Uint8Array)) throw new SchemaContractError("output.bytes-required", "Handler output must be Uint8Array.");
    if (output.bytes.byteLength > bound.grant.budgets.maxOutputBytes) throw new SchemaContractError("output.byte-budget", "Handler output exceeds its raw byte budget.");
    if (output.mediaType !== bound.grant.outputMediaType) throw new SchemaContractError("output.media-type", "Handler output media type does not match the grant.");
    const decoded = await this.#ports.codecs.decode(bound.grant.outputCodec, output.bytes);
    const parsed = parseJsonWithSchema(bound.output.validator, decoded);
    const sanitized = await this.#ports.outputPolicy.sanitize({
      value: parsed,
      requestedScopeRef: output.scopeRef,
      requestedSensitivity: output.sensitivity,
      grant: bound.grant,
      actor: effect.actor,
    });
    if (sensitivityRank(sanitized.sensitivity) < sensitivityRank(output.sensitivity)) {
      throw new SchemaContractError("output.sensitivity-downgrade", "Output policy cannot lower sensitivity.");
    }
    assertOutputAuthority(sanitized.scopeRef, sanitized.sensitivity, bound.grant, effect.actor);
    const value = parseJsonWithSchema(bound.output.validator, sanitized.value);
    const canonicalByteLength = canonicalBytes(value).byteLength;
    if (canonicalByteLength > bound.grant.budgets.maxOutputBytes) throw new SchemaContractError("output.sanitized-byte-budget", "Sanitized output exceeds its byte budget.");
    const contentHash = await canonicalHash(value);
    const validationIds = [...new Set([...output.validationIds, ...sanitized.validationIds, "output.schema-valid"])]
      .filter((item) => item.length > 0);
    const provisional: CapabilityOutputBinding = {
      outputSchemaId: bound.grant.outputSchemaId,
      outputSchemaVersion: bound.grant.outputSchemaVersion,
      outputSchemaHash: bound.grant.outputSchemaHash,
      outputCodec: structuredClone(bound.grant.outputCodec),
      contentHash,
      byteLength: canonicalByteLength,
      mediaType: bound.grant.outputMediaType,
      scopeRef: sanitized.scopeRef,
      sensitivity: sanitized.sensitivity,
      validationIds,
      outputResourceId: output.resource?.resourceId,
      evidenceIds: output.evidence?.map((item) => item.evidenceId) ?? [],
    };
    const committed = await this.#ports.outputCommit.commit({
      request: effect.request,
      grant: bound.grant,
      actor: effect.actor,
      value,
      binding: provisional,
      resource: output.resource,
      evidence: output.evidence ?? [],
      publication: output.publication,
    });
    validateCommittedOutput(provisional, output, committed.resource, committed.evidence, committed.publication);
    return {
      binding: {
        ...provisional,
        outputResourceId: committed.resource?.resourceId,
        evidenceIds: committed.evidence.map((item) => item.evidenceId),
      },
      publication: committed.publication,
    };
  }

  async #bindSubmission(submission: EffectSubmission, actor: ActorContext): Promise<BoundRequest> {
    const validated = await this.#requireGrant(submission.capabilityId);
    const { grant } = validated;
    this.#assertGrantAuthority(grant, actor, submission.grantVersion, submission.grantSetVersion);
    if (await this.#ports.grants.getGrantSetVersion() !== submission.grantSetVersion) {
      throw brokerError("grant-set.rotated", "Capability grant set changed.");
    }
    if (canonicalBytes(submission.input).byteLength > grant.budgets.maxInputBytes) throw brokerError("input.byte-budget", "Capability input exceeds its byte budget.");
    let resolvedInput = parseJsonWithSchema(validated.input.validator, submission.input);
    let messageTemplate: MessageTemplateBinding | undefined;
    let renderedMessage: string | undefined;
    if (grant.kind === "agent-message") {
      if (!submission.messageTemplate) throw brokerError("template.required", "Agent-message capabilities require a template grant.");
      const template = await this.#resolveTemplate(submission.messageTemplate.templateGrantId, grant, submission.grantSetVersion);
      if (template.grant.templateGrantVersion !== submission.messageTemplate.templateGrantVersion) throw brokerError("template.version-mismatch", "Message template version changed.");
      const variables = parseJsonWithSchema(template.prepared.validator, submission.messageTemplate.values);
      if (variables === null || Array.isArray(variables) || typeof variables !== "object") throw brokerError("template.variables-object", "Message template values must be an object.");
      resolvedInput = parseJsonWithSchema(validated.input.validator, variables);
      messageTemplate = templateBinding(template.grant);
      renderedMessage = renderMessageTemplate(template.grant.template, variables as Record<string, JsonValue>);
    } else if (submission.messageTemplate) {
      throw brokerError("template.forbidden", "Message template bindings are only valid for agent-message capabilities.");
    }
    validateCapabilityKind(grant, resolvedInput);
    const inputHash = await canonicalHash(resolvedInput);
    const request = compact<EffectRequest>({
      requestId: submission.requestId,
      invocationId: submission.invocationId,
      stepId: submission.stepId,
      documentId: submission.documentId,
      branchId: submission.branchId,
      revisionId: submission.revisionId,
      expectedHeadToken: submission.expectedHeadToken,
      nodeId: submission.nodeId,
      eventPort: submission.eventPort,
      actionId: submission.actionId,
      capabilityId: submission.capabilityId,
      grantVersion: submission.grantVersion,
      grantSetVersion: submission.grantSetVersion,
      resolvedInput,
      inputSchemaHash: grant.inputSchemaHash,
      inputHash,
      outputSchemaHash: grant.outputSchemaHash,
      statePreconditions: structuredClone(submission.statePreconditions),
      idempotencyKey: submission.idempotencyKey,
      actorContextRef: actor.actorContextRef,
      messageTemplate,
      renderedMessage,
    });
    return { ...validated, request };
  }

  async #revalidateEffect(effect: StoredEffect): Promise<ValidatedGrant> {
    const validated = await this.#requireGrant(effect.request.capabilityId);
    this.#assertGrantAuthority(validated.grant, effect.actor, effect.request.grantVersion, effect.request.grantSetVersion);
    if (await this.#ports.grants.getGrantSetVersion() !== effect.request.grantSetVersion) {
      throw brokerError("grant-set.rotated", "Capability grant set changed before execution.");
    }
    if (
      effect.request.inputSchemaHash !== validated.grant.inputSchemaHash
      || effect.request.outputSchemaHash !== validated.grant.outputSchemaHash
      || await canonicalHash(effect.request.resolvedInput) !== effect.request.inputHash
      || effect.request.actorContextRef !== effect.actor.actorContextRef
    ) throw brokerError("effect.binding-changed", "Effect request bindings no longer match current authority.");
    parseJsonWithSchema(validated.input.validator, effect.request.resolvedInput);
    if (validated.grant.kind === "agent-message") {
      if (!effect.request.messageTemplate) throw brokerError("template.binding-missing", "Agent-message binding is missing.");
      const template = await this.#resolveTemplate(effect.request.messageTemplate.templateGrantId, validated.grant, effect.request.grantSetVersion);
      if (canonicalize(templateBinding(template.grant)) !== canonicalize(effect.request.messageTemplate)) {
        throw brokerError("template.binding-changed", "Message template binding changed before execution.");
      }
    } else if (effect.request.messageTemplate) {
      throw brokerError("template.binding-forbidden", "Unexpected message template binding.");
    }
    return validated;
  }

  async #requireGrant(capabilityId: string): Promise<ValidatedGrant> {
    const grant = await this.#ports.grants.getCapability(capabilityId);
    if (!grant) throw brokerError("capability.not-found", "Capability is unavailable.");
    return this.#validateGrant(grant);
  }

  async #validateGrant(input: CapabilityGrant): Promise<ValidatedGrant> {
    const grant = grantSchema.parse(input) as CapabilityGrant;
    assertSchemaProfile(grant.schemaProfile, this.#profile);
    if (grant.kind === "write" && !grant.idempotency.required) throw brokerError("grant.write-idempotency", "Write capabilities must require idempotency.");
    if (grant.kind === "write" && grant.risk !== "low" && grant.approval === "never") throw brokerError("grant.write-approval", "Risky write capabilities must require approval.");
    if (grant.kind === "navigation" && !grant.navigationPolicy) throw brokerError("grant.navigation-policy", "Navigation capabilities require an explicit target policy.");
    const inputPrepared = await this.#prepareSchema(grant.inputSchemaId, grant.inputSchemaVersion, grant.inputSchema, grant.inputSchemaHash);
    const outputPrepared = await this.#prepareSchema(grant.outputSchemaId, grant.outputSchemaVersion, grant.outputSchema, grant.outputSchemaHash);
    return { grant, input: inputPrepared, output: outputPrepared };
  }

  async #validateTemplate(input: MessageTemplateGrant): Promise<{ grant: MessageTemplateGrant; prepared: PreparedJsonSchema }> {
    const grant = templateSchema.parse(input) as MessageTemplateGrant;
    assertSchemaProfile(grant.schemaProfile, this.#profile);
    if (await canonicalHash(grant.template) !== grant.templateHash) throw brokerError("template.hash-mismatch", "Message template content hash does not match.");
    const prepared = await this.#prepareSchema(
      `message-template:${grant.templateId}`,
      grant.templateVersion,
      grant.variableSchema,
      grant.variableSchemaHash,
    );
    return { grant, prepared };
  }

  async #resolveTemplate(templateGrantId: string, grant: CapabilityGrant, grantSetVersion: number): Promise<{ grant: MessageTemplateGrant; prepared: PreparedJsonSchema }> {
    const input = await this.#ports.grants.getMessageTemplate(templateGrantId);
    if (!input) throw brokerError("template.not-found", "Message template is unavailable.");
    const template = await this.#validateTemplate(input);
    if (
      await this.#ports.grants.getGrantSetVersion() !== grantSetVersion
      ||
      template.grant.status !== "active"
      || isExpired(template.grant.expiresAt, this.#now())
      || template.grant.capabilityId !== grant.capabilityId
      || template.grant.capabilityGrantVersion !== grant.grantVersion
      || template.grant.grantSetVersion !== grantSetVersion
      || canonicalize(template.grant.disclosure) !== canonicalize(grant.disclosure)
    ) throw brokerError("template.inactive-binding", "Message template does not match the active capability grant.");
    return template;
  }

  async #prepareSchema(id: string, version: number, schema: CapabilityGrant["inputSchema"], hash: string): Promise<PreparedJsonSchema> {
    const identity = `${id}@${version}`;
    const priorHash = this.#schemaIdentities.get(identity);
    if (priorHash && priorHash !== hash) throw brokerError("schema.identity-conflict", `Schema identity ${identity} was reused with different bytes.`);
    const cacheKey = `${identity}:${hash}`;
    let prepared = this.#schemaCache.get(cacheKey);
    if (!prepared) {
      prepared = prepareJsonSchema(schema, hash, { limits: this.#schemaLimits });
      this.#schemaCache.set(cacheKey, prepared);
      prepared.catch(() => this.#schemaCache.delete(cacheKey));
    }
    const result = await prepared;
    this.#schemaIdentities.set(identity, hash);
    return result;
  }

  #assertGrantAuthority(grant: CapabilityGrant, actor: ActorContext, grantVersion: number, grantSetVersion: number): void {
    if (grant.grantVersion !== grantVersion) throw brokerError("grant.version-mismatch", "Capability grant version changed.");
    if (grant.grantSetVersion !== grantSetVersion) throw brokerError("grant-set.version-mismatch", "Capability grant-set version changed.");
    if (grant.scope.tenantRef !== actor.tenantRef || grant.scope.actorRef !== actor.actorRef) throw brokerError("grant.scope-denied", "Capability scope does not authorize this actor.");
    if (isExpired(grant.expiresAt, this.#now())) throw brokerError("grant.expired", "Capability grant expired.");
  }

  async #handlerFor(capabilityId: string): Promise<CapabilityHandler> {
    const grant = await this.#requireGrant(capabilityId);
    const handler = await this.#ports.handlers.get(grant.grant.handlerRef);
    if (!handler) throw brokerError("capability.handler-missing", "Capability handler is unavailable.");
    return handler;
  }

  async #finish(
    effectInput: StoredEffect,
    status: Extract<EffectStatus, "denied" | "succeeded" | "failed" | "cancelled">,
    failure?: Diagnostic,
    output?: CapabilityOutputBinding,
    publication?: EffectReceipt["publication"],
  ): Promise<EffectExecutionResult> {
    const effect = await this.#update(effectInput, (current) => {
      if (current.receipt) return current;
      return {
        ...current,
        status,
        receipt: makeReceipt(current, status, this.#id("effect-receipt"), this.#auditRef(current.request.requestId), failure, output, publication),
      };
    });
    const grant = await this.#ports.grants.getCapability(effect.request.capabilityId);
    return this.#view(effect, grant, false);
  }

  async #appendCancellation(effect: StoredEffect, receipt: EffectCancellationReceipt): Promise<void> {
    await this.#update(effect, (current) => ({ ...current, cancellations: [...current.cancellations, receipt] }));
  }

  async #update(effectInput: StoredEffect, update: (current: StoredEffect) => StoredEffect): Promise<StoredEffect> {
    let current = effectInput;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const next = compact<StoredEffect>({ ...update(structuredClone(current)), version: current.version, updatedAt: this.#now() });
      if (canonicalize(next) === canonicalize(current)) return current;
      if (await this.#ports.effects.compareAndSwap(current.request.requestId, current.version, next)) {
        return await this.#requireEffect(current.request.requestId);
      }
      current = await this.#requireEffect(current.request.requestId);
    }
    throw brokerError("effect.store-contention", "Effect store did not converge.");
  }

  /**
   * Claims a state transition exactly once. A failed CAS never retries the
   * transition against a newer effect because another caller may own it.
   */
  async #claimTransition(
    effect: StoredEffect,
    canTransition: (current: StoredEffect) => boolean,
    transition: (current: StoredEffect) => StoredEffect,
  ): Promise<{ claimed: boolean; effect: StoredEffect }> {
    if (!canTransition(effect)) return { claimed: false, effect };
    const next = compact<StoredEffect>({
      ...transition(structuredClone(effect)),
      version: effect.version,
      updatedAt: this.#now(),
    });
    if (canonicalize(next) === canonicalize(effect)) return { claimed: false, effect };
    if (await this.#ports.effects.compareAndSwap(effect.request.requestId, effect.version, next)) {
      return { claimed: true, effect: await this.#requireEffect(effect.request.requestId) };
    }
    return { claimed: false, effect: await this.#requireEffect(effect.request.requestId) };
  }

  async #requireEffect(requestId: string): Promise<StoredEffect> {
    const effect = await this.#ports.effects.get(requestId);
    if (!effect) throw brokerError("effect.not-found", "Effect request is unavailable.");
    return effect;
  }

  #view(effect: StoredEffect, grant: CapabilityGrant | undefined, replayed: boolean): EffectExecutionResult {
    return {
      summary: sanitizeEffectSummary(effect, grant),
      approval: effect.checkpoint && grant ? sanitizeApprovalCheckpoint(effect.checkpoint, grant) : undefined,
      receipt: effect.receipt ? sanitizeEffectReceipt(effect.receipt) : undefined,
      replayed,
    };
  }
}

export async function validateCapabilityGrant(
  input: CapabilityGrant,
  profile: SchemaProfileBinding,
  limits?: Partial<SchemaProfileLimits>,
): Promise<CapabilityGrant> {
  const grant = grantSchema.parse(input) as CapabilityGrant;
  assertSchemaProfile(grant.schemaProfile, profile);
  if (grant.kind === "write" && !grant.idempotency.required) throw brokerError("grant.write-idempotency", "Write capabilities must require idempotency.");
  if (grant.kind === "write" && grant.risk !== "low" && grant.approval === "never") throw brokerError("grant.write-approval", "Risky write capabilities must require approval.");
  if (grant.kind === "navigation" && !grant.navigationPolicy) throw brokerError("grant.navigation-policy", "Navigation capabilities require an explicit target policy.");
  await Promise.all([
    prepareJsonSchema(grant.inputSchema, grant.inputSchemaHash, { limits }),
    prepareJsonSchema(grant.outputSchema, grant.outputSchemaHash, { limits }),
  ]);
  return grant;
}

export function projectModelVisibleCapability(grant: CapabilityGrant): ModelVisibleCapability {
  return structuredClone({
    capabilityId: grant.capabilityId,
    grantVersion: grant.grantVersion,
    schemaProfile: grant.schemaProfile,
    kind: grant.kind,
    summary: grant.summary,
    inputSchemaId: grant.inputSchemaId,
    inputSchemaVersion: grant.inputSchemaVersion,
    inputSchema: grant.inputSchema,
    inputSchemaHash: grant.inputSchemaHash,
    outputSchemaId: grant.outputSchemaId,
    outputSchemaVersion: grant.outputSchemaVersion,
    outputSchemaHash: grant.outputSchemaHash,
    requiresApproval: grant.approval === "always" || (grant.approval === "risk-based" && grant.risk !== "low"),
  });
}

export function projectModelVisibleMessageTemplate(grant: MessageTemplateGrant): ModelVisibleMessageTemplate {
  return structuredClone({
    templateGrantId: grant.templateGrantId,
    templateGrantVersion: grant.templateGrantVersion,
    schemaProfile: grant.schemaProfile,
    summary: grant.summary,
    templateHash: grant.templateHash,
    variableSchema: grant.variableSchema,
    variableSchemaHash: grant.variableSchemaHash,
  });
}

export function sanitizeEffectSummary(effect: StoredEffect, grant?: CapabilityGrant): ClientEffectSummary {
  return {
    requestId: effect.request.requestId,
    invocationId: effect.request.invocationId,
    stepId: effect.request.stepId,
    actionId: effect.request.actionId,
    capabilityId: effect.request.capabilityId,
    status: effect.status,
    cancellable: !isTerminal(effect.status) && effect.status !== "denied" && (grant?.budgets.timeoutMs ?? 0) > 0,
  };
}

export function sanitizeApprovalCheckpoint(checkpoint: ApprovalCheckpoint, grant: CapabilityGrant): ClientApprovalCheckpoint {
  return {
    checkpointId: checkpoint.checkpointId,
    effectRequestId: checkpoint.requestId,
    status: checkpoint.status,
    capabilityId: grant.capabilityId,
    risk: grant.risk,
    title: grant.summary,
    expiresAt: checkpoint.expiresAt,
  };
}

export function sanitizeEffectReceipt(receipt: EffectReceipt): ClientEffectReceipt {
  return {
    receiptId: receipt.receiptId,
    requestId: receipt.requestId,
    status: receipt.status,
    output: receipt.output ? {
      contentHash: receipt.output.contentHash,
      mediaType: receipt.output.mediaType,
      sensitivity: receipt.output.sensitivity,
      outputResourceId: receipt.output.outputResourceId,
      evidenceIds: structuredClone(receipt.output.evidenceIds),
    } : undefined,
    publication: receipt.publication ? structuredClone(receipt.publication) : undefined,
    diagnostic: receipt.diagnostic ? structuredClone(receipt.diagnostic) : undefined,
  };
}

function validateActor(actor: ActorContext): ActorContext {
  if (!actor.tenantRef || !actor.actorRef || !actor.actorContextRef) throw brokerError("actor.invalid", "Actor context is incomplete.");
  return structuredClone(actor);
}

function validateCapabilityKind(grant: CapabilityGrant, input: JsonValue): void {
  if (grant.kind !== "navigation") return;
  const policy = grant.navigationPolicy!;
  if (input === null || Array.isArray(input) || typeof input !== "object") throw brokerError("navigation.invalid-target", "Navigation input must be an object.");
  const target = "target" in input ? input.target : input;
  if (target === null || Array.isArray(target) || typeof target !== "object" || typeof target.kind !== "string") {
    throw brokerError("navigation.invalid-target", "Navigation target is invalid.");
  }
  if (target.kind === "route" && typeof target.routeId === "string" && policy.allowedRouteIds.includes(target.routeId)) return;
  if (target.kind === "resource" && typeof target.resourceId === "string" && policy.allowedResourceIds.includes(target.resourceId)) return;
  if (target.kind === "external" && typeof target.url === "string") {
    let url: URL;
    try { url = new URL(target.url); } catch { throw brokerError("navigation.invalid-url", "External navigation URL is invalid."); }
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (policy.allowedSchemes.includes(scheme) && policy.allowedOrigins.includes(url.origin)) return;
  }
  throw brokerError("navigation.target-denied", "Navigation target is outside the capability policy.");
}

function renderMessageTemplate(template: string, values: Record<string, JsonValue>): string {
  const used = new Set<string>();
  const rendered = template.replace(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g, (_match, name: string) => {
    if (!Object.hasOwn(values, name)) throw brokerError("template.variable-missing", `Required template variable ${name} is missing.`);
    used.add(name);
    const value = values[name]!;
    return typeof value === "string" ? value : canonicalize(value);
  });
  if (rendered.includes("{{") || rendered.includes("}}")) throw brokerError("template.invalid-placeholder", "Message template contains an invalid placeholder.");
  for (const key of Object.keys(values)) {
    if (!used.has(key)) throw brokerError("template.variable-unused", `Template variable ${key} is not bound by the template.`);
  }
  return rendered;
}

function templateBinding(grant: MessageTemplateGrant): MessageTemplateBinding {
  return {
    templateGrantId: grant.templateGrantId,
    templateGrantVersion: grant.templateGrantVersion,
    grantSetVersion: grant.grantSetVersion,
    capabilityGrantVersion: grant.capabilityGrantVersion,
    templateId: grant.templateId,
    templateVersion: grant.templateVersion,
    templateHash: grant.templateHash,
    variableSchemaHash: grant.variableSchemaHash,
  };
}

function validateCommittedOutput(
  binding: CapabilityOutputBinding,
  requested: { resource?: { resourceId: string }; evidence?: Array<{ evidenceId: string }> },
  resource: ResourceReference | undefined,
  evidence: EvidenceReference[],
  publication: EffectReceipt["publication"],
): void {
  if (Boolean(requested.resource) !== Boolean(resource)) throw new SchemaContractError("output.resource-missing", "Output resource publication did not match the request.");
  if (resource) {
    resourceReferenceSchema.parse(resource);
    const exact = resource.resourceId === requested.resource?.resourceId
      && resource.schemaId === binding.outputSchemaId
      && resource.schemaVersion === binding.outputSchemaVersion
      && resource.schemaHash === binding.outputSchemaHash
      && resource.contentHash === binding.contentHash
      && resource.scopeRef === binding.scopeRef
      && resource.sensitivity === binding.sensitivity
      && resource.codec.id === binding.outputCodec.id
      && resource.codec.version === binding.outputCodec.version
      && resource.mediaType === binding.mediaType;
    if (!exact) throw new SchemaContractError("output.resource-binding", "Published resource does not match validated output.");
  }
  const expectedEvidence = new Set((requested.evidence ?? []).map((item) => item.evidenceId));
  if (evidence.length !== expectedEvidence.size) throw new SchemaContractError("output.evidence-count", "Published evidence count does not match.");
  for (const record of evidence) {
    evidenceReferenceSchema.parse(record);
    if (
      !expectedEvidence.delete(record.evidenceId)
      || record.schemaId !== binding.outputSchemaId
      || record.schemaVersion !== binding.outputSchemaVersion
      || record.schemaHash !== binding.outputSchemaHash
      || record.contentHash !== binding.contentHash
      || record.scopeRef !== binding.scopeRef
      || record.sensitivity !== binding.sensitivity
      || !binding.validationIds.every((id) => record.validationIds.includes(id))
      || (resource && !record.sourceRefs.some((source) => source.kind === "resource" && source.id === resource.resourceId && source.contentHash === resource.contentHash))
    ) throw new SchemaContractError("output.evidence-binding", "Published evidence does not match validated output.");
  }
  if (!publication || publication.expectedHeadToken.length === 0) throw new SchemaContractError("output.publication-binding", "Publication result is invalid.");
}

function assertOutputAuthority(scopeRef: string, sensitivity: Sensitivity, grant: CapabilityGrant, actor: ActorContext): void {
  if (
    !grant.scope.resourceScopeRefs.includes(scopeRef)
    || !grant.disclosure.allowedResourceScopeRefs.includes(scopeRef)
    || !actor.resourceScopeRefs.includes(scopeRef)
    || !grant.disclosure.allowedSensitivity.includes(sensitivity)
    || !actor.allowedSensitivity.includes(sensitivity)
  ) throw new SchemaContractError("output.scope-denied", "Sanitized output is outside authorized disclosure scope.");
}

function makeReceipt(
  effect: StoredEffect,
  status: EffectReceipt["status"],
  receiptId: string,
  auditRef: string,
  failure?: Diagnostic,
  output?: CapabilityOutputBinding,
  publication?: EffectReceipt["publication"],
): EffectReceipt {
  const initial = effect.decisions.find((item) => item.phase === "initial");
  const execution = [...effect.decisions].reverse().find((item) => item.phase === "pre-execution");
  return compact<EffectReceipt>({
    receiptId,
    requestId: effect.request.requestId,
    status,
    revisionId: effect.request.revisionId,
    expectedHeadToken: effect.request.expectedHeadToken,
    inputSchemaHash: effect.request.inputSchemaHash,
    inputHash: effect.request.inputHash,
    expectedOutputSchemaHash: effect.request.outputSchemaHash,
    grantVersion: effect.request.grantVersion,
    grantSetVersion: effect.request.grantSetVersion,
    messageTemplate: effect.request.messageTemplate,
    initialDecisionId: initial?.decisionId,
    executionDecisionId: execution?.decisionId,
    approvalCheckpointId: effect.checkpoint?.checkpointId,
    output,
    publication,
    diagnostic: failure,
    auditRef,
  });
}

function cancellation(
  cancellationId: string,
  input: { cancelRequestId: string; effectRequestId: string },
  outcome: EffectCancellationReceipt["outcome"],
  effectStatus: EffectStatus,
  recordedAt: string,
): EffectCancellationReceipt {
  return { cancellationId, cancelRequestId: input.cancelRequestId, effectRequestId: input.effectRequestId, outcome, effectStatus, recordedAt };
}

function operationKeyFor(effect: StoredEffect): string {
  return `${effect.request.invocationId}:${effect.request.stepId}:${effect.request.grantVersion}`;
}

function sensitivityRank(value: Sensitivity): number {
  return value === "public" ? 0 : value === "private" ? 1 : 2;
}

function isExpired(value: string | undefined, now: string): boolean {
  return value !== undefined && Date.parse(value) <= Date.parse(now);
}

function isTerminal(status: EffectStatus): boolean {
  return status === "denied" || status === "succeeded" || status === "failed" || status === "cancelled";
}

function diagnostic(code: string, message: string): Diagnostic {
  return createDiagnostic({ phase: "effect", code, severity: "error", recoverable: false, modelCorrectable: false, message });
}

function brokerError(code: string, message: string): CapabilityBrokerError {
  return new CapabilityBrokerError(diagnostic(code, message));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SchemaContractError("capability.timeout", "Capability handler timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => compact(item)) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = compact(item);
    }
    return output as T;
  }
  return value;
}
