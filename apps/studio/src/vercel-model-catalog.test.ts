import { expect, test } from "bun:test";
import { createVercelModelCatalogProvider, parseVercelModelCatalog } from "./vercel-model-catalog";

const language = { id: "openai/gpt-4.1-mini", name: "GPT 4.1 Mini", type: "language", tags: ["tool-use"], modalities: { output: ["text"] } };

test("Vercel catalog excludes embeddings, image-only and non-tool models", () => {
  const catalog = parseVercelModelCatalog({ data: [
    language, language,
    { ...language, id: "openai/embedding", type: "embedding" },
    { ...language, id: "openai/image", modalities: { output: ["image"] } },
    { ...language, id: "typesafe-ai/jev", tags: [] },
    { ...language, id: "invalid model" },
    null,
  ] });
  expect(catalog.models).toEqual([{ id: language.id, name: language.name, family: "openai" }]);
});

test("Vercel catalog coalesces public requests and caches without credentials", async () => {
  const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  const catalog = createVercelModelCatalogProvider((async (url, init) => {
    requests.push({ url, init });
    return Response.json({ data: [language] });
  }));
  const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
  expect(a).toEqual(b);
  expect(await catalog.list()).toEqual(a);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://ai-gateway.vercel.sh/v1/models");
  expect(requests[0]?.init?.headers).toEqual({ Accept: "application/json" });
});

test("Vercel outage never substitutes OpenRouter models", async () => {
  const catalog = createVercelModelCatalogProvider(async () => new Response(null, { status: 503 }));
  expect(await catalog.list()).toEqual({ models: [] });
});
