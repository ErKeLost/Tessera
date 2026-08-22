import { assertJsonValue } from "./canonical";
import { CompilerCatalog, defaultCompilerCatalog } from "./catalog";
import { compilerDiagnostic, CompilerDiagnosticError } from "./diagnostics";
import {
  createDocumentPolicy,
  DEFAULT_DOCUMENT_POLICY,
  prepareInformationFlow,
} from "./information-flow";
import { normalizeSurface } from "./normalize";
import { createValidatedArtifactPart, isArtifactPart } from "./part";
import { compilePrompt } from "./prompt";
import { runBoundedRepair } from "./repair";
import type {
  AdapterContext,
  ArtifactPart,
  ArtifactTransportAdapter,
  AuthoringCodec,
  CompilerPreset,
  DocumentPolicy,
  DocumentSummary,
  GenerationLimits,
  InformationFlowLabel,
  JsonValue,
  LabeledModelInput,
  ModelVisibleCapability,
  ModelVisibleMessageTemplate,
  PromptBundle,
  RenderMode,
  RepairProvider,
  SurfaceProfile,
} from "./types";

export type TurnMessage = {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: JsonValue;
  provenanceRef?: string;
  label?: InformationFlowLabel;
};

export type LabeledDocumentSummary = {
  value: DocumentSummary;
  provenanceRef: string;
  label: InformationFlowLabel;
};

export type PrepareTurnInput<TMessage extends TurnMessage = TurnMessage> = {
  messages: readonly TMessage[];
  profile?: SurfaceProfile;
  preset?: CompilerPreset;
  catalog?: CompilerCatalog;
  documentPolicy?: DocumentPolicy;
  modelInputs?: readonly LabeledModelInput[];
  requestedNodeTypes?: readonly string[];
  task?: string;
  codec?: AuthoringCodec;
  renderMode?: RenderMode;
  capabilityDescriptors?: readonly ModelVisibleCapability[];
  messageTemplateDescriptors?: readonly ModelVisibleMessageTemplate[];
  parentDocumentSummaries?: readonly LabeledDocumentSummary[];
  resourceIds?: readonly string[];
  locale?: string;
  limits?: Partial<GenerationLimits>;
};

export type AcceptArtifactOptions = {
  repairProvider?: RepairProvider;
  parentRevisionId?: string;
  headPreconditions?: Readonly<Record<string, string>>;
  statePreconditions?: Readonly<Record<string, string>>;
};

export type PreparedTurn<TMessage extends TurnMessage = TurnMessage> = {
  readonly system: string;
  readonly messages: readonly TMessage[];
  readonly modelInputs: readonly LabeledModelInput[];
  readonly tools: Readonly<{ renderArtifact: PromptBundle["tool"] }>;
  readonly providerSchema: PromptBundle["providerSchema"];
  readonly bundle: Readonly<PromptBundle>;
  readonly context: Readonly<AdapterContext>;
  accept<TProviderOutput>(
    output: TProviderOutput,
    adapter: ArtifactTransportAdapter<TProviderOutput, unknown>,
    options?: AcceptArtifactOptions,
  ): Promise<ArtifactPart>;
  respond<TResponse>(
    part: ArtifactPart,
    adapter: ArtifactTransportAdapter<unknown, TResponse>,
  ): Promise<TResponse>;
};

function labelFromPolicy(policy: DocumentPolicy): InformationFlowLabel {
  return {
    scopeRef: policy.scopeRef,
    sensitivity: policy.sensitivity,
    persistence: policy.persistence,
    allowedSinks: [...policy.allowedSinks],
    ...(policy.expiresAt ? { expiresAt: policy.expiresAt } : {}),
  };
}

function messageInput(
  message: TurnMessage,
  index: number,
  defaultLabel: InformationFlowLabel,
): LabeledModelInput {
  try {
    assertJsonValue(message.content, `/messages/${index}/content`);
  } catch {
    throw new CompilerDiagnosticError([compilerDiagnostic({
      phase: "decode",
      code: "message.non_json_content",
      message: "Provider-neutral messages must contain JSON-compatible content.",
      path: `/messages/${index}/content`,
      recoverable: false,
      modelCorrectable: false,
    })]);
  }
  return {
    provenanceRef: message.provenanceRef ?? `message:${index}`,
    kind: "message",
    content: { role: message.role, content: message.content },
    label: message.label ?? defaultLabel,
  };
}

