import type {
  ActionContract,
  CatalogSetSlice,
  ComponentContract,
} from "@open-generative/catalog";
import type {
  ActionContractRef,
  ActionId,
  ActorAuditRef,
  BranchId,
  CanonicalEntityRef,
  CanonicalOperationEnvelope,
  ClaimId,
  CommitCommandEnvelope,
  CorrelationId,
  DocumentContent,
  DocumentId,
  EntityRevisionId,
  EvidenceBinding,
  EvidenceId,
  HashProvider,
  HeadToken,
  JSONSchema,
  MigrationReceiptId,
  NodeId,
  OfferedEvidenceRef,
  OfferedResourceBindingRef,
  OperationId,
  AuthoringSnapshotProposal,
  ProposalOperationEnvelope,
  ProposalEntityKind,
  ProposalLocalId,
  ResourceBindingDeclaration,
  ResourceBindingId,
  RevisionId,
  Sha256Hash,
  StateId,
  SurfaceSessionId,
  TransactionId,
  TransactionIdentityMap,
  TransactionIdentityMapDelta,
  ValidatedPreview,
} from "@open-generative/protocol";
import type {
  AbortTransactionResult,
  ApplyOperationResult,
  BeginTransactionInput,
  BeginTransactionResult,
  EntityRevisionIndex,
  FinalizeTransactionInput,
  FinalizeTransactionResult,
} from "@open-generative/runtime";

export type MaybePromise<T> = T | Promise<T>;

export type FlowClassification = "public" | "internal" | "confidential" | "restricted";

export type CompilerCatalogInput = {
  slice: CatalogSetSlice;
  components: readonly ComponentContract[];
  actions: readonly ActionContract[];
  hashProvider?: HashProvider;
};

export type ProviderSchemaLoweringProfile = Readonly<{
  id: string;
  lower(schema: JSONSchema): JSONSchema;
}>;

export type StatePolicyDecision =
  | {
    scope: "surface";
    persistence: "none" | "session";
    sensitivity: "public" | "private" | "sensitive";
    modelVisibility: "none" | "descriptor" | "value";
    retention: "retain" | "reset-on-commit" | "prune-when-unreferenced";
    classification: FlowClassification;
  }
  | {
    scope: "document";
    persistence: "host";
    sensitivity: "public" | "private" | "sensitive";
    modelVisibility: "none" | "descriptor" | "value";
    retention: "retain" | "reset-on-commit" | "prune-when-unreferenced";
    classification: FlowClassification;
  };

export interface StatePolicyPort {
  decide(input: {
    transactionId: TransactionId;
    stateId: StateId;
    proposalLocalId?: ProposalLocalId<"state">;
    schema: JSONSchema;
    initial: unknown;
  }): MaybePromise<StatePolicyDecision>;
}

export type AuthorizedActionOffer = Readonly<{
  contract: ActionContractRef;
  maxInputClassification?: FlowClassification;
}>;

export type AuthorizedResourceOffer = Readonly<{
  source: OfferedResourceBindingRef;
  declaration: ResourceBindingDeclaration;
  classification: FlowClassification;
  existingBindingIds?: readonly ResourceBindingId[];
}>;

export type AuthorizedEvidenceOffer = Readonly<{
  source: OfferedEvidenceRef;
  binding: EvidenceBinding;
  classification: FlowClassification;
  existingEvidenceIds?: readonly EvidenceId[];
}>;

export type InformationFlowPolicy = Readonly<{
  maxDocumentClassification: FlowClassification;
  componentSinks?: readonly Readonly<{
    contract: ComponentContract["ref"];
    maxClassification: FlowClassification;
  }>[];
  actionSinks?: readonly Readonly<{
    contract: ActionContractRef;
    maxClassification: FlowClassification;
  }>[];
}>;

export type CompilerAuthority = Readonly<{
  actions: readonly AuthorizedActionOffer[];
  resources: readonly AuthorizedResourceOffer[];
  evidence: readonly AuthorizedEvidenceOffer[];
  statePolicy: StatePolicyPort;
  informationFlow: InformationFlowPolicy;
}>;

export type CompilerEntityReadScope = Readonly<{
  node: readonly NodeId[];
  state: readonly StateId[];
  action: readonly ActionId[];
  resource: readonly ResourceBindingId[];
  evidence: readonly EvidenceId[];
  claim: readonly ClaimId[];
}>;

export type CompilerEntityWriteScope = Readonly<{
  node: Readonly<Record<string, EntityRevisionId>>;
  state: Readonly<Record<string, EntityRevisionId>>;
  action: Readonly<Record<string, EntityRevisionId>>;
  resource: Readonly<Record<string, EntityRevisionId>>;
  evidence: Readonly<Record<string, EntityRevisionId>>;
  claim: Readonly<Record<string, EntityRevisionId>>;
}>;

