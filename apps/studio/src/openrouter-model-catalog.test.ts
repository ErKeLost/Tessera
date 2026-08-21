import { describe, expect, test } from "bun:test";
import {
  createOpenRouterModelCatalog,
  parseOpenRouterModelRecords,
} from "./openrouter-model-catalog";

describe("OpenRouter model catalog", () => {
  test("returns every text model and keeps only valid reasoning efforts", () => {
    const records = parseOpenRouterModelRecords({
      data: [
        { id: "deepseek/deepseek-v4-pro", name: "Older DeepSeek", created: 10 },
        {
          id: "deepseek/deepseek-v4-pro-0813",
          name: "DeepSeek: DeepSeek V4 Pro 0813",
          created: 20,
          reasoning: {
            supported_efforts: ["max", "high", "low", "not-an-effort"],
            default_effort: "high",
          },
        },
        {
          id: "qwen/qwen3.8-27b",
          name: "Qwen: Qwen3.8 27B",
          created: 30,
          reasoning: {
            supported_efforts: ["xhigh", "medium", "low"],
            default_effort: "xhigh",
            default_enabled: true,
          },
        },
        {
          id: "qwen/qwen3.8-27b:batch",
          name: "Qwen batch",
          created: 40,
          reasoning: { supported_efforts: ["xhigh"] },
        },
        {
          id: "moonshotai/kimi-k3",
          name: "MoonshotAI: Kimi K3",
          created: 20,
          reasoning: { supported_efforts: ["max", "high", "low"] },
        },
        {
          id: "z-ai/glm-5.2",
          name: "Z.ai: GLM 5.2",
          created: 20,
          reasoning: { supported_efforts: ["xhigh", "high"] },
        },
        {
          id: "x-ai/grok-4.6",
          name: "SpaceXAI: Grok 4.6",
          created: 20,
          reasoning: {
            supported_efforts: ["xhigh", "high", "medium", "low"],
            mandatory: true,
          },
        },
        {
          id: "image/vendor-image",
          name: "Image only",
          created: 100,
          architecture: { output_modalities: ["image"] },
        },
        { id: "bad model", name: "Ignored", created: 100 },
      ],
    });

    const catalog = createOpenRouterModelCatalog(records);

    expect(catalog.models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4-pro-0813",
      "deepseek/deepseek-v4-pro",
      "moonshotai/kimi-k3",
      "qwen/qwen3.8-27b:batch",
      "qwen/qwen3.8-27b",
      "x-ai/grok-4.6",
      "z-ai/glm-5.2",
    ]);
    expect(catalog.models[0]?.reasoning?.supportedEfforts).toEqual(["max", "high", "low"]);
    expect(catalog.models[4]?.reasoning).toMatchObject({
      defaultEffort: "xhigh",
      defaultEnabled: true,
    });
    expect(catalog.models[5]?.reasoning?.mandatory).toBeTrue();
  });

  test("includes the configured OpenRouter model when it is older than the provider limit", () => {
    const records = parseOpenRouterModelRecords({
      data: [{
        id: "other/vendor-model",
        name: "Current vendor model",
        created: 1,
        reasoning: { supported_efforts: ["low"] },
      }],
    });

    const catalog = createOpenRouterModelCatalog(records, "other/vendor-model");

    expect(catalog.models).toEqual([
      expect.objectContaining({ id: "other/vendor-model", family: "Other" }),
    ]);
  });

  test("keeps the latest three text models per provider plus an older current model", () => {
    const records = parseOpenRouterModelRecords({
      data: [
        { id: "openai/model-1", name: "Model 1", created: 1 },
        { id: "openai/model-2", name: "Model 2", created: 2 },
        { id: "openai/model-3", name: "Model 3", created: 3 },
        { id: "openai/model-4", name: "Model 4", created: 4 },
        { id: "anthropic/model-1", name: "Claude 1", created: 1 },
        { id: "anthropic/model-2", name: "Claude 2", created: 2 },
        { id: "anthropic/model-3", name: "Claude 3", created: 3 },
        { id: "anthropic/model-4", name: "Claude 4", created: 4 },
      ],
    });

    expect(createOpenRouterModelCatalog(records).models.map((model) => model.id)).toEqual([
      "anthropic/model-4",
      "anthropic/model-3",
      "anthropic/model-2",
      "openai/model-4",
      "openai/model-3",
      "openai/model-2",
    ]);
    expect(createOpenRouterModelCatalog(records, "openai/model-1").models.map((model) => model.id)).toEqual([
      "openai/model-1",
      "anthropic/model-4",
      "anthropic/model-3",
      "anthropic/model-2",
      "openai/model-4",
      "openai/model-3",
      "openai/model-2",
    ]);
  });
});
