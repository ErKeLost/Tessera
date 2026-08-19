import { describe, expect, test } from "bun:test";
import {
  createOpenRouterModelCatalog,
  parseOpenRouterModelRecords,
} from "./openrouter-model-catalog";

describe("OpenRouter model catalog", () => {
  test("picks the newest supported model for each requested family and keeps only valid efforts", () => {
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
        { id: "bad model", name: "Ignored", created: 100 },
      ],
    });

    const catalog = createOpenRouterModelCatalog(records);

    expect(catalog.models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4-pro-0813",
      "qwen/qwen3.8-27b",
      "moonshotai/kimi-k3",
      "z-ai/glm-5.2",
      "x-ai/grok-4.6",
    ]);
    expect(catalog.models[0]?.reasoning?.supportedEfforts).toEqual(["max", "high", "low"]);
    expect(catalog.models[1]?.reasoning).toMatchObject({
      defaultEffort: "xhigh",
      defaultEnabled: true,
    });
    expect(catalog.models[4]?.reasoning?.mandatory).toBeTrue();
  });

  test("includes the configured OpenRouter model when it is not one of the featured choices", () => {
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
      expect.objectContaining({ id: "other/vendor-model", family: "Current" }),
    ]);
  });
});
