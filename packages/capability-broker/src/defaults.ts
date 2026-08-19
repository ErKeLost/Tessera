import {
  canonicalize,
  evidenceReferenceSchema,
  resourceReferenceSchema,
  type EvidenceReference,
  type JsonValue,
  type ResourceReference,
} from "@data-elements/runtime";
import type {
  ActorContext,
  ApprovalCheckpoint,
  AuthoritySnapshot,
  CapabilityAuthorityPort,
  CapabilityGrant,
  CapabilityOutputCommitPort,
  CapabilityOutputPolicyPort,
  OutputCodecPort,
  PolicyEvaluationInput,
  PolicyEvaluatorPort,
  PublicationResult,
  Sensitivity,
  ValidatedOutputCommit,
} from "./types";

type AuthorityRecord = {
  documentId: string;
  branchId: string;
  revisionId: string;
  headToken: string;
  tenantRef: string;
  actorRefs: string[];
  stateRevisions: Record<string, string>;
};

export class InMemoryCapabilityAuthority implements CapabilityAuthorityPort {
  readonly #records = new Map<string, AuthorityRecord>();
  readonly #approverRefs = new Set<string>();

  constructor(records: readonly AuthorityRecord[] = [], approverRefs: readonly string[] = []) {
    for (const record of records) this.set(record);
    for (const actorRef of approverRefs) this.#approverRefs.add(actorRef);
  }

  set(record: AuthorityRecord): void {
    this.#records.set(authorityKey(record.documentId, record.branchId), structuredClone(record));
  }

  allowApprover(actorRef: string): void {
    this.#approverRefs.add(actorRef);
  }

  async authorize(input: {
    phase: "initial" | "pre-execution";
    actor: ActorContext;
    grant: CapabilityGrant;
    request: { documentId: string; branchId: string; revisionId: string; expectedHeadToken: string; statePreconditions: Record<string, string> };
  }): Promise<AuthoritySnapshot> {
    const current = this.#records.get(authorityKey(input.request.documentId, input.request.branchId));
    if (!current) return deniedSnapshot(input.request, "authority.document-missing");
    const reasons: string[] = [];
    if (current.tenantRef !== input.actor.tenantRef) reasons.push("authority.tenant-mismatch");
    if (!current.actorRefs.includes(input.actor.actorRef)) reasons.push("authority.actor-denied");
    if (current.revisionId !== input.request.revisionId) reasons.push("authority.revision-mismatch");
    if (current.headToken !== input.request.expectedHeadToken) reasons.push("authority.head-mismatch");
    for (const [stateId, expected] of Object.entries(input.request.statePreconditions)) {
      if (current.stateRevisions[stateId] !== expected) reasons.push(`authority.state-stale:${stateId}`);
    }
    return {
      allowed: reasons.length === 0,
      reasonCodes: reasons,
      revisionId: current.revisionId,
      headToken: current.headToken,
      stateRevisions: structuredClone(current.stateRevisions),
    };
  }

