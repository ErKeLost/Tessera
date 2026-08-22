import {
  parseJsonWithSchema,
  prepareJsonSchema,
} from "@open-tessera/capabilities";
import {
  ARTIFACT_PROTOCOL,
  ARTIFACT_PROTOCOL_VERSION,
  artifactDocumentSchema,
  canonicalHash,
  claimBindingSchema,
  decodeArtifactPart,
  documentPolicySchema,
  evidenceReferenceSchema,
  hashArtifactSemanticContent,
  projectArtifactSemanticContent,
  resourceReferenceSchema,
  stateDefinitionSchema,
  type ArtifactDocument,
  type ArtifactPart as RuntimeArtifactPart,
  type ClaimBinding,
  type EvidenceReference,
  type ResourceReference,
  type RuntimeSnapshot,
  type StateDefinition,
} from "@open-tessera/runtime";
import { computeDocumentPolicyHash, DEFAULT_DOCUMENT_POLICY } from "./information-flow";
import { isArtifactPart as isCompilerArtifactPart } from "./part";
import type {
  ArtifactPart as CompilerArtifactPart,
  DocumentPolicy,
  MaybePromise,
  NormalizedArtifactProposal,
  PromptBundle,
} from "./types";

const DEFAULT_BRANCH_ID = "main";
const sensitivityRank = { public: 0, private: 1, sensitive: 2 } as const;
const persistenceRank = { none: 0, session: 1, host: 2 } as const;

export type ArtifactUIIdKind =
  | "document"
  | "revision"
  | "head-token"
  | "state-revision"
  | "ui-part";

export type ArtifactUIHostContext = {
  branchId?: string;
  resources?: Readonly<Record<string, ResourceReference>>;
  evidence?: Readonly<Record<string, EvidenceReference>>;
};

export type ArtifactCommitHostContext = ArtifactUIHostContext;
export type ArtifactCommitIdKind = ArtifactUIIdKind;

type CommitBundle = Pick<
  PromptBundle,
  "catalogSlice" | "contractFingerprint" | "generationTaintHash" | "promptBundleHash" | "renderMode"
>;

export type ArtifactCommitOptions = ArtifactCommitHostContext & {
  documentPolicy?: DocumentPolicy;
  now?: () => string;
  idFactory?: (kind: ArtifactCommitIdKind, hint?: string) => string;
  stateDefinition?: (
    stateId: string,
    authoring: NormalizedArtifactProposal["state"][string],
    policy: DocumentPolicy,
  ) => MaybePromise<StateDefinition>;
};

export type MaterializeArtifactPartOptions = ArtifactCommitOptions & {
  bundle: CommitBundle;
  documentPolicy: DocumentPolicy;
};

export class ArtifactCommitError extends TypeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactCommitError";
    this.code = code;
  }
}

/**
 * Crosses the only trusted boundary from a compiler-branded proposal into the
 * runtime document protocol. Transport adapters should never construct runtime
 * snapshots independently.
 */
export async function materializeArtifactPart(
  proposalPart: CompilerArtifactPart,
  options: MaterializeArtifactPartOptions,
): Promise<RuntimeArtifactPart> {
  const { bundle, ...commitOptions } = options;
  return commitValidatedArtifactProposal(proposalPart, bundle, commitOptions);
}

