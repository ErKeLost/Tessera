import { createTool, type Tool } from "@mastra/core/tools";
import {
  DEFAULT_DOCUMENT_POLICY,
  ArtifactCommitError,
  commitValidatedArtifactProposal,
  createArtifactCompiler,
  mergeArtifactCommitHostContext,
  toArtifactPartWire,
  type AcceptArtifactOptions,
  type ArtifactCommitHostContext,
  type ArtifactCommitOptions,
  type ArtifactCompilerOptions,
  type ArtifactTransportAdapter,
  type JSONSchema,
  type PrepareTurnInput,
  type PreparedTurn,
  type RepairProvider,
  type TurnMessage,
} from "@data-elements/compiler";
import {
  artifactPartWireSchema,
  decodeArtifactPart,
  type ArtifactPart,
  type ArtifactPartWire,
} from "@data-elements/runtime";
import type { Artifact } from "@data-elements/schema";
import { z } from "zod";

const RENDER_TOOL_NAME = "renderArtifact";
const SAFE_INPUT = Object.freeze({ type: "artifact-proposal", redacted: true });

export type MastraArtifactTool = Tool<unknown, ArtifactPartWire>;

export type MastraWorkflowArtifactEvent = {
  type: string;
  toolName?: string;
  output?: unknown;
  result?: unknown;
  data?: unknown;
};

const directMastraAdapter: ArtifactTransportAdapter<unknown> = {
  id: "mastra.direct-tool-input",
  extractProposal: (input) => input,
};

export type MastraArtifactUIOptions = ArtifactCompilerOptions & ArtifactCommitOptions;

export type PrepareMastraTurnInput<TMessage extends TurnMessage = TurnMessage> =
  Omit<PrepareTurnInput<TMessage>, "resourceIds"> & ArtifactCommitHostContext & {
    repairProvider?: RepairProvider;
  };

export type PreparedMastraTurn<TMessage extends TurnMessage = TurnMessage> = Readonly<{
  system: string;
  messages: readonly TMessage[];
  tools: Readonly<{ renderArtifact: MastraArtifactTool }>;
  artifactTurn: PreparedTurn<TMessage>;
  contractFingerprint: string;
  accept(output: unknown, options?: AcceptArtifactOptions): Promise<ArtifactPart>;
  consumeWorkflowEvent(
    event: MastraWorkflowArtifactEvent,
    options?: AcceptArtifactOptions,
  ): Promise<ArtifactPart>;
}>;

