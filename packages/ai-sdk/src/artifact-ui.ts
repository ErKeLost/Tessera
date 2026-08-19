import {
  DEFAULT_DOCUMENT_POLICY,
  commitValidatedArtifactProposal,
  createArtifactCompiler,
  defaultArtifactIdFactory,
  diagnosticsFromUnknown,
  mergeArtifactCommitHostContext,
  toArtifactPartWire,
  type ArtifactCommitHostContext,
  type ArtifactCommitIdKind,
  type ArtifactCommitOptions,
  type ArtifactCompilerOptions,
  type PrepareTurnInput as CompilerPrepareTurnInput,
  type RepairProvider,
  type TurnMessage,
} from "@data-elements/compiler";
import {
  decodeArtifactPart,
  type ArtifactPart,
  type ArtifactPartWire,
} from "@data-elements/runtime";
import {
  createUIMessageStreamResponse,
  jsonSchema,
  type Tool,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOptions,
} from "ai";

const RENDER_TOOL_NAME = "renderArtifact";

export type ArtifactUIDataPart = {
  type: "data-artifact";
  id?: string;
  data: {
    artifactProtocol: "2.0";
    contractFingerprint: string;
    part: ArtifactPartWire;
  };
};

export type ArtifactUIIdKind = ArtifactCommitIdKind;

export type ArtifactUIHostContext = ArtifactCommitHostContext;

export type ArtifactUIOptions = ArtifactCompilerOptions & ArtifactCommitOptions;

export type PrepareArtifactUITurnInput<TMessage extends TurnMessage = TurnMessage> =
  Omit<CompilerPrepareTurnInput<TMessage>, "resourceIds"> & ArtifactUIHostContext & {
    repairProvider?: RepairProvider;
  };

export type ArtifactUIStreamResult = {
  toUIMessageStream(options?: UIMessageStreamOptions<UIMessage>): ReadableStream<UIMessageChunk>;
};

export type ArtifactUIResponseOptions = UIMessageStreamOptions<UIMessage> & ResponseInit & {
  onArtifactError?: (error: unknown) => string;
};

export type PreparedArtifactUITurn<TMessage extends TurnMessage = TurnMessage> = {
  readonly system: string;
  readonly messages: readonly TMessage[];
  readonly tools: Readonly<Record<typeof RENDER_TOOL_NAME, Tool<unknown, ArtifactPartWire>>>;
  readonly bundle: Awaited<ReturnType<ReturnType<typeof createArtifactCompiler>["prepareTurn"]>>["bundle"];
  readonly contractFingerprint: string;
  accept(output: unknown): Promise<ArtifactPart>;
  toUIMessageStreamResponse(result: ArtifactUIStreamResult, options?: ArtifactUIResponseOptions): Response;
};

export function createArtifactUI(options: ArtifactUIOptions = {}) {
  const compiler = createArtifactCompiler(options);

  return Object.freeze({
    async prepareTurn<TMessage extends TurnMessage>(
      input: PrepareArtifactUITurnInput<TMessage>,
    ): Promise<PreparedArtifactUITurn<TMessage>> {
      const host = mergeArtifactCommitHostContext(options, input);
      const compilerTurn = await compiler.prepareTurn({
        ...input,
        resourceIds: Object.keys(host.resources),
      });
      const policy = input.documentPolicy ?? options.documentPolicy ?? DEFAULT_DOCUMENT_POLICY;

      const accept = async (output: unknown): Promise<ArtifactPart> => {
        const proposalPart = await compilerTurn.accept(output, {
          id: "data-elements.ai-sdk",
          extractProposal: (value) => value,
        }, {
          repairProvider: input.repairProvider,
        });
        return commitValidatedArtifactProposal(proposalPart, compilerTurn.bundle, {
          documentPolicy: policy,
          ...host,
          now: options.now,
          idFactory: options.idFactory,
          stateDefinition: options.stateDefinition,
        });
      };

      const renderArtifact: Tool<unknown, ArtifactPartWire> = {
        description: compilerTurn.bundle.tool.description,
        inputSchema: jsonSchema(compilerTurn.providerSchema),
        execute: async (output) => toArtifactPartWire(await accept(output)),
      };

      return Object.freeze({
        system: compilerTurn.system,
        messages: compilerTurn.messages,
        tools: Object.freeze({ [RENDER_TOOL_NAME]: renderArtifact }),
        bundle: compilerTurn.bundle,
        contractFingerprint: compilerTurn.bundle.contractFingerprint,
        accept,
        toUIMessageStreamResponse(
          result: ArtifactUIStreamResult,
          responseOptions: ArtifactUIResponseOptions = {},
        ): Response {
          const {
            onArtifactError = () => "Artifact validation failed.",
            onError = () => "The model request failed.",
            ...streamAndResponseOptions
          } = responseOptions;
          // Keep only diagnostic codes through the internal UI-message stream.
          // User-facing text is mapped after artifact tool calls are identified.
          const source = result.toUIMessageStream({
            ...streamAndResponseOptions,
            onError: toTrustedStreamError,
          });
          const stream = createTrustedArtifactStream(
            source,
            compilerTurn.bundle.contractFingerprint,
            options.idFactory ?? defaultArtifactIdFactory,
            accept,
            onArtifactError,
            onError,
          );
          return createUIMessageStreamResponse({
            stream,
            ...pickResponseInit(streamAndResponseOptions),
          });
        },
      });
    },
  });
}