export async function commitValidatedArtifactProposal(
  proposalPart: CompilerArtifactPart,
  bundle: CommitBundle,
  options: ArtifactCommitOptions = {},
): Promise<RuntimeArtifactPart> {
  assertMatchingCompilerPart(proposalPart, bundle);
  const proposal = proposalPart.snapshot;
  const now = options.now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) {
    throw new ArtifactCommitError("commit.invalid-now", "Commit time must be an ISO date-time.");
  }
  const nowMs = Date.parse(now);
  const documentPolicy = validateDocumentPolicy(options.documentPolicy ?? DEFAULT_DOCUMENT_POLICY, nowMs);
  const idFactory = options.idFactory ?? defaultArtifactIdFactory;
  const documentId = idFactory("document", proposal.root);
  const revisionId = idFactory("revision", documentId);
  const branchId = options.branchId ?? DEFAULT_BRANCH_ID;
  const state: Record<string, StateDefinition> = {};

  for (const [stateId, authoring] of Object.entries(proposal.state)) {
    const resolved = options.stateDefinition
      ? await options.stateDefinition(stateId, authoring, documentPolicy)
      : await createLocalStateDefinition(stateId, authoring, documentPolicy);
    state[stateId] = await validateStateDefinition(stateId, resolved, documentPolicy, nowMs);
  }

  const resources = selectResources(proposal.resourceIds, options.resources ?? {}, documentPolicy, nowMs);
  const evidence = selectEvidence(proposal, options.evidence ?? {}, documentPolicy, nowMs);
  const claims = parseClaims(proposal.claims);
  const documentBase: ArtifactDocument = artifactDocumentSchema.parse({
    protocol: ARTIFACT_PROTOCOL,
    protocolVersion: ARTIFACT_PROTOCOL_VERSION,
    documentId,
    revision: {
      revisionId,
      parentRevisionIds: [],
      branchId,
      sequence: 0,
      contentHash: "pending",
      contractFingerprint: bundle.contractFingerprint,
      migrationReceiptIds: [],
      stateTransitionReceiptIds: [],
    },
    policy: documentPolicy,
    catalog: {
      ...bundle.catalogSlice.catalog,
      contractFingerprint: bundle.contractFingerprint,
    },
    renderMode: bundle.renderMode,
    root: proposal.root,
    nodes: proposal.nodes,
    state,
    actions: proposal.actions,
    resources,
    evidence,
    claims,
    meta: { ...proposal.meta, createdAt: now, updatedAt: now },
  });
  const contentHash = await hashArtifactSemanticContent(projectArtifactSemanticContent(documentBase));
  const document = artifactDocumentSchema.parse({
    ...documentBase,
    revision: { ...documentBase.revision, contentHash },
  });
  const snapshot: RuntimeSnapshot = {
    document,
    branchHead: {
      branchId,
      revisionId,
      headToken: idFactory("head-token", revisionId),
    },
    state: await Promise.all(Object.entries(state).map(async ([stateId, definition]) => ({
      documentId,
      branchId,
      stateId,
      stateRevision: idFactory("state-revision", stateId),
      schemaId: definition.schemaId,
      schemaVersion: definition.schemaVersion,
      schemaHash: definition.schemaHash,
      policyHash: definition.policy.policyHash,
      value: definition.initial,
    }))),
    pendingActions: [],
    pendingEffects: [],
    activeApprovals: [],
    stateMigrationReceipts: [],
    stateTransitionReceipts: [],
  };
  const decoded = await decodeArtifactPart(
    { kind: "artifact-snapshot", snapshot },
    { contractFingerprint: bundle.contractFingerprint },
  );
  if (!decoded.success) {
    throw new ArtifactCommitError(
      "commit.runtime-validation-failed",
      `Runtime artifact validation failed: ${decoded.diagnostics.map(({ code }) => code).join(", ")}`,
    );
  }
  return decoded.part;
}

function assertMatchingCompilerPart(
  part: CompilerArtifactPart,
  bundle: CommitBundle,
): asserts part is CompilerArtifactPart<Readonly<NormalizedArtifactProposal>> {
  if (!isCompilerArtifactPart(part)) {
    throw new ArtifactCommitError(
      "commit.untrusted-proposal",
      "Only a locally validated compiler artifact part can be materialized.",
    );
  }
  if (
    part.contractFingerprint !== bundle.contractFingerprint
    || part.promptBundleHash !== bundle.promptBundleHash
    || part.generationTaintHash !== bundle.generationTaintHash
  ) {
    throw new ArtifactCommitError(
      "commit.bundle-identity-mismatch",
      "Compiler artifact identity does not match the active prompt bundle.",
    );
  }
}

async function createLocalStateDefinition(
  stateId: string,
  authoring: NormalizedArtifactProposal["state"][string],
  documentPolicy: DocumentPolicy,
): Promise<StateDefinition> {
  const schemaHash = await canonicalHash(authoring.schema);
  const policy = {
    policyId: `data-elements.local-state.${stateId}`,
    policyVersion: 1,
    policyHash: "pending",
    scope: "document" as const,
    persistence: documentPolicy.persistence,
    sensitivity: documentPolicy.sensitivity,
    modelAccess: "none" as const,
    lifecycle: "retain" as const,
    ...(documentPolicy.expiresAt ? { expiresAt: documentPolicy.expiresAt } : {}),
  };
  policy.policyHash = await canonicalHash({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    scope: policy.scope,
    persistence: policy.persistence,
    sensitivity: policy.sensitivity,
    modelAccess: policy.modelAccess,
    lifecycle: policy.lifecycle,
    ...(policy.expiresAt ? { expiresAt: policy.expiresAt } : {}),
  });
  return stateDefinitionSchema.parse({
    schemaId: `data-elements.state.${stateId}`,
    schema: authoring.schema,
    schemaVersion: 1,
    schemaHash,
    initial: authoring.initial,
    policy,
  });
}

