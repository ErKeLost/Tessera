"use client";

import { Anthropic, Google, OpenAI, OpenRouter, Vercel } from "@lobehub/icons";
import { NetworkIcon } from "lucide-react";

export function studioProviderLabel(provider: string): string {
  return ({ openrouter: "OpenRouter", vercel: "Vercel AI Gateway", openai: "OpenAI", anthropic: "Anthropic", google: "Google", custom: "Custom gateway" } as Record<string, string>)[provider] ?? provider;
}

/** Use official color variants where available; monochrome brands retain their identity. */
export function StudioProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  switch (provider) {
    case "openrouter": return <OpenRouter.Color aria-hidden="true" size={size} />;
    case "vercel": return <Vercel aria-hidden="true" size={size} />;
    case "openai": return <OpenAI aria-hidden="true" size={size} />;
    case "anthropic": return <Anthropic aria-hidden="true" size={size} />;
    case "google": return <Google.Color aria-hidden="true" size={size} />;
    default: return <NetworkIcon aria-hidden="true" size={size} />;
  }
}
