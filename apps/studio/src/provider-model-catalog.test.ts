import { describe, expect, test } from "bun:test";
import type { TesseraLlmConfig } from "./config";
import { fetchStudioProviderModelCatalog, parseStudioProviderModels } from "./provider-model-catalog";

function llm(overrides: Partial<TesseraLlmConfig> = {}): TesseraLlmConfig {
  return {
    model: "custom/deepseek-flash",
    apiKey: "secret-key",
    baseUrl: "https://gateway.example.test/v1",
    headers: {},
    temperature: 0.1,
    maxOutputTokens: 1024,
    maxSteps: 3,
    maxRetries: 0,
    ...overrides,
  };
}

describe("Studio provider model catalog", () => {
  test("fetches OpenAI-compatible gateway models without returning credentials", async () => {
    let requestUrl: URL | undefined;
    const authorizations: string[] = [];
    const catalog = await fetchStudioProviderModelCatalog(llm(), {
      fetch: async (input, init) => {
        requestUrl = new URL(input.toString());
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        return Response.json({ data: [
          { id: "deepseek-flash", name: "DeepSeek Flash", context_length: 64_000 },
          { id: "text-embedding-3-small", name: "Embedding" },
          { id: "bad model", name: "Invalid" },
        ] });
      },
    });

    expect(requestUrl?.pathname).toBe("/v1/models");
    expect(authorizations).toEqual(["Bearer secret-key"]);
    expect(catalog.models).toEqual([{
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      family: "Custom gateway",
      contextWindow: 64_000,
    }]);
    expect(JSON.stringify(catalog)).not.toContain("secret-key");
  });

  test("uses Anthropic and Google authentication and model response shapes", async () => {
    const anthropic = await fetchStudioProviderModelCatalog(llm({
      model: "anthropic/claude-sonnet",
      baseUrl: "https://api.anthropic.com/v1",
    }), {
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("secret-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        return Response.json({ data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }] });
      },
    });
    expect(anthropic.models[0]).toMatchObject({ id: "claude-sonnet", family: "Anthropic" });

    let googleUrl: URL | undefined;
    const google = await fetchStudioProviderModelCatalog(llm({
      model: "google/gemini-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    }), {
      fetch: async (input, init) => {
        googleUrl = new URL(input.toString());
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret-key");
        return Response.json({ models: [
          { name: "models/gemini-flash", displayName: "Gemini Flash", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding", supportedGenerationMethods: ["embedContent"] },
        ] });
      },
    });
    expect(googleUrl?.pathname).toBe("/v1beta/models");
    expect(googleUrl?.searchParams.get("pageSize")).toBe("500");
    expect(google.models).toEqual([{
      id: "gemini-flash",
      name: "Gemini Flash",
      family: "Google",
      contextWindow: 1_000_000,
    }]);
  });

  test("normalizes model metadata from provider catalog shapes", () => {
    expect(parseStudioProviderModels({ models: [
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1_000_000, supportedGenerationMethods: ["generateContent"] },
    ] }, "google")).toEqual([{
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      family: "Google",
      contextWindow: 1_000_000,
    }]);
  });
});