async function validateStateDefinition(
  stateId: string,
  input: StateDefinition,
  documentPolicy: DocumentPolicy,
  nowMs: number,
): Promise<StateDefinition> {
  const definition = stateDefinitionSchema.parse(input);
  const actualPolicyHash = await canonicalHash({
    policyId: definition.policy.policyId,
    policyVersion: definition.policy.policyVersion,
    scope: definition.policy.scope,
    persistence: definition.policy.persistence,
    sensitivity: definition.policy.sensitivity,
    modelAccess: definition.policy.modelAccess,
    lifecycle: definition.policy.lifecycle,
    ...(definition.policy.expiresAt ? { expiresAt: definition.policy.expiresAt } : {}),
  });
  if (definition.policy.policyHash !== actualPolicyHash) {
    throw new ArtifactCommitError(
      "commit.state-policy-hash-mismatch",
      `State ${stateId} policy hash does not match its static fields.`,
    );
  }
  assertPolicyBoundary(
    stateId,
    definition.policy.persistence,
    definition.policy.sensitivity,
    definition.policy.expiresAt,
    documentPolicy,
    nowMs,
  );
  if (definition.policy.modelAccess !== "none"
    && !documentPolicy.allowedSinks.includes("model-generation")) {
    throw new ArtifactCommitError(
      "commit.state-model-access-denied",
      `State ${stateId} requests model access outside the document policy.`,
    );
  }
  const prepared = await prepareJsonSchema(definition.schema, definition.schemaHash);
  return stateDefinitionSchema.parse({
    ...definition,
    initial: parseJsonWithSchema(prepared.validator, definition.initial),
  });
}

function selectResources(
  ids: readonly string[],
  available: Readonly<Record<string, ResourceReference>>,
  documentPolicy: DocumentPolicy,
  nowMs: number,
): Record<string, ResourceReference> {
  return Object.fromEntries([...new Set(ids)].sort().map((id) => {
    const resource = available[id];
    if (!resource) {
      throw new ArtifactCommitError("commit.resource-not-granted", `Resource ${id} is not host-granted.`);
    }
    const parsed = resourceReferenceSchema.parse(resource);
    if (parsed.resourceId !== id) {
      throw new ArtifactCommitError(
        "commit.resource-identity-mismatch",
        `Resource ${id} does not match its grant identity.`,
      );
    }
    assertReferenceBoundary(id, parsed, documentPolicy, nowMs, "resource");
    return [id, parsed];
  }));
}

function selectEvidence(
  proposal: Readonly<NormalizedArtifactProposal>,
  available: Readonly<Record<string, EvidenceReference>>,
  documentPolicy: DocumentPolicy,
  nowMs: number,
): Record<string, EvidenceReference> {
  const ids = new Set(Object.values(proposal.nodes).flatMap((node) => node.evidence ?? []));
  for (const claim of Object.values(proposal.claims)) {
    const evidenceIds = isRecord(claim) ? claim.evidenceIds : undefined;
    if (Array.isArray(evidenceIds)) {
      for (const id of evidenceIds) if (typeof id === "string") ids.add(id);
    }
  }
  return Object.fromEntries([...ids].sort().map((id) => {
    const evidence = available[id];
    if (!evidence) {
      throw new ArtifactCommitError("commit.evidence-not-granted", `Evidence ${id} is not host-granted.`);
    }
    const parsed = evidenceReferenceSchema.parse(evidence);
    if (parsed.evidenceId !== id) {
      throw new ArtifactCommitError(
        "commit.evidence-identity-mismatch",
        `Evidence ${id} does not match its grant identity.`,
      );
    }
    assertReferenceBoundary(id, parsed, documentPolicy, nowMs, "evidence");
    return [id, parsed];
  }));
}

function parseClaims(input: Readonly<Record<string, unknown>>): Record<string, ClaimBinding> {
  return Object.fromEntries(Object.entries(input).map(([id, claim]) => [
    id,
    claimBindingSchema.parse(claim),
  ]));
}

