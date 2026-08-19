import {
  ArtifactCatalog,
  createArtifactToolDescription,
  defaultArtifactCatalog,
  type ArtifactLike,
} from "@data-elements/core";
import { safeParseArtifact, type Artifact } from "@data-elements/schema";
import { jsonSchema, type Tool } from "ai";

export * from "./artifact-ui";

export type ArtifactExecutor<TArtifact extends ArtifactLike = Artifact> = (input: TArtifact) => TArtifact | Promise<TArtifact>;
export type RenderArtifactToolOptions<TArtifact extends ArtifactLike = Artifact> = {
  catalog?: ArtifactCatalog<TArtifact>;
  execute?: ArtifactExecutor<TArtifact>;
};

export function createRenderArtifactTool<TArtifact extends ArtifactLike = Artifact>(
  executeOrOptions?: ArtifactExecutor<TArtifact> | RenderArtifactToolOptions<TArtifact>,
): Tool<TArtifact, TArtifact> {
  const options = typeof executeOrOptions === "function"
    ? { execute: executeOrOptions }
    : (executeOrOptions ?? {});
  const catalog = options.catalog ?? defaultArtifactCatalog as unknown as ArtifactCatalog<TArtifact>;
  const providerSchema = jsonSchema<TArtifact>(catalog.toJSONSchema());
  const tool = {
    description: [
      "Render a trusted Data Elements artifact after a data tool has produced structured content.",
      "Do not use for plain prose or when the result does not benefit from inspection, comparison, editing, or interaction.",
      ...catalog.manifests().map((manifest) => `${manifest.kind}: ${createArtifactToolDescription(manifest)}`),
    ].join("\n\n"),
    inputSchema: providerSchema,
    outputSchema: providerSchema,
    execute: async (input: TArtifact) => {
      const artifact = catalog.parse(input);
      return options.execute ? options.execute(artifact) : artifact;
    },
  };
  return tool as unknown as Tool<TArtifact, TArtifact>;
}

export type ToolLikePart = {
  type: string;
  state?: string;
  output?: unknown;
  result?: unknown;
};

export function getArtifactFromToolPart(part: ToolLikePart, toolName = "renderArtifact"): Artifact | undefined {
  const isTool = part.type === `tool-${toolName}` || part.type === "dynamic-tool";
  if (!isTool || (part.state !== "output-available" && part.state !== "result")) return undefined;
  const parsed = safeParseArtifact(part.output ?? part.result);
  return parsed.success ? parsed.data : undefined;
}

export function getArtifactsFromMessages(messages: ReadonlyArray<{ parts?: readonly ToolLikePart[] }>, toolName = "renderArtifact") {
  return messages.flatMap((message) => message.parts ?? []).map((part) => getArtifactFromToolPart(part, toolName)).filter((artifact): artifact is Artifact => artifact !== undefined);
}