  async authorizeApproval(input: {
    actor: ActorContext;
    approver: ActorContext;
    grant: CapabilityGrant;
    checkpoint: ApprovalCheckpoint;
  }): Promise<{ allowed: boolean; reasonCodes: string[] }> {
    const reasons: string[] = [];
    if (input.actor.tenantRef !== input.approver.tenantRef) reasons.push("approval.tenant-mismatch");
    if (this.#approverRefs.size > 0 && !this.#approverRefs.has(input.approver.actorRef)) reasons.push("approval.actor-denied");
    return { allowed: reasons.length === 0, reasonCodes: reasons };
  }
}

export class DefaultPolicyEvaluator implements PolicyEvaluatorPort {
  async evaluate(input: PolicyEvaluationInput): Promise<{
    outcome: "allow" | "deny" | "require-approval";
    reasonCodes: string[];
    policyHash: string;
  }> {
    if (!input.authority.allowed) {
      return { outcome: "deny", reasonCodes: input.authority.reasonCodes, policyHash: input.grant.policyProfileHash };
    }
    const needsApproval = input.grant.approval === "always"
      || (input.grant.approval === "risk-based" && input.grant.risk !== "low");
    if (input.phase === "initial" && needsApproval) {
      return { outcome: "require-approval", reasonCodes: ["policy.risk-approval"], policyHash: input.grant.policyProfileHash };
    }
    if (input.phase === "pre-execution" && needsApproval && !input.approved) {
      return { outcome: "deny", reasonCodes: ["policy.approval-missing"], policyHash: input.grant.policyProfileHash };
    }
    return { outcome: "allow", reasonCodes: ["policy.allowed"], policyHash: input.grant.policyProfileHash };
  }
}

export class JsonOutputCodec implements OutputCodecPort {
  async decode(codec: { id: string; version: string }, bytes: Uint8Array): Promise<unknown> {
    if (codec.id !== "json" || codec.version !== "1") throw new Error(`Unsupported output codec ${codec.id}@${codec.version}.`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  }
}

export type OutputRedactor = (input: {
  value: JsonValue;
  scopeRef: string;
  sensitivity: Sensitivity;
  grant: CapabilityGrant;
  actor: ActorContext;
}) => JsonValue | Promise<JsonValue>;

export class DefaultCapabilityOutputPolicy implements CapabilityOutputPolicyPort {
  readonly #redact: OutputRedactor;

  constructor(redact: OutputRedactor = ({ value }) => value) {
    this.#redact = redact;
  }

  async sanitize(input: {
    value: JsonValue;
    requestedScopeRef: string;
    requestedSensitivity: Sensitivity;
    grant: CapabilityGrant;
    actor: ActorContext;
  }): Promise<{ value: JsonValue; scopeRef: string; sensitivity: Sensitivity; validationIds: string[] }> {
    if (!input.grant.scope.resourceScopeRefs.includes(input.requestedScopeRef)) throw new Error("Output scope is outside the capability grant.");
    if (!input.actor.resourceScopeRefs.includes(input.requestedScopeRef)) throw new Error("Output scope is outside the actor context.");
    if (!input.grant.disclosure.allowedResourceScopeRefs.includes(input.requestedScopeRef)) throw new Error("Output scope is not disclosed by the grant.");
    if (!input.grant.disclosure.allowedSensitivity.includes(input.requestedSensitivity)) throw new Error("Output sensitivity is not allowed by the grant.");
    if (!input.actor.allowedSensitivity.includes(input.requestedSensitivity)) throw new Error("Output sensitivity is not allowed for the actor.");
    return {
      value: await this.#redact({
        value: structuredClone(input.value),
        scopeRef: input.requestedScopeRef,
        sensitivity: input.requestedSensitivity,
        grant: input.grant,
        actor: input.actor,
      }),
      scopeRef: input.requestedScopeRef,
      sensitivity: input.requestedSensitivity,
      validationIds: ["output.scope-authorized", "output.redaction-applied"],
    };
  }
}

export class InMemoryCapabilityOutputCommitter implements CapabilityOutputCommitPort {
  readonly resources = new Map<string, ResourceReference>();
  readonly evidence = new Map<string, EvidenceReference>();
  readonly publications = new Map<string, JsonValue>();
  readonly #heads = new Map<string, { headToken: string; revisionId: string }>();
  readonly #now: () => string;

