"use client";

import {
  Ai21,
  Alibaba,
  Anthropic,
  Baichuan,
  Baidu,
  Bedrock,
  ByteDance,
  Cerebras,
  ChatGLM,
  Cloudflare,
  Cohere,
  CommandA,
  DeepInfra,
  DeepSeek,
  Doubao,
  Dbrx,
  Fireworks,
  Gemini,
  Gemma,
  Grok,
  Groq,
  HuggingFace,
  Hunyuan,
  IBM,
  InternLM,
  Kimi,
  LmStudio,
  Microsoft,
  Minimax,
  Mistral,
  Meta,
  ModelScope,
  Moonshot,
  Morph,
  Nova,
  NousResearch,
  Nvidia,
  Ollama,
  OpenAI,
  OpenRouter,
  Perplexity,
  Poolside,
  PrunaAI,
  Qwen,
  Rwkv,
  SambaNova,
  SenseNova,
  SiliconCloud,
  Skywork,
  Spark,
  Stability,
  Stepfun,
  TII,
  Tencent,
  Together,
  Upstage,
  Vercel,
  VertexAI,
  Volcengine,
  Wenxin,
  WorkersAI,
  Yi,
  ZAI,
  Zhipu,
} from "@lobehub/icons";
import { BotIcon } from "lucide-react";
import type { ComponentType } from "react";

export type ModelBrandIconProps = Readonly<{ size?: number | string }>;

type BrandIcon = ComponentType<ModelBrandIconProps>;

export type ModelBrandSource = Readonly<{
  id: string;
  name?: string;
  family?: string;
}>;

type ModelBrand = Readonly<{
  key: string;
  /**
   * Provider segments accepted verbatim as the part before the first "/" in a
   * model id, e.g. "openai" in "openai/gpt-5".
   */
  providers: readonly string[];
  /**
   * Fragments matched against the model id and display name. Used for custom
   * provider entries such as "deepseek-flash" and for families hosted under a
   * different provider, e.g. Gemma on Google.
   */
  keywords: readonly string[];
  icon: BrandIcon;
}>;

/**
 * Model families that ship their own logo even though they are served by a
 * broader provider segment.
 *
 * `providers` lists the host segments this family overrides, so
 * "google/gemma-3" resolves to Gemma instead of Gemini. A family also applies
 * when the provider segment is unknown, which covers custom endpoints such as
 * "glm-4.6".
 */
const MODEL_FAMILY_BRANDS: readonly ModelBrand[] = [
  { key: "gemma", providers: ["google", "google-ai", "googleai", "vertex", "vertexai", "vertex-ai", "gemma"], keywords: ["gemma"], icon: Gemma.Color },
  { key: "nova", providers: ["amazon", "amazon-bedrock", "bedrock", "aws", "nova"], keywords: ["nova-"], icon: Nova.Color },
  { key: "command", providers: ["cohere", "command-a"], keywords: ["command-a"], icon: CommandA.Color },
  { key: "kimi", providers: ["moonshot", "moonshotai", "moonshot-ai", "kimi"], keywords: ["kimi"], icon: Kimi.Color },
  { key: "hunyuan", providers: ["tencent", "tencent-cloud", "hunyuan"], keywords: ["hunyuan"], icon: Hunyuan.Color },
  { key: "doubao", providers: ["volcengine", "volc", "bytedance", "doubao"], keywords: ["doubao"], icon: Doubao.Color },
  { key: "dbrx", providers: ["databricks", "dbrx"], keywords: ["dbrx"], icon: Dbrx.Color },
  { key: "glm", providers: ["glm", "chatglm"], keywords: ["glm-", "glmv", "chatglm"], icon: ChatGLM.Color },
  { key: "ernie", providers: ["ernie"], keywords: ["ernie"], icon: Wenxin.Color },
  { key: "abab", providers: ["abab"], keywords: ["abab"], icon: Minimax.Color },
  { key: "spark", providers: ["iflytek", "spark"], keywords: ["spark-"], icon: Spark.Color },
  { key: "sensenova", providers: ["sensenova", "sensetime"], keywords: ["sensenova"], icon: SenseNova.Color },
  { key: "granite", providers: ["ibm", "granite"], keywords: ["granite"], icon: IBM },
  { key: "phi", providers: ["phi"], keywords: ["phi-"], icon: Microsoft.Color },
  { key: "grok", providers: ["grok"], keywords: ["grok"], icon: Grok },
  { key: "gpt", providers: ["gpt"], keywords: ["gpt-", "chatgpt", "o1-", "o3-", "o4-"], icon: OpenAI },
];