export type CompilerWriteScope = Readonly<{
  creatable: readonly ProposalEntityKind[];
  readable: CompilerEntityReadScope;
  writable: CompilerEntityWriteScope;
  root?: Readonly<{ expectedRootId: NodeId }>;
  meta?: Readonly<{ expectedMetaHash: Sha256Hash }>;
}>;

export type IdentityAllocationRequest = Readonly<{
  kind: ProposalEntityKind;
  localId: string;
}>;

export type IdentityAllocationBatch = Readonly<{
  identityMap: TransactionIdentityMap;
  identityMapDelta: TransactionIdentityMapDelta;
}>;

export interface TransactionIdentityAllocatorPort {
  claim(input: {
    transactionId: TransactionId;
    operationId: OperationId;
    entities: readonly IdentityAllocationRequest[];
  }): MaybePromise<IdentityAllocationBatch>;
  retire?(transactionId: TransactionId): MaybePromise<void>;
}

export type NormalizedCompilerOperation = Readonly<{
  envelope: CanonicalOperationEnvelope;
  identityMapDelta: TransactionIdentityMapDelta;
}>;

export type NormalizedCompilerProposal = Readonly<{
  operations: readonly NormalizedCompilerOperation[];
  document: DocumentContent;
  entityRevisions: EntityRevisionIndex;
  finalOperationSequence: number;
  contentHash: Sha256Hash;
}>;

export type DecodedAuthoringProposal =
  | Readonly<{ kind: "snapshot"; proposal: AuthoringSnapshotProposal }>
  | Readonly<{ kind: "operations"; operations: readonly ProposalOperationEnvelope[] }>
  | Readonly<{ kind: "abort"; reason: "provider-abort" | "decoder-failure" | "timeout" | "cancelled" }>;

export type ProposalNormalizerInput = Readonly<{
  catalog: CompilerCatalogLike;
  authority: CompilerAuthority;
  transactionId: TransactionId;
  baseDocument: DocumentContent;
  baseEntityRevisions: EntityRevisionIndex;
  writeScope: CompilerWriteScope;
  identityAllocator: TransactionIdentityAllocatorPort;
  hashProvider?: HashProvider;
}>;

export interface CompilerCatalogLike {
  readonly slice: CatalogSetSlice;
  readonly components: readonly ComponentContract[];
  readonly actions: readonly ActionContract[];
  componentBySliceId(id: string): ComponentContract | undefined;
  componentByRef(ref: ComponentContract["ref"]): ComponentContract | undefined;
  actionBySliceId(id: string): ActionContract | undefined;
  actionByRef(ref: ActionContractRef): ActionContract | undefined;
  authoringPropsSchema(contract: ComponentContract["ref"]): JSONSchema;
}

export interface RuntimeCommitPort {
  begin(input: BeginTransactionInput): Promise<BeginTransactionResult>;
  apply(
    envelope: CanonicalOperationEnvelope,
    identityMapDelta?: TransactionIdentityMapDelta,
  ): Promise<ApplyOperationResult>;
  finalize(input: FinalizeTransactionInput): Promise<FinalizeTransactionResult>;
  abort(transactionId: TransactionId, code?: string): Promise<AbortTransactionResult>;
}

export type CompilerTurnInput = Readonly<{
  catalog: CompilerCatalogLike;
  authority: CompilerAuthority;
  runtime: RuntimeCommitPort;
  identityAllocator: TransactionIdentityAllocatorPort;
  baseDocument: DocumentContent;
  baseEntityRevisions: EntityRevisionIndex;
  writeScope: CompilerWriteScope;
  begin: BeginTransactionInput;
  authorityContextHash: Sha256Hash;
  writeScopeHash: Sha256Hash;
  correlationId: CorrelationId;
  hashProvider?: HashProvider;
  onCommitCommand?: (command: CommitCommandEnvelope) => MaybePromise<void>;
  onPreview?: (preview: ValidatedPreview) => MaybePromise<void>;
}>;

export type CompilerTurnOutcome =
  | Readonly<{
    status: "committed";
    revisionId: RevisionId;
    contentHash: Sha256Hash;
    commands: readonly CommitCommandEnvelope[];
  }>
  | Readonly<{
    status: "aborted" | "rejected" | "conflict";
    commands: readonly CommitCommandEnvelope[];
    diagnostics: readonly import("@open-generative/protocol").Diagnostic[];
  }>;

export type CommitBeginContext = Readonly<{
  transactionId: TransactionId;
  surfaceSessionId: SurfaceSessionId;
  documentId: DocumentId;
  branchId: BranchId;
  baseRevisionId: RevisionId;
  expectedHeadToken: HeadToken;
  targetRevisionId: RevisionId;
  nextHeadToken: HeadToken;
  createdAt: string;
  createdBy: ActorAuditRef;
  migrationReceiptIds?: readonly MigrationReceiptId[];
}>;

export type CanonicalRefForKind<TKind extends ProposalEntityKind> = Extract<
  CanonicalEntityRef,
  { kind: TKind }
>;