export async function decodeArtifactUIDataPart(
  part: unknown,
): Promise<ArtifactPart | undefined> {
  if (!isArtifactUIDataPart(part)) return undefined;
  const decoded = await decodeArtifactPart(part.data.part, {
    contractFingerprint: part.data.contractFingerprint,
  });
  return decoded.success ? decoded.part : undefined;
}

export function isArtifactUIDataPart(part: unknown): part is ArtifactUIDataPart {
  if (!isRecord(part) || part.type !== "data-artifact" || !isRecord(part.data)) return false;
  return part.data.artifactProtocol === "2.0"
    && typeof part.data.contractFingerprint === "string"
    && isRecord(part.data.part);
}

function createTrustedArtifactStream(
  source: ReadableStream<UIMessageChunk>,
  contractFingerprint: string,
  idFactory: NonNullable<ArtifactUIOptions["idFactory"]>,
  accept: (output: unknown) => Promise<ArtifactPart>,
  onArtifactError: (error: unknown) => string,
  onError: (error: unknown) => string,
): ReadableStream<UIMessageChunk> {
  const artifactToolCalls = new Set<string>();
  return source.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    async transform(chunk, controller) {
      if ((chunk.type === "tool-input-start" || chunk.type === "tool-input-available")
        && chunk.toolName === RENDER_TOOL_NAME) {
        artifactToolCalls.add(chunk.toolCallId);
        return;
      }
      if (chunk.type === "tool-input-delta" && artifactToolCalls.has(chunk.toolCallId)) return;
      if (chunk.type === "tool-input-error"
        && (artifactToolCalls.has(chunk.toolCallId) || chunk.toolName === RENDER_TOOL_NAME)) {
        artifactToolCalls.add(chunk.toolCallId);
        try {
          controller.enqueue(createArtifactUIDataPart(
            await accept(chunk.input),
            contractFingerprint,
            idFactory,
            chunk.toolCallId,
          ));
        } catch (error) {
          controller.enqueue({ type: "error", errorText: onArtifactError(error) });
        }
        return;
      }
      if (chunk.type === "tool-output-error" && artifactToolCalls.has(chunk.toolCallId)) {
        controller.enqueue({ type: "error", errorText: onArtifactError(chunk.errorText) });
        return;
      }
      if (chunk.type === "tool-output-denied" && artifactToolCalls.has(chunk.toolCallId)) {
        controller.enqueue({ type: "error", errorText: onArtifactError("Artifact output denied.") });
        return;
      }
      if (chunk.type === "tool-output-available" && artifactToolCalls.has(chunk.toolCallId)) {
        try {
          const decoded = await decodeArtifactPart(chunk.output, { contractFingerprint });
          if (!decoded.success) throw new TypeError("Artifact output failed runtime validation.");
          controller.enqueue(createArtifactUIDataPart(
            decoded.part,
            contractFingerprint,
            idFactory,
            chunk.toolCallId,
          ));
        } catch (error) {
          controller.enqueue({ type: "error", errorText: onArtifactError(error) });
        }
        return;
      }
      if (chunk.type === "error") {
        controller.enqueue({ type: "error", errorText: onError(chunk.errorText) });
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

function createArtifactUIDataPart(
  part: ArtifactPart,
  contractFingerprint: string,
  idFactory: NonNullable<ArtifactUIOptions["idFactory"]>,
  toolCallId: string,
): ArtifactUIDataPart {
  return {
    type: "data-artifact",
    id: idFactory("ui-part", toolCallId),
    data: {
      artifactProtocol: "2.0",
      contractFingerprint,
      part: toArtifactPartWire(part),
    },
  };
}

function toTrustedStreamError(error: unknown): string {
  const diagnostic = diagnosticsFromUnknown(error)[0];
  return diagnostic ? `data-elements:${diagnostic.code}` : "data-elements:unknown";
}

function pickResponseInit(input: ArtifactUIResponseOptions): ResponseInit {
  return {
    ...(input.headers ? { headers: input.headers } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.statusText ? { statusText: input.statusText } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
