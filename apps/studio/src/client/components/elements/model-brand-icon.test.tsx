import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioModelBrandIcon, resolveModelBrand } from "./model-brand-icon";

function brandKey(id: string, name?: string, family?: string): string | undefined {
  return resolveModelBrand(name === undefined && family === undefined ? { id } : { id, name, family })?.key;
}

describe("resolveModelBrand", () => {
  test("resolves OpenRouter style provider segments", () => {
    expect(brandKey("openai/gpt-5")).toBe("openai");
    expect(brandKey("anthropic/claude-sonnet-4.5")).toBe("anthropic");
    expect(brandKey("google/gemini-2.5-pro")).toBe("google");
    expect(brandKey("meta-llama/llama-4-maverick")).toBe("meta");
    expect(brandKey("mistralai/mistral-large-2411")).toBe("mistral");
    expect(brandKey("deepseek/deepseek-v4-pro-0813")).toBe("deepseek");
    expect(brandKey("qwen/qwen3.8-27b")).toBe("qwen");
    expect(brandKey("moonshotai/kimi-k3")).toBe("kimi");
    expect(brandKey("x-ai/grok-4")).toBe("xai");
    expect(brandKey("z-ai/glm-4.6")).toBe("zai");
    expect(brandKey("nvidia/llama-3.3-nemotron-super-49b")).toBe("nvidia");
    expect(brandKey("perplexity/sonar-pro")).toBe("perplexity");
    expect(brandKey("cohere/command-r-plus")).toBe("cohere");
    expect(brandKey("nousresearch/hermes-4-70b")).toBe("nousresearch");
    expect(brandKey("openrouter/auto")).toBe("openrouter");
  });

  test("resolves custom provider model ids that carry no provider prefix", () => {
    // The regression that made DeepSeek custom endpoints fall back to a generic bot icon.
    expect(brandKey("deepseek-flash")).toBe("deepseek");
    expect(brandKey("deepseek-chat")).toBe("deepseek");
    expect(brandKey("deepseek-reasoner")).toBe("deepseek");
    expect(brandKey("gpt-4o-mini")).toBe("gpt");
    expect(brandKey("claude-sonnet-4")).toBe("anthropic");
    expect(brandKey("qwen3-max")).toBe("qwen");
    expect(brandKey("kimi-k2-thinking")).toBe("kimi");
    expect(brandKey("glm-4.6")).toBe("glm");
    expect(brandKey("gemma-3-27b-it")).toBe("gemma");
    expect(brandKey("hunyuan-large")).toBe("hunyuan");
  });

  test("prefers model family logos over their host provider", () => {
    expect(brandKey("google/gemma-3-27b")).toBe("gemma");
    expect(brandKey("amazon/nova-pro-v1")).toBe("nova");
    expect(brandKey("cohere/command-a-03-2025")).toBe("command");
    expect(brandKey("tencent/hunyuan-large")).toBe("hunyuan");
  });

  test("falls back to display-name keywords when the id carries no brand hint", () => {
    expect(brandKey("my-endpoint", "DeepSeek V4 Flash", "custom")).toBe("deepseek");
    expect(brandKey("local-model", "Qwen 3.8 27B", "custom")).toBe("qwen");
  });

  test("returns nothing for ids no brand claims", () => {
    expect(resolveModelBrand(undefined)).toBeUndefined();
    expect(resolveModelBrand({ id: "acme-internal-1" })).toBeUndefined();
  });
});

describe("StudioModelBrandIcon", () => {
  test("renders a brand svg for the configured custom DeepSeek endpoint", () => {
    const html = renderToStaticMarkup(
      <StudioModelBrandIcon model={{ id: "deepseek-flash", name: "deepseek-flash", family: "custom" }} size={16} />,
    );

    expect(html).toContain("<svg");
    expect(html).not.toContain("studio-model-brand-fallback");
  });

  test("renders an initial badge instead of a generic bot for unknown models", () => {
    const html = renderToStaticMarkup(
      <StudioModelBrandIcon model={{ id: "acme-internal-1", name: "Acme Internal", family: "custom" }} size={16} />,
    );

    expect(html).toContain("studio-model-brand-fallback");
    expect(html).toContain(">A<");
  });
});
