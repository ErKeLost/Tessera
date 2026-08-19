import type {
  ActionPlan,
  ActionStep,
  Diagnostic,
  EvidenceReference,
  JsonValue,
  ResourceReference,
} from "@data-elements/runtime";

export type JsonSchema = boolean | Record<string, JsonValue>;
export type Sensitivity = "public" | "private" | "sensitive";
export type CapabilityKind = "read" | "write" | "navigation" | "export" | "agent-message";
export type CapabilityRisk = "low" | "medium" | "high" | "critical";
export type ApprovalMode = "never" | "risk-based" | "always";
export type EffectStatus =
  | "pending"
  | "denied"
  | "awaiting-approval"
  | "approved"
  | "running"
  | "cancel-requested"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SchemaProfileBinding = {
  profileId: "data-elements.schema-core";
  profileVersion: number;
  profileHash: string;
};

export type SchemaProfileLimits = {
  maxSchemaDepth: number;
  maxSchemaNodes: number;
  maxUnionBranches: number;
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectProperties: number;
};

export type CapabilityDisclosure = {
  allowedSensitivity: Sensitivity[];
  requireModelReadableState: boolean;
  allowedResourceScopeRefs: string[];
};

export type NavigationPolicy = {
  allowedRouteIds: string[];
  allowedResourceIds: string[];
  allowedSchemes: string[];
  allowedOrigins: string[];
};

export type CapabilityGrant = {
  capabilityId: string;
  grantVersion: number;
  grantSetVersion: number;
  schemaProfile: SchemaProfileBinding;
  kind: CapabilityKind;
  summary: string;
  inputSchemaId: string;
  inputSchemaVersion: number;
  inputSchema: JsonSchema;
  inputSchemaHash: string;
  outputSchemaId: string;
  outputSchemaVersion: number;
  outputSchema: JsonSchema;
  outputSchemaHash: string;
  outputCodec: { id: string; version: string };
  outputMediaType: string;
  scope: {
    tenantRef: string;
    actorRef: string;
    resourceScopeRefs: string[];
  };
  risk: CapabilityRisk;
  approval: ApprovalMode;
  idempotency: { required: boolean; retentionMs: number };
  budgets: {
    timeoutMs: number;
    maxCalls: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  };
  disclosure: CapabilityDisclosure;
  navigationPolicy?: NavigationPolicy;
  policyProfileHash: string;
  handlerRef: string;
  expiresAt?: string;
};

export type ModelVisibleCapability = {
  capabilityId: string;
  grantVersion: number;
  schemaProfile: SchemaProfileBinding;
  kind: CapabilityKind;
  summary: string;
  inputSchemaId: string;
  inputSchemaVersion: number;
  inputSchema: JsonSchema;
  inputSchemaHash: string;
  outputSchemaId: string;
  outputSchemaVersion: number;
  outputSchemaHash: string;
  requiresApproval: boolean;
};

export type MessageTemplateGrant = {
  templateGrantId: string;
  templateGrantVersion: number;
  grantSetVersion: number;
  schemaProfile: SchemaProfileBinding;
  capabilityId: string;
  capabilityGrantVersion: number;
  templateId: string;
  templateVersion: number;
  template: string;
  templateHash: string;
  summary: string;
  variableSchema: JsonSchema;
  variableSchemaHash: string;
  disclosure: CapabilityDisclosure;
  status: "active" | "revoked";
  expiresAt?: string;
};

export type ModelVisibleMessageTemplate = {
  templateGrantId: string;
  templateGrantVersion: number;
  schemaProfile: SchemaProfileBinding;
  summary: string;
  templateHash: string;
  variableSchema: JsonSchema;
  variableSchemaHash: string;
};

export type ModelVisibleGrantSet = {
  grantSetVersion: number;
  capabilities: ModelVisibleCapability[];
  messageTemplates: ModelVisibleMessageTemplate[];
};

export type MessageTemplateBinding = {
  templateGrantId: string;
  templateGrantVersion: number;
  grantSetVersion: number;
  capabilityGrantVersion: number;
  templateId: string;
  templateVersion: number;
  templateHash: string;
  variableSchemaHash: string;
};

export type ActorContext = {
  tenantRef: string;
  actorRef: string;
  actorContextRef: string;
  resourceScopeRefs: string[];
  allowedSensitivity: Sensitivity[];
};

