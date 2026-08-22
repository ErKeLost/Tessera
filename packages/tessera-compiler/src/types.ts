import type { ZodType } from "zod";

export type Scalar = null | boolean | string | number;
export type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JSONSchema = JsonObject;

export type ConditionOperator =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "and"
  | "or"
  | "not";

export type PlainAuthoringObject = {
  [key: string]: AuthoringValue;
};

export type AuthoringValue =
  | Scalar
  | AuthoringValue[]
  | PlainAuthoringObject
  | { $ref: "state" | "resource"; id: string; path?: (string | number)[] }
  | { $ref: "event"; port: string; path?: (string | number)[] }
  | { $ref: "context"; key: "locale" | "timezone" }
  | { $condition: { op: ConditionOperator; args: AuthoringValue[] } };

export type AuthoringNode = {
  id: string;
  type: string;
  typeVersion?: number;
  props?: Record<string, AuthoringValue>;
  slots?: Record<string, AuthoringNode[]>;
  events?: Record<string, string>;
  evidence?: string[];
};

export type AuthoringNavigationTarget =
  | {
      kind: "route";
      capabilityId: string;
      routeId: string;
      params?: Record<string, AuthoringValue>;
    }
  | { kind: "resource"; capabilityId: string; resourceId: string }
  | {
      kind: "external";
      capabilityId: string;
      input: Record<string, AuthoringValue>;
    };

export type AuthoringActionStep = { stepId: string } & (
  | { type: "state.set"; stateId: string; value: AuthoringValue }
  | { type: "state.reset"; stateIds: string[] }
  | { type: "node.focus"; nodeId: string }
  | {
      type: "agent.message";
      templateGrantId: string;
      values?: Record<string, AuthoringValue>;
    }
  | {
      type: "capability.request";
      capabilityId: string;
      input: Record<string, AuthoringValue>;
    }
  | { type: "navigation.request"; target: AuthoringNavigationTarget }
);

export type AuthoringActionPlan = {
  contractId: string;
  contractVersion?: number;
  steps: AuthoringActionStep[];
  onError?: "halt" | "continue";
};

export type AuthoringStateDefinition = {
  schema: JSONSchema;
  initial: JsonValue;
};

export type ArtifactMeta = {
  title?: string;
  description?: string;
  locale?: string;
  tags?: string[];
};

export type ArtifactProposal = {
  root: AuthoringNode;
  state?: Record<string, AuthoringStateDefinition>;
  actions?: Record<string, AuthoringActionPlan>;
  claims?: Record<string, JsonValue>;
  resourceIds?: string[];
  meta?: ArtifactMeta;
};

export type PathSegment = string | number;
export type ArtifactValue =
  | { kind: "literal"; value: Scalar }
  | { kind: "array"; items: ArtifactValue[] }
  | { kind: "object"; entries: Record<string, ArtifactValue> }
  | { kind: "state-ref"; stateId: string; path?: PathSegment[] }
  | { kind: "resource-ref"; resourceId: string; path?: PathSegment[] }
  | { kind: "event-ref"; port: string; path?: PathSegment[] }
  | { kind: "context-ref"; key: "locale" | "timezone" }
  | { kind: "condition"; op: ConditionOperator; args: ArtifactValue[] };

export type NormalizedActionStep = { stepId: string } & (
  | { type: "state.set"; stateId: string; value: ArtifactValue }
  | { type: "state.reset"; stateIds: string[] }
  | { type: "node.focus"; nodeId: string }
  | {
      type: "agent.message";
      templateGrantId: string;
      values: Record<string, ArtifactValue>;
    }
  | {
      type: "capability.request";
      capabilityId: string;
      input: Record<string, ArtifactValue>;
    }
  | {
      type: "navigation.request";
      target:
        | {
            kind: "route";
            capabilityId: string;
            routeId: string;
            params: Record<string, ArtifactValue>;
          }
        | { kind: "resource"; capabilityId: string; resourceId: string }
        | {
            kind: "external";
            capabilityId: string;
            input: Record<string, ArtifactValue>;
          };
    }
);