export function createMastraArtifactUI(options: MastraArtifactUIOptions = {}) {
  const compiler = createArtifactCompiler(options);
  return Object.freeze({
    catalog: compiler.catalog,
    async prepareTurn<TMessage extends TurnMessage>(
      input: PrepareMastraTurnInput<TMessage>,
    ): Promise<PreparedMastraTurn<TMessage>> {
      const host = mergeArtifactCommitHostContext(options, input);
      const artifactTurn = await compiler.prepareTurn({
        ...input,
        resourceIds: Object.keys(host.resources),
      });
      const documentPolicy = input.documentPolicy ?? options.documentPolicy ?? DEFAULT_DOCUMENT_POLICY;

      const acceptWith = async <TOutput>(
        output: TOutput,
        adapter: ArtifactTransportAdapter<TOutput>,
        acceptOptions: AcceptArtifactOptions = {},
      ): Promise<ArtifactPart> => {
        const proposalPart = await artifactTurn.accept(output, adapter, {
          repairProvider: acceptOptions.repairProvider ?? input.repairProvider,
          parentRevisionId: acceptOptions.parentRevisionId,
          headPreconditions: acceptOptions.headPreconditions,
          statePreconditions: acceptOptions.statePreconditions,
        });
        return commitValidatedArtifactProposal(proposalPart, artifactTurn.bundle, {
          documentPolicy,
          ...host,
          now: options.now,
          idFactory: options.idFactory,
          stateDefinition: options.stateDefinition,
        });
      };

      const inputSchema = createMastraInputSchema(artifactTurn.providerSchema);
      const tool = createTool({
        id: RENDER_TOOL_NAME,
        description: artifactTurn.tools.renderArtifact.description,
        inputSchema,
        outputSchema: artifactPartWireSchema,
        strict: true,
        mcp: {
          annotations: {
            title: "Data Elements artifact",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        execute: async (proposal) => toArtifactPartWire(
          await acceptWith(proposal, directMastraAdapter),
        ),
        toModelOutput: () => ({
          type: "text" as const,
          value: "The artifact was validated and is ready to render.",
        }),
        transform: {
          display: {
            input: () => SAFE_INPUT,
            inputDelta: () => SAFE_INPUT,
            error: () => ({ message: "Artifact validation failed." }),
          },
          transcript: {
            input: () => SAFE_INPUT,
            inputDelta: () => SAFE_INPUT,
            error: () => ({ message: "Artifact validation failed." }),
          },
        },
      });

      const accept = (output: unknown, acceptOptions?: AcceptArtifactOptions) => (
        acceptWith(output, directMastraAdapter, acceptOptions)
      );
      return Object.freeze({
        system: artifactTurn.system,
        messages: artifactTurn.messages,
        tools: Object.freeze({ renderArtifact: tool as MastraArtifactTool }),
        artifactTurn,
        contractFingerprint: artifactTurn.bundle.contractFingerprint,
        accept,
        consumeWorkflowEvent: async (
          event: MastraWorkflowArtifactEvent,
          acceptOptions?: AcceptArtifactOptions,
        ) => {
          const payload = extractWorkflowPayload(event);
          if (isArtifactWire(payload)) {
            const decoded = await decodeArtifactPart(payload, {
              contractFingerprint: artifactTurn.bundle.contractFingerprint,
            });
            if (!decoded.success) {
              throw new ArtifactCommitError(
                "commit.workflow-artifact-invalid",
                decoded.diagnostics.map(({ code }) => code).join(", "),
              );
            }
            return decoded.part;
          }
          return acceptWith(payload, directMastraAdapter, acceptOptions);
        },
      });
    },
  });
}

export const createArtifactUI = createMastraArtifactUI;

function extractWorkflowPayload(event: MastraWorkflowArtifactEvent): unknown {
  if (event.toolName && event.toolName !== RENDER_TOOL_NAME) {
    throw new TypeError(`Workflow event belongs to ${event.toolName}, not ${RENDER_TOOL_NAME}.`);
  }
  if (!["tool-output", "tool_result", "workflow-output", "workflow_result", RENDER_TOOL_NAME]
    .includes(event.type)) {
    throw new TypeError(`Unsupported Mastra workflow event type: ${event.type}.`);
  }
  const payload = event.output ?? event.result ?? event.data;
  if (payload === undefined) throw new TypeError("Mastra workflow event has no artifact payload.");
  return payload;
}

function isArtifactWire(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && (Reflect.get(value, "kind") === "artifact-snapshot"
      || Reflect.get(value, "kind") === "artifact-stream"),
  );
}

function createMastraInputSchema(
  providerSchema: JSONSchema,
): z.ZodType {
  const compatible = structuredClone(providerSchema) as unknown;
  rewriteUnsupportedNotSchemas(compatible, "$", new Set<object>());
  return z.fromJSONSchema(compatible as Parameters<typeof z.fromJSONSchema>[0]);
}

function rewriteUnsupportedNotSchemas(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Array.isArray(value)) {
    const node = value as Record<string, unknown>;
    const negated = node.not;
    if (negated && typeof negated === "object" && !Array.isArray(negated)) {
      const not = negated as Record<string, unknown>;
      if (Object.keys(not).length === 0) {
        // Zod represents the JSON Schema "not everything" form as z.never().
      } else if (Array.isArray(not.enum) && not.enum.every((item) => typeof item === "string")) {
        const alternatives = not.enum.map((item) => escapeRegExp(item)).join("|");
        node.pattern = `^(?!(?:${alternatives})$).*$`;
        delete node.not;
      } else if (not.pattern === "^\\$") {
        node.pattern = "^(?!\\$)";
        delete node.not;
      } else {
        throw new ArtifactCommitError(
          "mastra.unsupported-json-schema",
          `Mastra cannot represent the JSON Schema negation at ${path}.`,
        );
      }
    }
    for (const [key, child] of Object.entries(node)) {
      rewriteUnsupportedNotSchemas(child, `${path}/${key}`, seen);
    }
    return;
  }
  value.forEach((child, index) => rewriteUnsupportedNotSchemas(child, `${path}/${index}`, seen));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compactArtifactForModel(artifact: Artifact) {
  if (artifact.kind === "query") {
    return {
      kind: artifact.kind,
      title: artifact.title,
      description: artifact.description,
      columns: artifact.columns,
      sampleRows: artifact.rows.slice(0, 20),
      rowCount: artifact.rowCount,
      sourceTables: artifact.sourceTables,
      warnings: artifact.warnings,
    };
  }
  return artifact;
}
