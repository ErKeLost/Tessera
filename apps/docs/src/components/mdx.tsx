import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { DataChartDemo, DataChartGallery } from "./generative-gallery";
import { LocalizedCard } from "./localized-card";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Card: LocalizedCard,
    DataChartDemo,
    DataChartGallery,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global { type MDXProvidedComponents = ReturnType<typeof getMDXComponents>; }
