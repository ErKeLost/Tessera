import { parseOpenRouterModelRecords, type OpenRouterModelCatalog } from "./openrouter-model-catalog";

/** Public metadata only: gateway credentials are never sent to the catalog endpoint. */
export function createVercelModelCatalogProvider(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  let cached: { expiresAt: number; catalog: OpenRouterModelCatalog } | undefined;
  let pending: Promise<OpenRouterModelCatalog> | undefined;
  return {
    async list(): Promise<OpenRouterModelCatalog> {
      if (cached && cached.expiresAt > Date.now()) return cached.catalog;
      pending ??= (async () => {
        const response = await fetcher("https://ai-gateway.vercel.sh/v1/models", {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error("vercel_model_catalog_unavailable");
        const catalog = parseVercelModelCatalog(await response.json());
        if (!catalog.models.length) throw new Error("vercel_model_catalog_invalid");
        cached = { expiresAt: Date.now() + 5 * 60_000, catalog };
        return catalog;
      })().finally(() => { pending = undefined; });
      try {
        return await pending;
      } catch {
        return cached?.catalog ?? { models: [] };
      }
    },
  };
}

export function parseVercelModelCatalog(value: unknown): OpenRouterModelCatalog {
  const data = value && typeof value === "object" && "data" in value ? value.data : undefined;
  if (!Array.isArray(data)) return { models: [] };
  const languageModels = data.filter((item) => (
    item && typeof item === "object" && item.type === "language"
    && Array.isArray(item.modalities?.output) && item.modalities.output.includes("text")
    && Array.isArray(item.tags) && item.tags.includes("tool-use")
  ));
  return {
    models: parseOpenRouterModelRecords({ data: languageModels })
      .map(({ id, name }) => ({ id, name, family: id.split("/")[0] ?? "Vercel" }))
      .sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name)),
  };
}
