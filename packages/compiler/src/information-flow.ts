import { deepFreeze, hashJson } from "./canonical";
import { compilerDiagnostic, CompilerDiagnosticError } from "./diagnostics";
import type {
  DocumentPolicy,
  InformationFlowLabel,
  JsonValue,
  LabeledModelInput,
  PolicySink,
} from "./types";

const sensitivityRank = { public: 0, private: 1, sensitive: 2 } as const;
const persistenceStrictness = { host: 0, session: 1, none: 2 } as const;
const sinkOrder: readonly PolicySink[] = [
  "model-generation",
  "renderer",
  "model-repair",
  "export",
  "share",
  "telemetry",
];

export type DocumentPolicyInput = InformationFlowLabel & {
  policyId: string;
  policyVersion?: number;
};

function staticPolicyProjection(
  policy: Omit<DocumentPolicy, "policyHash"> | DocumentPolicyInput,
): JsonValue {
  return {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion ?? 1,
    scopeRef: policy.scopeRef,
    sensitivity: policy.sensitivity,
    persistence: policy.persistence,
    allowedSinks: [...new Set(policy.allowedSinks)].sort(
      (left, right) => sinkOrder.indexOf(left) - sinkOrder.indexOf(right),
    ),
    ...(policy.expiresAt ? { expiresAt: policy.expiresAt } : {}),
  };
}

export function computeDocumentPolicyHash(
  policy: Omit<DocumentPolicy, "policyHash"> | DocumentPolicyInput,
): string {
  return hashJson(staticPolicyProjection(policy));
}

export function createDocumentPolicy(input: DocumentPolicyInput): Readonly<DocumentPolicy> {
  validateLabel(input, "/documentPolicy");
  const policy: DocumentPolicy = {
    ...input,
    policyVersion: input.policyVersion ?? 1,
    allowedSinks: [...new Set(input.allowedSinks)].sort(
      (left, right) => sinkOrder.indexOf(left) - sinkOrder.indexOf(right),
    ),
    policyHash: computeDocumentPolicyHash(input),
  };
  return deepFreeze(policy);
}

export const DEFAULT_DOCUMENT_POLICY = createDocumentPolicy({
  policyId: "data-elements.public-session",
  policyVersion: 1,
  scopeRef: "public",
  sensitivity: "public",
  persistence: "session",
  allowedSinks: ["model-generation", "renderer", "model-repair"],
});

function validateLabel(label: InformationFlowLabel, path: string): void {
  if (!label.scopeRef.trim()) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.empty_scope",
      message: "An information-flow label needs a scope reference.",
      path: `${path}/scopeRef`,
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  if (!sinkOrder.includes(label.allowedSinks[0]!) && label.allowedSinks.length > 0) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.invalid_sink",
      message: "An information-flow label contains an unknown sink.",
      path: `${path}/allowedSinks`,
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  if (label.allowedSinks.some((sink) => !sinkOrder.includes(sink))) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.invalid_sink",
      message: "An information-flow label contains an unknown sink.",
      path: `${path}/allowedSinks`,
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  if (label.expiresAt !== undefined && !Number.isFinite(Date.parse(label.expiresAt))) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.invalid_expiry",
      message: "Information-flow expiry must be an ISO date-time.",
      path: `${path}/expiresAt`,
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
}