/** Provider segments keyed to the most specific logo LobeHub ships for them. */
const PROVIDER_BRANDS: readonly ModelBrand[] = [
  { key: "openai", providers: ["openai", "open-ai", "chatgpt"], keywords: ["openai"], icon: OpenAI },
  { key: "anthropic", providers: ["anthropic", "claude"], keywords: ["anthropic", "claude"], icon: Anthropic },
  { key: "google", providers: ["google", "google-ai", "googleai", "palm", "bison"], keywords: ["google"], icon: Gemini.Color },
  { key: "vertex", providers: ["vertex", "vertexai", "vertex-ai"], keywords: ["vertex"], icon: VertexAI.Color },
  { key: "microsoft", providers: ["microsoft", "azure", "azure-ai", "azureai", "copilot"], keywords: ["microsoft", "azure"], icon: Microsoft.Color },
  { key: "meta", providers: ["meta", "meta-llama", "llama", "llama-2", "llama-3"], keywords: ["meta-llama"], icon: Meta.Color },
  { key: "mistral", providers: ["mistral", "mistralai", "mistral-ai"], keywords: ["mistral"], icon: Mistral.Color },
  { key: "deepseek", providers: ["deepseek", "deep-seek"], keywords: ["deepseek"], icon: DeepSeek.Color },
  { key: "qwen", providers: ["qwen", "qwen-ai", "tongyi"], keywords: ["qwen"], icon: Qwen.Color },
  { key: "moonshot", providers: ["moonshot", "moonshotai", "moonshot-ai"], keywords: ["moonshot"], icon: Moonshot },
  { key: "xai", providers: ["x-ai", "xai"], keywords: ["xai"], icon: Grok },
  { key: "zai", providers: ["z-ai", "zai"], keywords: ["z.ai"], icon: ZAI },
  { key: "zhipu", providers: ["zhipu", "zhipuai", "bigmodel"], keywords: ["zhipu"], icon: Zhipu.Color },
  { key: "cohere", providers: ["cohere"], keywords: ["cohere"], icon: Cohere.Color },
  { key: "nvidia", providers: ["nvidia", "nemotron"], keywords: ["nvidia", "nemotron"], icon: Nvidia.Color },
  { key: "perplexity", providers: ["perplexity", "pplx", "sonar"], keywords: ["perplexity", "sonar"], icon: Perplexity.Color },
  { key: "amazon", providers: ["amazon", "amazon-bedrock", "bedrock", "aws"], keywords: ["bedrock"], icon: Bedrock.Color },
  { key: "minimax", providers: ["minimax", "mini-max"], keywords: ["minimax"], icon: Minimax.Color },
  { key: "yi", providers: ["01-ai", "01ai", "yi"], keywords: ["yi-"], icon: Yi.Color },
  { key: "baichuan", providers: ["baichuan"], keywords: ["baichuan"], icon: Baichuan.Color },
  { key: "stepfun", providers: ["stepfun", "step", "step-ai"], keywords: ["stepfun", "step-"], icon: Stepfun },
  { key: "internlm", providers: ["internlm", "intern-lm", "shanghai-ai-lab"], keywords: ["internlm"], icon: InternLM.Color },
  { key: "nousresearch", providers: ["nousresearch", "nous", "nous-hermes"], keywords: ["nous"], icon: NousResearch },
  { key: "alibaba", providers: ["alibaba", "dashscope", "bailian"], keywords: ["alibaba"], icon: Alibaba.Color },
  { key: "tencent", providers: ["tencent", "hunyuan-ai"], keywords: ["tencent"], icon: Tencent.Color },
  { key: "baidu", providers: ["baidu", "wenxin", "qianfan"], keywords: ["baidu", "wenxin"], icon: Baidu.Color },
  { key: "bytedance", providers: ["bytedance", "volcengine", "volc"], keywords: ["bytedance", "volcengine", "seed-"], icon: ByteDance.Color },
  { key: "groq", providers: ["groq"], keywords: ["groq"], icon: Groq },
  { key: "cerebras", providers: ["cerebras"], keywords: ["cerebras"], icon: Cerebras.Color },
  { key: "together", providers: ["together", "togetherai", "together-ai"], keywords: ["together"], icon: Together.Color },
  { key: "fireworks", providers: ["fireworks", "fireworksai", "fireworks-ai"], keywords: ["fireworks"], icon: Fireworks.Color },
  { key: "deepinfra", providers: ["deepinfra", "deep-infra"], keywords: ["deepinfra"], icon: DeepInfra.Color },
  { key: "ai21", providers: ["ai21", "ai21labs", "ai21-labs"], keywords: ["ai21", "jamba"], icon: Ai21.BrandColor },
  { key: "sambanova", providers: ["sambanova", "samba-nova"], keywords: ["sambanova"], icon: SambaNova.Color },
  { key: "upstage", providers: ["upstage", "solar-pro"], keywords: ["upstage"], icon: Upstage.Color },
  { key: "tii", providers: ["tii", "tiiuae", "falcon"], keywords: ["tiiuae", "falcon"], icon: TII.Color },
  { key: "stability", providers: ["stability", "stabilityai"], keywords: ["stability"], icon: Stability.Color },
  { key: "modelscope", providers: ["modelscope", "model-scope"], keywords: ["modelscope"], icon: ModelScope.Color },
  { key: "siliconcloud", providers: ["siliconcloud", "siliconflow", "silicon-cloud"], keywords: ["silicon"], icon: SiliconCloud.Color },
  { key: "skywork", providers: ["skywork"], keywords: ["skywork"], icon: Skywork.Color },
  { key: "morph", providers: ["morph", "morphllm", "morph-llm"], keywords: ["morph"], icon: Morph.Color },
  { key: "poolside", providers: ["poolside"], keywords: ["poolside", "laguna"], icon: Poolside.Color },
  { key: "prunaai", providers: ["pruna", "prunaai"], keywords: ["pruna"], icon: PrunaAI.Color },
  { key: "rwkv", providers: ["rwkv", "ai2"], keywords: ["rwkv"], icon: Rwkv.Color },
  { key: "ollama", providers: ["ollama"], keywords: ["ollama"], icon: Ollama },
  { key: "lmstudio", providers: ["lmstudio", "lm-studio"], keywords: ["lmstudio", "lm studio"], icon: LmStudio },
  { key: "huggingface", providers: ["huggingface", "hugging-face", "hf"], keywords: ["huggingface"], icon: HuggingFace.Color },
  { key: "cloudflare", providers: ["cloudflare", "workers-ai", "workersai"], keywords: ["cloudflare", "workers-ai"], icon: Cloudflare.Color },
  { key: "openrouter", providers: ["openrouter", "open-router"], keywords: ["openrouter"], icon: OpenRouter.Color },
  { key: "vercel", providers: ["vercel", "gateway"], keywords: ["vercel"], icon: Vercel },
  { key: "google-cloud", providers: ["google-cloud", "googlecloud", "gcp"], keywords: [], icon: VertexAI.Color },
];