export type EffectSubmission = {
  requestId: string;
  invocationId: string;
  stepId: string;
  documentId: string;
  branchId: string;
  revisionId: string;
  expectedHeadToken: string;
  nodeId: string;
  eventPort: string;
  actionId: string;
  capabilityId: string;
  grantVersion: number;
  grantSetVersion: number;
  input: JsonValue;
  statePreconditions: Record<string, string>;
  idempotencyKey: string;
  messageTemplate?: {
    templateGrantId: string;
    templateGrantVersion: number;
    values: Record<string, JsonValue>;
  };
};

export type EffectRequest = Omit<EffectSubmission, "input" | "messageTemplate"> & {
  messageTemplate?: MessageTemplateBinding;
  resolvedInput: JsonValue;
  inputSchemaHash: string;
  inputHash: string;
  outputSchemaHash: string;
  actorContextRef: string;
  renderedMessage?: string;
};

export type PolicyDecision = {
  decisionId: string;
  requestId: string;
  phase: "initial" | "pre-execution";
  outcome: "allow" | "deny" | "require-approval";
  policyHash: string;
  grantVersion: number;
  grantSetVersion: number;
  revisionId: string;
  headToken: string;
  inputSchemaHash: string;
  inputHash: string;
  outputSchemaHash: string;
  messageTemplate?: MessageTemplateBinding;
  reasonCodes: string[];
  evaluatedAt: string;
};

export type ApprovalCheckpoint = {
  checkpointId: string;
  requestId: string;
  documentId: string;
  branchId: string;
  decisionId: string;
  policyHash: string;
  grantVersion: number;
  grantSetVersion: number;
  revisionId: string;
  headToken: string;
  inputSchemaHash: string;
  inputHash: string;
  outputSchemaHash: string;
  messageTemplate?: MessageTemplateBinding;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  approverContextRef?: string;
  expiresAt: string;
};

export type CapabilityOutputBinding = {
  outputSchemaId: string;
  outputSchemaVersion: number;
  outputSchemaHash: string;
  outputCodec: { id: string; version: string };
  contentHash: string;
  byteLength: number;
  mediaType: string;
  scopeRef: string;
  sensitivity: Sensitivity;
  validationIds: string[];
  outputResourceId?: string;
  evidenceIds: string[];
};

export type PublicationResult = {
  status: "not-requested" | "committed" | "conflict";
  expectedHeadToken: string;
  revisionId?: string;
};

export type EffectReceipt = {
  receiptId: string;
  requestId: string;
  status: EffectStatus;
  revisionId: string;
  expectedHeadToken: string;
  inputSchemaHash: string;
  inputHash: string;
  expectedOutputSchemaHash: string;
  grantVersion: number;
  grantSetVersion: number;
  messageTemplate?: MessageTemplateBinding;
  initialDecisionId?: string;
  executionDecisionId?: string;
  approvalCheckpointId?: string;
  output?: CapabilityOutputBinding;
  publication?: PublicationResult;
  diagnostic?: Diagnostic;
  auditRef: string;
};

export type ClientEffectSummary = {
  requestId: string;
  invocationId: string;
  stepId: string;
  actionId: string;
  capabilityId: string;
  status: EffectStatus;
  cancellable: boolean;
};

export type ClientApprovalCheckpoint = {
  checkpointId: string;
  effectRequestId: string;
  status: ApprovalCheckpoint["status"];
  capabilityId: string;
  risk: CapabilityRisk;
  title: string;
  summary?: string;
  redactedInputSummary?: JsonValue;
  expiresAt: string;
};

export type ClientEffectReceipt = Pick<EffectReceipt, "receiptId" | "requestId" | "status" | "publication" | "diagnostic"> & {
  output?: Pick<CapabilityOutputBinding, "contentHash" | "mediaType" | "sensitivity" | "outputResourceId" | "evidenceIds">;
};

export type EffectCancellationReceipt = {
  cancellationId: string;
  cancelRequestId: string;
  effectRequestId: string;
  outcome: "cancel-requested" | "cancelled" | "too-late";
  effectStatus: EffectStatus;
  recordedAt: string;
};

