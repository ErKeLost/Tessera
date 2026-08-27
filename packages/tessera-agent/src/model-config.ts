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

/** Provider-specific reasoning options are emitted only when explicitly configured. */
export function modelReasoningOptions(llm: TesseraAgentLlmConfig) {
  return typeof llm.model === "string"
    && llm.model.startsWith("openrouter/")
    && llm.reasoningEffort !== undefined
    ? { providerOptions: { openrouter: { reasoning: { effort: llm.reasoningEffort } } } }
    : {};
}