export type NormalizedActionPlan = {
  contractId: string;
  contractVersion: number;
  steps: NormalizedActionStep[];
  onError: "halt" | "continue";
};

export type NormalizedArtifactNode = {
  type: string;
  typeVersion: number;
  props: Record<string, ArtifactValue>;
  slots?: Record<string, string[]>;
  events?: Record<string, string>;
  evidence?: string[];
};

export type NormalizedArtifactProposal = {
  root: string;
  nodes: Record<string, NormalizedArtifactNode>;
  state: Record<string, AuthoringStateDefinition>;
  actions: Record<string, NormalizedActionPlan>;
  claims: Record<string, JsonValue>;
  resourceIds: string[];
  meta: ArtifactMeta;
};

export type PolicySink =
  | "model-generation"
  | "renderer"
  | "model-repair"
  | "export"
  | "share"
  | "telemetry";

export type InformationFlowLabel = {
  scopeRef: string;
  sensitivity: "public" | "private" | "sensitive";
  persistence: "none" | "session" | "host";
  allowedSinks: PolicySink[];
  expiresAt?: string;
};

export type DocumentPolicy = InformationFlowLabel & {
  policyId: string;
  policyVersion: number;
  policyHash: string;
};

export type LabeledModelInput = {
  provenanceRef: string;
  kind:
    | "message"
    | "tool-result"
    | "resource"
    | "state"
    | "parent-summary"
    | "example"
    | "repair";
  content: JsonValue;
  label: InformationFlowLabel;
};

export type DiagnosticPhase =
  | "decode"
  | "normalize"
  | "validate"
  | "policy"
  | "commit"
  | "render"
  | "effect"
  | "transport";

export type Diagnostic = {
  phase: DiagnosticPhase;
  code: string;
  severity: "info" | "warning" | "error" | "fatal";
  recoverable: boolean;
  modelCorrectable: boolean;
  message: string;
  location?: {
    streamId?: string;
    transactionId?: string;
    seq?: number;
    opId?: string;
    revisionId?: string;
    entity?: {
      kind:
        | "document"
        | "node"
        | "state"
        | "action"
        | "resource"
        | "evidence"
        | "claim"
        | "effect"
        | "migration";
      id: string;
    };
    path?: string;
  };
  expected?: JsonValue;
  actualSummary?: string;
  hint?: string;
  retryAfterMs?: number;
};

export type GenerationLimits = {
  maxDocumentBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxStringBytes: number;
  maxCollectionItems: number;
  maxObjectKeys: number;
  maxTotalValues: number;
  maxNodeTypes: number;
  maxExamples: number;
  maxRepairFragmentBytes: number;
  maxRepairAttempts: number;
};

export type SurfaceProfile = "analysis" | "report" | "form" | "operations";
export type CompilerPreset = "standard" | "governed" | "custom";
export type AuthoringCodec = "snapshot-json" | "delta-jsonl";
export type RenderMode = "strict" | "progressive";
export type NodeCategory =
  | "surface-layout"
  | "surface-content"
  | "surface-form"
  | "semantic-artifact"
  | `extension:${string}`;

export type SlotContract = {
  accepts?: readonly string[];
  categories?: readonly NodeCategory[];
  min?: number;
  max?: number;
  fallback: "omit" | "empty" | "placeholder";
};

export type NodePromptMetadata = {
  summary: string;
  useWhen: readonly string[];
  avoidWhen: readonly string[];
};

export type NodeContract = {
  type: string;
  version: number;
  category: NodeCategory;
  propsSchema: ZodType<Record<string, unknown>>;
  providerSchema?: JSONSchema;
  slots: Readonly<Record<string, SlotContract>>;
  trust: "safe" | "governed";
  commitPolicy: "progressive" | "atomic";
  prompt: NodePromptMetadata;
  profiles: readonly SurfaceProfile[];
  searchTerms?: readonly string[];
  dependencies?: readonly string[];
  examples?: readonly CompilerExample[];
  maxInstances?: number;
  events?: Readonly<
    Record<
      string,
      {
        payloadSchema: ZodType<unknown>;
        actionContracts: Readonly<Record<string, string>>;
      }
    >
  >;
  bindings?: {
    referencePaths?: readonly string[];
    conditionPaths?: readonly string[];
  };
};