export type AuthoritySnapshot = {
  allowed: boolean;
  reasonCodes: string[];
  revisionId: string;
  headToken: string;
  stateRevisions: Record<string, string>;
};

export type PolicyEvaluationInput = {
  phase: PolicyDecision["phase"];
  request: EffectRequest;
  grant: CapabilityGrant;
  actor: ActorContext;
  authority: AuthoritySnapshot;
  approved: boolean;
};

export type CapabilityHandlerOutput = {
  bytes: Uint8Array;
  mediaType: string;
  scopeRef: string;
  sensitivity: Sensitivity;
  validationIds: string[];
  resource?: { resourceId: string; expiresAt?: string };
  evidence?: Array<{
    evidenceId: string;
    activityRefs: string[];
    observedAt?: string;
    expiresAt?: string;
  }>;
  publication?: { revisionId: string; value: JsonValue };
};

export type CapabilityHandlerContext = {
  request: EffectRequest;
  actor: ActorContext;
  grant: CapabilityGrant;
  operationKey: string;
  signal: AbortSignal;
};

export interface CapabilityHandler {
  execute(context: CapabilityHandlerContext): Promise<CapabilityHandlerOutput>;
  cancel?(operationKey: string): Promise<boolean>;
}

export interface CapabilityGrantStorePort {
  getCapability(capabilityId: string): Promise<CapabilityGrant | undefined>;
  getMessageTemplate(templateGrantId: string): Promise<MessageTemplateGrant | undefined>;
  listCapabilities(): Promise<CapabilityGrant[]>;
  listMessageTemplates(): Promise<MessageTemplateGrant[]>;
  getGrantSetVersion(): Promise<number>;
}

export interface CapabilityHandlerRegistryPort {
  get(handlerRef: string): Promise<CapabilityHandler | undefined>;
}

export interface CapabilityAuthorityPort {
  authorize(input: {
    phase: PolicyDecision["phase"];
    actor: ActorContext;
    grant: CapabilityGrant;
    request: EffectRequest;
  }): Promise<AuthoritySnapshot>;
  authorizeApproval(input: {
    actor: ActorContext;
    approver: ActorContext;
    grant: CapabilityGrant;
    checkpoint: ApprovalCheckpoint;
  }): Promise<{ allowed: boolean; reasonCodes: string[] }>;
}

export interface PolicyEvaluatorPort {
  evaluate(input: PolicyEvaluationInput): Promise<{
    outcome: PolicyDecision["outcome"];
    reasonCodes: string[];
    policyHash: string;
  }>;
}

export interface OutputCodecPort {
  decode(codec: { id: string; version: string }, bytes: Uint8Array): Promise<unknown>;
}

export interface CapabilityOutputPolicyPort {
  sanitize(input: {
    value: JsonValue;
    requestedScopeRef: string;
    requestedSensitivity: Sensitivity;
    grant: CapabilityGrant;
    actor: ActorContext;
  }): Promise<{ value: JsonValue; scopeRef: string; sensitivity: Sensitivity; validationIds: string[] }>;
}

export type ValidatedOutputCommit = {
  request: EffectRequest;
  grant: CapabilityGrant;
  actor: ActorContext;
  value: JsonValue;
  binding: CapabilityOutputBinding;
  resource?: NonNullable<CapabilityHandlerOutput["resource"]>;
  evidence: NonNullable<CapabilityHandlerOutput["evidence"]>;
  publication?: NonNullable<CapabilityHandlerOutput["publication"]>;
};

export interface CapabilityOutputCommitPort {
  commit(input: ValidatedOutputCommit): Promise<{
    resource?: ResourceReference;
    evidence: EvidenceReference[];
    publication: PublicationResult;
  }>;
}

