import type { MastraModelConfig } from "@mastra/core/llm";
import type { TesseraAgentLlmConfig } from "./contracts";

/** Converts normalized host-owned settings to Mastra's current model contract. */
export function toMastraModelConfig(llm: TesseraAgentLlmConfig): MastraModelConfig {
  if (llm.apiKey === undefined && llm.baseUrl === undefined && Object.keys(llm.headers).length === 0) {
    return llm.model as MastraModelConfig;
  }
  return {
    id: llm.model as `${string}/${string}`,
    ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
    ...(llm.baseUrl === undefined ? {} : { url: llm.baseUrl }),
    ...(Object.keys(llm.headers).length === 0 ? {} : { headers: { ...llm.headers } }),
  };
}

/** Forward host-owned provider options and apply the explicit OpenRouter reasoning selection. */
export function modelReasoningOptions(
  llm: TesseraAgentLlmConfig,
  effort = llm.reasoningEffort,
) {
  const providerOptions = { ...llm.providerOptions };
  if (typeof llm.model === "string" && llm.model.startsWith("openrouter/") && effort !== undefined) {
    providerOptions.openrouter = {
      ...providerOptions.openrouter,
      reasoning: { effort },
    };
  }
  return Object.keys(providerOptions).length ? { providerOptions } : {};
}
