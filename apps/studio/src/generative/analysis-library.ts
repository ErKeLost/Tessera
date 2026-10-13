/**
 * Compiles the analysis presentation vocabulary into the model contract that
 * Tessera appends to the Agent's answer policy.
 *
 * Runs on the Studio server next to the Mastra agent, so it stays free of React
 * and shares the component specs with the browser renderer.
 *
 * The whole answer is OpenUI Lang — the official shape. `inlineMode` is left at
 * its default (`false`), so the model returns one program rather than Markdown
 * with a fenced block in it.
 */
import { createLibrary, defineComponent, generateSystemPrompt } from "@openuidev/lang-core";
import { z } from "zod";
import {
  ANALYSIS_ROOT_COMPONENT,
  analysisBlockSpecs,
  buildAnalysisLayoutSpecs,
} from "./analysis-components";

function buildLibrary() {
  const leaves = analysisBlockSpecs.map((spec) => defineComponent({
    name: spec.name,
    props: spec.props,
    description: spec.description,
    // lang-core keeps the renderer opaque; the browser supplies the real one.
    component: null,
  }));

  const block = z.union(leaves.map((leaf) => leaf.ref));
  const layouts = buildAnalysisLayoutSpecs(block).map((spec) => defineComponent({
    name: spec.name,
    props: spec.props,
    description: spec.description,
    component: null,
  }));

  return createLibrary({
    id: "tessera-analysis",
    root: ANALYSIS_ROOT_COMPONENT,
    components: [...layouts, ...leaves],
    componentGroups: [
      { name: "Layout", components: ["Stack", "Grid", "Section"] },
      { name: "Text", components: ["Heading", "Text", "Bullets"] },
      { name: "Data", components: ["Metric", "Table", "Ranking", "BarChart", "LineChart"] },
      { name: "Narrative", components: ["Insight", "Callout"] },
    ],
  });
}

const analysisLibrary = buildLibrary();

/** The root component every program must define. */
export const ANALYSIS_ROOT = ANALYSIS_ROOT_COMPONENT;

/** Prose blocks the model must always be able to reach. */
export const ANALYSIS_TEXT_COMPONENTS = ["Heading", "Text", "Bullets"] as const;

/**
 * The block of agent instructions that teaches the model the analysis view
 * language. Rendered once at module scope and appended to the answer contract.
 */
export function buildAnalysisPresentationPrompt(): string {
  // OpenUI's default prompt and nothing else: no preamble, no inlineMode, no
  // additionalRules, no examples. The opener then states that the entire
  // response must be a program, and the component signatures state the
  // vocabulary. Tessera's own answer policy lives in the Agent's prompt.
  const contract = generateSystemPrompt({ library: analysisLibrary.toSpec() });

  return `<analysis_view>
${contract}
</analysis_view>`;
}
