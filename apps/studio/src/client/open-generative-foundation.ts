"use client";

import {
  createShadcnDevelopmentFoundation,
  createVerifiedShadcnFoundation,
} from "@open-generative/adapter-shadcn";
import rendererRelease from "@open-generative/adapter-shadcn/renderer-release.json";
import { openGenerativeShadcnPorts } from "./components/ui/open-generative/adapter";

type TesseraOpenGenerativeDeployment = "demo" | "production" | null | undefined;

type RendererFoundationPromise = ReturnType<typeof createShadcnDevelopmentFoundation>;

let developmentFoundation: RendererFoundationPromise | undefined;
let productionFoundation: RendererFoundationPromise | undefined;

/**
 * The renderer boundary is application-owned. The core never imports Studio's
 * Shadcn source; changing the UI library only replaces this bridge.
 */
export function tesseraOpenGenerativeFoundationFor(
  deployment: TesseraOpenGenerativeDeployment,
): RendererFoundationPromise {
  if (deployment === "production") {
    productionFoundation ??= createVerifiedShadcnFoundation({
      ports: openGenerativeShadcnPorts,
      release: rendererRelease,
      hostBindingsTrust: "application-owned",
    });
    return productionFoundation;
  }

  developmentFoundation ??= createShadcnDevelopmentFoundation({
    ports: openGenerativeShadcnPorts,
  });
  return developmentFoundation;
}
