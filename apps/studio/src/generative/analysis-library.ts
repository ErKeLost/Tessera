/**
 * Compiles the analysis presentation vocabulary into the model contract that
 * Tessera appends to the Agent's answer policy.
 *
 * Runs on the Studio server next to the Mastra agent, so it stays free of React
 * and shares the component specs with the browser renderer.
 */
import { createLibrary, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";
import {
  ANALYSIS_ROOT_COMPONENT,
  analysisLeafSpecs,
  buildAnalysisLayoutSpecs,
} from "./analysis-components";

/**
 * Presentation boundaries that keep generated views answerable to the same
 * evidence and permission rules as the rest of the Agent.
 */
export const analysisPresentationRules: readonly string[] = [
  "These rules override the Inline Mode section above. Tessera is not a UI editor: for every answer that presents verified data, emit the fenced block. Never wait for the user to ask for a view, and never treat the previous view as something to keep unchanged.",
  "Emit at most one fenced block per answer, placed after the first sentence of prose. The Markdown prose stays the answer; the block is its visual form.",
  "Only show values that a tool result in this conversation returned. Never compute, round differently, extrapolate, or restate a number the tools did not return.",
  "Every label, category, and column name must come from the tool result or the user's own wording. Never invent an entity, period, or dimension.",
  "Keep parallel arrays aligned: categories and values, and labels and values, must be the same length and order.",
  "When results are empty, partial, truncated, stale, unavailable, or denied, leave the affected block out and explain it with Callout instead of filling in values.",
  "When no verified result supports a view, answer in prose only and emit no block.",
  "Never put SQL, credentials, connection details, internal identifiers, analysis references, URLs, CSS, HTML, or SVG in a block.",
];

/** One complete answer showing the shape Tessera expects back. */
export const analysisPresentationExamples: readonly string[] = [
  [
    'User: "How did revenue trend by region last quarter?"',
    "",
    "Answer in Markdown, then exactly one block:",
    "",
    "Revenue rose in all three reporting regions, led by AMER.",
    "",
    "```openui-lang",
    "root = Stack([headline, trend, breakdown, caveat])",
    'headline = Metric("Total revenue", "$1.24M", "+8.3% vs prior quarter", "Paid invoices only")',
    'trend = LineChart("Monthly revenue", ["Apr", "May", "Jun"], [392000, 402000, 446000], "USD", "Sum of paid invoices")',
    'breakdown = Table("Revenue by region", ["Region", "Revenue", "Share"], [["AMER", "$440K", "35%"], ["EMEA", "$420K", "34%"], ["APAC", "$380K", "31%"]], "12,480 invoices across three regions")',
    'caveat = Callout("warning", "Coverage", "One region was excluded because the join returned no rows.")',
    "```",
  ].join("\n"),
];

function buildLibrary() {
  const leaves = analysisLeafSpecs.map((spec) => defineComponent({
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
      { name: "Data", components: ["Metric", "Table", "Ranking", "BarChart", "LineChart"] },
      { name: "Narrative", components: ["Insight", "Callout"] },
    ],
  });
}

const analysisLibrary = buildLibrary();

/**
 * The block of agent instructions that teaches the model the analysis view
 * language. Rendered once at startup and appended to the answer contract.
 */
export function buildAnalysisPresentationPrompt(): string {
  const contract = analysisLibrary.prompt({
    inlineMode: true,
    preamble: [
      "Tessera answers questions about connected data.",
      "",
      "Reply with two parts, in this order:",
      "1. A short Markdown answer.",
      "2. Exactly one fenced ```openui-lang block that presents the same verified results as an analysis view.",
      "",
      "The view is how Tessera shows the answer, not a separate task. The user never has to ask for a view, and a",
      "question about data still deserves one: whenever the answer relies on a tool result, include the block. Omit it",
      "only when the answer needs no data at all.",
      "",
      "The Inline Mode section below explains how fenced blocks are parsed. Where it says to answer a question with",
      "plain text and no code, apply that only to an answer with no verified data behind it.",
    ].join("\n"),
    additionalRules: [...analysisPresentationRules],
    examples: [...analysisPresentationExamples],
  });

  return `<analysis_view>
${contract}
</analysis_view>`;
}

export const analysisViewSyntax = {
  fence: "openui-lang",
  root: ANALYSIS_ROOT_COMPONENT,
} as const;