  constructor(options: { now?: () => string } = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  setHead(documentId: string, branchId: string, headToken: string, revisionId: string): void {
    this.#heads.set(authorityKey(documentId, branchId), { headToken, revisionId });
  }

  async commit(input: ValidatedOutputCommit): Promise<{
    resource?: ResourceReference;
    evidence: EvidenceReference[];
    publication: PublicationResult;
  }> {
    let resource: ResourceReference | undefined;
    if (input.resource) {
      resource = resourceReferenceSchema.parse({
        resourceId: input.resource.resourceId,
        schemaId: input.binding.outputSchemaId,
        schemaVersion: input.binding.outputSchemaVersion,
        schemaHash: input.binding.outputSchemaHash,
        codec: input.binding.outputCodec,
        mediaType: input.binding.mediaType,
        contentHash: input.binding.contentHash,
        scopeRef: input.binding.scopeRef,
        sensitivity: input.binding.sensitivity,
        expiresAt: input.resource.expiresAt,
      });
    }

    if (input.evidence.length > 0 && !resource) throw new Error("Published evidence must cite a published output resource.");
    const evidence = input.evidence.map((candidate): EvidenceReference => evidenceReferenceSchema.parse({
      evidenceId: candidate.evidenceId,
      schemaId: input.binding.outputSchemaId,
      schemaVersion: input.binding.outputSchemaVersion,
      schemaHash: input.binding.outputSchemaHash,
      sourceRefs: [{ kind: "resource", id: resource!.resourceId, contentHash: input.binding.contentHash }],
      activityRefs: [...new Set([input.request.requestId, ...candidate.activityRefs])],
      contentHash: input.binding.contentHash,
      scopeRef: input.binding.scopeRef,
      observedAt: candidate.observedAt,
      recordedAt: this.#now(),
      expiresAt: candidate.expiresAt,
      validationIds: input.binding.validationIds,
      sensitivity: input.binding.sensitivity,
    }));
    let publication: PublicationResult = {
      status: "not-requested",
      expectedHeadToken: input.request.expectedHeadToken,
    };
    if (input.publication) {
      const key = authorityKey(input.request.documentId, input.request.branchId);
      const head = this.#heads.get(key);
      if (!head || head.headToken !== input.request.expectedHeadToken || head.revisionId !== input.request.revisionId) {
        publication = { status: "conflict", expectedHeadToken: input.request.expectedHeadToken };
      } else {
        const publicationKey = `${input.request.documentId}\u0000${input.publication.revisionId}`;
        assertImmutable(this.publications, publicationKey, input.publication.value);
        publication = {
          status: "committed",
          expectedHeadToken: input.request.expectedHeadToken,
          revisionId: input.publication.revisionId,
        };
      }
    }

    if (resource) assertImmutable(this.resources, resource.resourceId, resource);
    for (const record of evidence) assertImmutable(this.evidence, record.evidenceId, record);
    if (resource) putImmutable(this.resources, resource.resourceId, resource);
    for (const record of evidence) putImmutable(this.evidence, record.evidenceId, record);
    if (input.publication && publication.status === "committed") {
      const key = authorityKey(input.request.documentId, input.request.branchId);
      const publicationKey = `${input.request.documentId}\u0000${input.publication.revisionId}`;
      putImmutable(this.publications, publicationKey, input.publication.value);
      this.#heads.set(key, {
        headToken: `head:${input.publication.revisionId}:${input.binding.contentHash}`,
        revisionId: input.publication.revisionId,
      });
    }
    return {
      ...(resource ? { resource: structuredClone(resource) } : {}),
      evidence: structuredClone(evidence),
      publication,
    };
  }
}

function putImmutable<T>(map: Map<string, T>, key: string, value: T): void {
  assertImmutable(map, key, value);
  if (!map.has(key)) map.set(key, structuredClone(value));
}

function assertImmutable<T>(map: Map<string, T>, key: string, value: T): void {
  const prior = map.get(key);
  if (prior && canonicalize(prior) !== canonicalize(value)) throw new Error(`Immutable identity conflict: ${key}.`);
}

function deniedSnapshot(
  request: { revisionId: string; expectedHeadToken: string },
  reason: string,
): AuthoritySnapshot {
  return {
    allowed: false,
    reasonCodes: [reason],
    revisionId: request.revisionId,
    headToken: request.expectedHeadToken,
    stateRevisions: {},
  };
}

function authorityKey(documentId: string, branchId: string): string {
  return `${documentId}\u0000${branchId}`;
}