export function toArtifactPartWire(part: RuntimeArtifactPart): import("@open-tessera/runtime").ArtifactPartWire {
  return part.kind === "artifact-snapshot"
    ? { kind: part.kind, snapshot: part.snapshot }
    : { kind: part.kind, ...(part.base ? { base: part.base } : {}), events: part.events };
}

export function mergeArtifactCommitHostContext(
  base: ArtifactCommitHostContext,
  turn: ArtifactCommitHostContext,
): Required<ArtifactCommitHostContext> {
  return {
    branchId: turn.branchId ?? base.branchId ?? DEFAULT_BRANCH_ID,
    resources: { ...base.resources, ...turn.resources },
    evidence: { ...base.evidence, ...turn.evidence },
  };
}

export function defaultArtifactIdFactory(kind: ArtifactCommitIdKind, hint = "artifact"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    throw new ArtifactCommitError(
      "commit.secure-id-factory-required",
      "A secure idFactory is required when crypto.randomUUID is unavailable.",
    );
  }
  return `${kind}:${hint.slice(0, 48)}:${uuid}`;
}

function validateDocumentPolicy(input: DocumentPolicy, nowMs: number): DocumentPolicy {
  const policy = documentPolicySchema.parse(input) as DocumentPolicy;
  if (policy.policyHash !== computeDocumentPolicyHash(policy)) {
    throw new ArtifactCommitError(
      "commit.document-policy-hash-mismatch",
      "Document policy hash does not match its static fields.",
    );
  }
  assertNotExpired(policy.expiresAt, nowMs, "commit.document-policy-expired", "Document policy");
  return policy;
}

function assertReferenceBoundary(
  id: string,
  reference: ResourceReference | EvidenceReference,
  documentPolicy: DocumentPolicy,
  nowMs: number,
  kind: "resource" | "evidence",
): void {
  if (reference.scopeRef !== documentPolicy.scopeRef) {
    throw new ArtifactCommitError(
      `commit.${kind}-scope-mismatch`,
      `${capitalize(kind)} ${id} is outside the document policy scope.`,
    );
  }
  if (sensitivityRank[reference.sensitivity] < sensitivityRank[documentPolicy.sensitivity]) {
    throw new ArtifactCommitError(
      `commit.${kind}-sensitivity-lowered`,
      `${capitalize(kind)} ${id} lowers the document policy sensitivity.`,
    );
  }
  assertExpiryBoundary(id, reference.expiresAt, documentPolicy.expiresAt, nowMs, kind);
}

function assertPolicyBoundary(
  id: string,
  persistence: keyof typeof persistenceRank,
  sensitivity: keyof typeof sensitivityRank,
  expiresAt: string | undefined,
  documentPolicy: DocumentPolicy,
  nowMs: number,
): void {
  if (persistenceRank[persistence] > persistenceRank[documentPolicy.persistence]) {
    throw new ArtifactCommitError(
      "commit.state-persistence-broadened",
      `State ${id} persists longer than the document policy allows.`,
    );
  }
  if (sensitivityRank[sensitivity] < sensitivityRank[documentPolicy.sensitivity]) {
    throw new ArtifactCommitError(
      "commit.state-sensitivity-lowered",
      `State ${id} lowers the document policy sensitivity.`,
    );
  }
  assertExpiryBoundary(id, expiresAt, documentPolicy.expiresAt, nowMs, "state");
}

function assertExpiryBoundary(
  id: string,
  expiresAt: string | undefined,
  documentExpiresAt: string | undefined,
  nowMs: number,
  kind: "state" | "resource" | "evidence",
): void {
  assertNotExpired(expiresAt, nowMs, `commit.${kind}-expired`, `${capitalize(kind)} ${id}`);
  if (documentExpiresAt !== undefined
    && (expiresAt === undefined || Date.parse(expiresAt) > Date.parse(documentExpiresAt))) {
    throw new ArtifactCommitError(
      `commit.${kind}-expiry-broadened`,
      `${capitalize(kind)} ${id} outlives the document policy.`,
    );
  }
}

function assertNotExpired(
  expiresAt: string | undefined,
  nowMs: number,
  code: string,
  label: string,
): void {
  if (expiresAt !== undefined && Date.parse(expiresAt) <= nowMs) {
    throw new ArtifactCommitError(code, `${label} has expired.`);
  }
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