export type StoredEffect = {
  version: number;
  payloadHash: string;
  idempotencyKey: string;
  request: EffectRequest;
  actor: ActorContext;
  status: EffectStatus;
  decisions: PolicyDecision[];
  cancellations: EffectCancellationReceipt[];
  checkpoint?: ApprovalCheckpoint;
  receipt?: EffectReceipt;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type EffectClaimResult =
  | { status: "claimed"; effect: StoredEffect }
  | { status: "replayed" | "pending"; effect: StoredEffect }
  | { status: "conflict"; effect: StoredEffect };

export interface EffectStorePort {
  claim(effect: StoredEffect): Promise<EffectClaimResult>;
  get(requestId: string): Promise<StoredEffect | undefined>;
  compareAndSwap(requestId: string, expectedVersion: number, next: StoredEffect): Promise<boolean>;
  countCalls(actorContextRef: string, capabilityId: string, since: string): Promise<number>;
  list?(): Promise<StoredEffect[]>;
}

export type CapabilityBrokerPorts = {
  grants: CapabilityGrantStorePort;
  handlers: CapabilityHandlerRegistryPort;
  authority: CapabilityAuthorityPort;
  policy: PolicyEvaluatorPort;
  codecs: OutputCodecPort;
  outputPolicy: CapabilityOutputPolicyPort;
  outputCommit: CapabilityOutputCommitPort;
  effects: EffectStorePort;
};

export type EffectExecutionResult = {
  summary: ClientEffectSummary;
  approval?: ClientApprovalCheckpoint;
  receipt?: ClientEffectReceipt;
  replayed: boolean;
};

export type ActionInvocationStatus = "pending" | "running" | "awaiting-approval" | "cancel-requested" | "succeeded" | "failed" | "cancelled";
export type ActionContextSnapshot = { locale: string; timezone: string };
export type ActionTriggerRecord = {
  triggerRecordId: string;
  requestId: string;
  documentId: string;
  branchId: string;
  revisionId: string;
  nodeId: string;
  eventPort: string;
  eventSchemaHash: string;
  validatedPayload: JsonValue;
  payloadHash: string;
  actorContextRef: string;
  contextSnapshot: ActionContextSnapshot;
  contextSnapshotHash: string;
  recordedAt: string;
  expiresAt: string;
};

export type ActionInvocation = {
  invocationId: string;
  triggerRequestId: string;
  triggerRecordId: string;
  actorContextRef: string;
  documentId: string;
  branchId: string;
  revisionId: string;
  expectedHeadToken: string;
  nodeId: string;
  eventPort: string;
  actionId: string;
  planHash: string;
  eventPayloadHash: string;
  contextSnapshotHash: string;
  statePreconditions: Record<string, string>;
  grantSetVersion: number;
  status: ActionInvocationStatus;
  nextStepId?: string;
  startedAt: string;
  updatedAt: string;
};

export type ActionStepReceipt = {
  receiptId: string;
  invocationId: string;
  stepId: string;
  stepIndex: number;
  stepHash: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  effectRequestId?: string;
  stateTransitionReceiptIds?: string[];
  diagnostic?: Diagnostic;
  recordedAt: string;
  auditRef: string;
};

export type ActionCancellationReceipt = {
  cancellationId: string;
  cancelRequestId: string;
  invocationId: string;
  outcome: "cancel-requested" | "cancelled" | "too-late";
  actionStatus: ActionInvocationStatus;
  recordedAt: string;
};

export type StoredActionInvocation = {
  version: number;
  plan: ActionPlan;
  trigger: ActionTriggerRecord;
  invocation: ActionInvocation;
  receipts: ActionStepReceipt[];
  cancellation?: ActionCancellationReceipt;
};

export interface ActionInvocationStorePort {
  create(record: StoredActionInvocation): Promise<{ status: "created" | "replayed" | "conflict"; record: StoredActionInvocation }>;
  get(invocationId: string): Promise<StoredActionInvocation | undefined>;
  getByTriggerRequest(actorContextRef: string, requestId: string): Promise<StoredActionInvocation | undefined>;
  compareAndSwap(invocationId: string, expectedVersion: number, next: StoredActionInvocation): Promise<boolean>;
  commitLocalStep(input: {
    invocationId: string;
    expectedVersion: number;
    receipt: ActionStepReceipt;
    nextInvocation: ActionInvocation;
  }): Promise<{ status: "committed" | "replayed" | "conflict"; record: StoredActionInvocation }>;
}

export type ActionReducerEvent =
  | { type: "start" }
  | { type: "step-running"; step: ActionStep }
  | { type: "step-succeeded"; step: ActionStep; nextStepId?: string }
  | { type: "step-failed"; step: ActionStep; continueWithStepId?: string }
  | { type: "approval-required"; step: ActionStep }
  | { type: "cancel-requested" }
  | { type: "cancelled" };