export type CompilerExample = {
  id: string;
  profiles: readonly SurfaceProfile[];
  nodeTypes: readonly string[];
  user: string;
  proposal: ArtifactProposal;
};

export type CatalogIdentity = {
  id: string;
  version: string;
};

export type CatalogSlice = {
  catalog: CatalogIdentity;
  contractFingerprint: string;
  sliceHash: string;
  contracts: readonly NodeContract[];
};

export type SchemaProfileBinding = {
  profileId: "data-elements.schema-core";
  profileVersion: number;
  profileHash: string;
};

export type ModelVisibleCapability = {
  capabilityId: string;
  grantVersion: number;
  schemaProfile: SchemaProfileBinding;
  kind: string;
  summary: string;
  inputSchemaId: string;
  inputSchemaVersion: number;
  inputSchema: JSONSchema;
  inputSchemaHash: string;
  outputSchemaId: string;
  outputSchemaVersion: number;
  outputSchemaHash: string;
  requiresApproval: boolean;
};

export type ModelVisibleMessageTemplate = {
  templateGrantId: string;
  templateGrantVersion: number;
  schemaProfile: SchemaProfileBinding;
  summary: string;
  templateHash: string;
  variableSchema: JSONSchema;
  variableSchemaHash: string;
};

export type DocumentSummary = {
  documentId: string;
  revisionId: string;
  title?: string;
  summary: string;
};

export type PromptBundle = {
  protocolVersion: "2.0";
  system: string;
  providerSchema: JSONSchema;
  tool: {
    name: "renderArtifact";
    description: string;
    inputSchema: JSONSchema;
  };
  catalogSlice: CatalogSlice;
  contractFingerprint: string;
  promptBundleHash: string;
  generationTaintHash: string;
  profile: SurfaceProfile;
  preset: CompilerPreset;
  codec: AuthoringCodec;
  renderMode: RenderMode;
  locale: string;
  limits: GenerationLimits;
  examples: readonly CompilerExample[];
  repair: {
    maxAttempts: number;
    redactedFields: readonly string[];
  };
};

export type RepairDiagnostic = Pick<
  Diagnostic,
  "phase" | "code" | "severity" | "message"
> & {
  path?: string;
  hint?: string;
};

export type RepairRequest = {
  attempt: number;
  maxAttempts: number;
  contractFingerprint: string;
  promptBundleHash: string;
  system: string;
  providerSchema: JSONSchema;
  parentRevisionId?: string;
  headPreconditions?: Readonly<Record<string, string>>;
  statePreconditions?: Readonly<Record<string, string>>;
  allowedOperations: readonly ["replace-snapshot"];
  diagnostics: readonly RepairDiagnostic[];
  fragment: JsonValue;
  prompt: string;
};

export type MaybePromise<T> = T | Promise<T>;

export interface ArtifactTransportAdapter<TProviderOutput, TResponse = ArtifactPart> {
  readonly id: string;
  extractProposal(
    output: TProviderOutput,
    context: AdapterContext,
  ): MaybePromise<unknown>;
  encodePart?(
    part: ArtifactPart,
    context: AdapterContext,
  ): MaybePromise<TResponse>;
}

export interface RepairProvider {
  readonly id: string;
  repair(request: RepairRequest): MaybePromise<unknown>;
}

export type AdapterContext = {
  protocolVersion: "2.0";
  contractFingerprint: string;
  promptBundleHash: string;
  generationTaintHash: string;
  codec: AuthoringCodec;
  renderMode: RenderMode;
};

declare const validatedArtifactPart: unique symbol;

export type ArtifactPart<TSnapshot = NormalizedArtifactProposal> = {
  readonly kind: "artifact-snapshot";
  readonly snapshot: TSnapshot;
  readonly contractFingerprint: string;
  readonly promptBundleHash: string;
  readonly generationTaintHash: string;
  readonly [validatedArtifactPart]: true;
};