/** Every provider segment already claimed by a brand, used to gate family matching. */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_BRANDS.flatMap((brand) => brand.providers));

/** Minimum provider length that may be used as a dash-suffixed prefix match. */
const MINIMUM_PREFIX_LENGTH = 4;

function normalize(value: string | undefined): string {
  return (value ?? "").toLocaleLowerCase("en-US").replace(/^~/u, "");
}

function providerSegment(id: string): string {
  const trimmed = id.replace(/^~/u, "");
  return trimmed.includes("/") ? (trimmed.split("/", 1)[0] ?? trimmed) : trimmed;
}

export type ResolvedModelBrand = Readonly<{ key: string; icon: BrandIcon }>;

/**
 * Resolves a model id to the closest brand logo.
 *
 * Order matters: model families (Gemma, Nova, ...) win over their host
 * provider, then the exact provider segment, then a dash-suffixed provider
 * prefix ("deepseek-flash" for custom endpoints), then free-text keywords.
 */
export function resolveModelBrand(model: ModelBrandSource | undefined): ResolvedModelBrand | undefined {
  if (!model) return undefined;
  const id = normalize(model.id);
  const provider = providerSegment(model.id).toLocaleLowerCase("en-US");
  const haystack = `${id} ${normalize(model.name)} ${normalize(model.family)}`;
  const has = (keywords: readonly string[]) => keywords.some((keyword) => haystack.includes(keyword));
  const matchesProvider = (brand: ModelBrand) => brand.providers.includes(provider);
  const matchesPrefix = (brand: ModelBrand) => brand.providers.some((candidate) =>
    candidate.length >= MINIMUM_PREFIX_LENGTH
    && (provider.startsWith(`${candidate}-`) || provider.startsWith(`${candidate}_`) || provider.startsWith(`${candidate}.`)));

  const family = MODEL_FAMILY_BRANDS.find((brand) =>
    has(brand.keywords) && (brand.providers.includes(provider) || !KNOWN_PROVIDERS.has(provider)));
  if (family) return family;

  const exact = PROVIDER_BRANDS.find(matchesProvider);
  if (exact) return exact;

  const prefix = PROVIDER_BRANDS.find(matchesPrefix);
  if (prefix) return prefix;

  return PROVIDER_BRANDS.find((brand) => has(brand.keywords));
}

function ModelBrandFallback({ model, size }: { model?: ModelBrandSource; size: number }) {
  const label = (model?.name ?? model?.id ?? "").replace(/^[^A-Za-z0-9]+/u, "").trim();
  if (!label) return <BotIcon size={size} strokeWidth={1.8} />;
  return (
    <span
      aria-hidden="true"
      className="studio-model-brand-fallback"
      style={{ fontSize: Math.max(9, Math.round(size * 0.56)), height: size, width: size }}
    >
      {label.charAt(0)}
    </span>
  );
}

export function StudioModelBrandIcon({ model, size }: { model?: ModelBrandSource; size: number }) {
  const brand = resolveModelBrand(model);
  if (brand) {
    const Icon = brand.icon;
    return <Icon size={size} />;
  }
  return <ModelBrandFallback model={model} size={size} />;
}