function descriptorInput(
  id: string,
  kind: LabeledModelInput["kind"],
  content: unknown,
  label: InformationFlowLabel,
): LabeledModelInput {
  assertJsonValue(content);
  return { provenanceRef: id, kind, content, label };
}

function taskText(messages: readonly TurnMessage[], explicit?: string): string {
  if (explicit) return explicit.slice(0, 32_000);
  let output = "";
  const collect = (value: JsonValue): void => {
    if (output.length >= 32_000) return;
    if (typeof value === "string") {
      output += ` ${value}`;
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  };
  messages.forEach(({ content }) => collect(content));
  return output.slice(0, 32_000);
}

function transportFailure(): CompilerDiagnosticError {
  return new CompilerDiagnosticError([compilerDiagnostic({
    phase: "transport",
    code: "adapter.extraction_failed",
    message: "The provider adapter did not produce an artifact proposal.",
    recoverable: true,
    modelCorrectable: false,
  })]);
}

export async function prepareTurn<TMessage extends TurnMessage>(
  input: PrepareTurnInput<TMessage>,
): Promise<PreparedTurn<TMessage>> {
  const catalog = input.catalog ?? defaultCompilerCatalog;
  const policy = input.documentPolicy ?? DEFAULT_DOCUMENT_POLICY;
  const defaultLabel = labelFromPolicy(policy);
  const messageInputs = input.messages.map((message, index) => messageInput(message, index, defaultLabel));
  const capabilities = [...(input.capabilityDescriptors ?? [])];
  const templates = [...(input.messageTemplateDescriptors ?? [])];
  const summaries = [...(input.parentDocumentSummaries ?? [])];
  const descriptorInputs = [
    ...capabilities.map((descriptor) => descriptorInput(
      `capability:${descriptor.capabilityId}@${descriptor.grantVersion}`,
      "tool-result",
      descriptor,
      defaultLabel,
    )),
    ...templates.map((descriptor) => descriptorInput(
      `message-template:${descriptor.templateGrantId}@${descriptor.templateGrantVersion}`,
      "tool-result",
      descriptor,
      defaultLabel,
    )),
    ...summaries.map(({ value, provenanceRef, label }) => descriptorInput(
      provenanceRef,
      "parent-summary",
      value,
      label,
    )),
  ];
  const baseInputs = [...messageInputs, ...(input.modelInputs ?? []), ...descriptorInputs];
  const baseFlow = prepareInformationFlow(baseInputs, policy);
  const includedMessageRefs = new Set(baseFlow.included
    .filter(({ kind }) => kind === "message")
    .map(({ provenanceRef }) => provenanceRef));
  const messages = input.messages.filter((message, index) => includedMessageRefs.has(
    message.provenanceRef ?? `message:${index}`,
  ));
  const authorizedSummaries = summaries.filter(({ provenanceRef }) => baseFlow.included.some(
    (modelInput) => modelInput.provenanceRef === provenanceRef,
  )).map(({ value }) => value);

  const compile = (generationTaintHash: string) => compilePrompt({
    catalog,
    preset: input.preset,
    profile: input.profile,
    documentPolicy: policy,
    generationTaintHash,
    requestedNodeTypes: input.requestedNodeTypes,
    task: taskText(messages, input.task),
    codec: input.codec,
    renderMode: input.renderMode,
    capabilityDescriptors: capabilities,
    messageTemplateDescriptors: templates,
    locale: input.locale,
    limits: input.limits,
    parentDocumentSummaries: authorizedSummaries,
  });

  const preliminary = compile(baseFlow.generationTaintHash);
  const exampleInputs = preliminary.examples.map((example) => descriptorInput(
    `compiler-example:${preliminary.catalogSlice.sliceHash}:${example.id}`,
    "example",
    example as unknown as JsonValue,
    defaultLabel,
  ));
  const flow = prepareInformationFlow([...baseInputs, ...exampleInputs], policy);
  const bundle = compile(flow.generationTaintHash);
  const context: AdapterContext = Object.freeze({
    protocolVersion: "2.0",
    contractFingerprint: bundle.contractFingerprint,
    promptBundleHash: bundle.promptBundleHash,
    generationTaintHash: bundle.generationTaintHash,
    codec: bundle.codec,
    renderMode: bundle.renderMode,
  });
  const resourceIds = [...new Set(input.resourceIds ?? [])];
  const capabilityIds = capabilities.map(({ capabilityId }) => capabilityId);
  const messageTemplateIds = templates.map(({ templateGrantId }) => templateGrantId);

  const turn: PreparedTurn<TMessage> = {
    system: bundle.system,
    messages: Object.freeze([...messages]),
    modelInputs: Object.freeze([...flow.included]),
    tools: Object.freeze({ renderArtifact: bundle.tool }),
    providerSchema: bundle.providerSchema,
    bundle,
    context,
    async accept<TProviderOutput>(
      output: TProviderOutput,
      adapter: ArtifactTransportAdapter<TProviderOutput, unknown>,
      options: AcceptArtifactOptions = {},
    ): Promise<ArtifactPart> {
      if (!adapter.id.trim()) throw transportFailure();
      let proposal: unknown;
      try {
        proposal = await adapter.extractProposal(output, context);
      } catch {
        throw transportFailure();
      }
      if (proposal === undefined) throw transportFailure();
      const snapshot = await runBoundedRepair({
        initialValue: proposal,
        bundle,
        informationFlow: flow.joinedLabel,
        provider: options.repairProvider,
        parentRevisionId: options.parentRevisionId,
        headPreconditions: options.headPreconditions,
        statePreconditions: options.statePreconditions,
        validate: (candidate) => normalizeSurface(candidate, {
          catalog: bundle.catalogSlice,
          limits: bundle.limits,
          allowedResourceIds: resourceIds,
          capabilityIds,
          messageTemplateIds,
        }),
      });
      return createValidatedArtifactPart(snapshot, context);
    },
    async respond<TResponse>(
      part: ArtifactPart,
      adapter: ArtifactTransportAdapter<unknown, TResponse>,
    ): Promise<TResponse> {
      if (!isArtifactPart(part) || !adapter.encodePart) {
        throw new CompilerDiagnosticError([compilerDiagnostic({
          phase: "transport",
          code: "adapter.invalid_artifact_part",
          message: "The transport can encode only a locally validated ArtifactPart.",
          severity: "fatal",
          recoverable: false,
          modelCorrectable: false,
        })]);
      }
      try {
        return await adapter.encodePart(part, context);
      } catch {
        throw new CompilerDiagnosticError([compilerDiagnostic({
          phase: "transport",
          code: "adapter.encoding_failed",
          message: "The provider adapter failed to encode the validated ArtifactPart.",
          recoverable: true,
          modelCorrectable: false,
        })]);
      }
    },
  };
  return Object.freeze(turn);
}

export type ArtifactCompilerOptions = {
  catalog?: CompilerCatalog;
  preset?: CompilerPreset;
  documentPolicy?: DocumentPolicy;
  codec?: AuthoringCodec;
  renderMode?: RenderMode;
  limits?: Partial<GenerationLimits>;
};

export function createArtifactCompiler(options: ArtifactCompilerOptions = {}) {
  const catalog = options.catalog ?? defaultCompilerCatalog;
  const policy = options.documentPolicy ?? DEFAULT_DOCUMENT_POLICY;
  return Object.freeze({
    catalog,
    prepareTurn<TMessage extends TurnMessage>(input: PrepareTurnInput<TMessage>) {
      return prepareTurn({
        ...input,
        catalog: input.catalog ?? catalog,
        preset: input.preset ?? options.preset,
        documentPolicy: input.documentPolicy ?? policy,
        codec: input.codec ?? options.codec,
        renderMode: input.renderMode ?? options.renderMode,
        limits: { ...options.limits, ...input.limits },
      });
    },
  });
}

export { createDocumentPolicy };