function earliestExpiry(labels: readonly InformationFlowLabel[]): string | undefined {
  const expiries = labels.flatMap(({ expiresAt }) => expiresAt ? [expiresAt] : []);
  return expiries.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

export function joinInformationFlow(
  labels: readonly InformationFlowLabel[],
): Readonly<InformationFlowLabel> {
  if (labels.length === 0) return DEFAULT_DOCUMENT_POLICY;
  labels.forEach((label, index) => validateLabel(label, `/modelInputs/${index}/label`));
  const scopes = [...new Set(labels.map(({ scopeRef }) => scopeRef))];
  if (scopes.length !== 1) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.empty_scope_intersection",
      message: "The model inputs do not share an authorized scope.",
      path: "/modelInputs",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  const allowedSinks = sinkOrder.filter((sink) => labels.every(
    (label) => label.allowedSinks.includes(sink),
  ));
  if (allowedSinks.length === 0) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "information_flow.empty_sink_intersection",
      message: "The model inputs do not share an allowed information sink.",
      path: "/modelInputs",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  const sensitivity = labels.reduce<InformationFlowLabel["sensitivity"]>(
    (current, label) => sensitivityRank[label.sensitivity] > sensitivityRank[current]
      ? label.sensitivity
      : current,
    "public",
  );
  const persistence = labels.reduce<InformationFlowLabel["persistence"]>(
    (current, label) => persistenceStrictness[label.persistence] > persistenceStrictness[current]
      ? label.persistence
      : current,
    "host",
  );
  const expiresAt = earliestExpiry(labels);
  return deepFreeze({
    scopeRef: scopes[0]!,
    sensitivity,
    persistence,
    allowedSinks,
    ...(expiresAt ? { expiresAt } : {}),
  });
}

function assertPolicyCanContain(
  policy: DocumentPolicy,
  joined: InformationFlowLabel,
): void {
  if (policy.policyHash !== computeDocumentPolicyHash(policy)) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "document_policy.hash_mismatch",
      message: "The document policy hash does not match its static policy fields.",
      path: "/documentPolicy/policyHash",
      severity: "fatal",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  const expiryTooWide = joined.expiresAt !== undefined
    && (policy.expiresAt === undefined || Date.parse(policy.expiresAt) > Date.parse(joined.expiresAt));
  const invalid = policy.scopeRef !== joined.scopeRef
    || sensitivityRank[policy.sensitivity] < sensitivityRank[joined.sensitivity]
    || persistenceStrictness[policy.persistence] < persistenceStrictness[joined.persistence]
    || policy.allowedSinks.some((sink) => !joined.allowedSinks.includes(sink))
    || expiryTooWide;
  if (invalid) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "document_policy.weaker_than_inputs",
      message: "The document policy is less restrictive than the joined model inputs.",
      path: "/documentPolicy",
      severity: "fatal",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  if (!policy.allowedSinks.includes("model-generation")) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "document_policy.model_generation_denied",
      message: "The document policy does not allow model generation.",
      path: "/documentPolicy/allowedSinks",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  if (policy.expiresAt && Date.parse(policy.expiresAt) <= Date.now()) {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "policy",
      code: "document_policy.expired",
      message: "The document policy has expired.",
      path: "/documentPolicy/expiresAt",
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
}

export type PreparedInformationFlow = {
  included: readonly LabeledModelInput[];
  excluded: readonly LabeledModelInput[];
  joinedLabel: Readonly<InformationFlowLabel>;
  generationTaintHash: string;
};

export function prepareInformationFlow(
  inputs: readonly LabeledModelInput[],
  documentPolicy: DocumentPolicy,
): Readonly<PreparedInformationFlow> {
  const provenance = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    if (!input.provenanceRef.trim() || provenance.has(input.provenanceRef)) {
      throw new CompilerDiagnosticError([compilerDiagnostic({
        phase: "policy",
        code: "information_flow.invalid_provenance",
        message: "Every labeled model input needs a unique provenance reference.",
        path: `/modelInputs/${index}/provenanceRef`,
        recoverable: false,
        modelCorrectable: false,
      })]);
    }
    provenance.add(input.provenanceRef);
    validateLabel(input.label, `/modelInputs/${index}/label`);
  }
  const included = inputs.filter(({ label }) => label.allowedSinks.includes("model-generation"));
  const excluded = inputs.filter(({ label }) => !label.allowedSinks.includes("model-generation"));
  const joinedLabel = included.length
    ? joinInformationFlow(included.map(({ label }) => label))
    : documentPolicy;
  assertPolicyCanContain(documentPolicy, joinedLabel);
  const generationTaintHash = hashJson(included
    .map((input) => ({
      provenanceRef: input.provenanceRef,
      kind: input.kind,
      content: input.content,
      label: input.label,
    }))
    .sort((left, right) => left.provenanceRef.localeCompare(right.provenanceRef)) as JsonValue);
  return Object.freeze({
    included: Object.freeze([...included]),
    excluded: Object.freeze([...excluded]),
    joinedLabel,
    generationTaintHash,
  });
}
