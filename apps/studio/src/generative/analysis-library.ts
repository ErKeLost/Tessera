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
import { createLibrary, defineComponent } from "@openuidev/lang-core";
import { z } from "zod";
import {
  ANALYSIS_ROOT_COMPONENT,
  analysisBlockSpecs,
  buildAnalysisLayoutSpecs,
} from "./analysis-components";

/**
 * Presentation boundaries that keep generated views answerable to the same
 * evidence and permission rules as the rest of the Agent.
 */
export const analysisPresentationRules: readonly string[] = [
  "Tessera answers questions about connected data by composing an interface. The interface is the answer: there is no separate prose reply, so explanatory sentences become Text blocks.",
  "Every reply is one complete program that starts with `root = Stack([...])`, including a greeting or a clarifying question. A reply with prose and no root renders nothing.",
  "Put the answer in the first two or three blocks: a Heading, then a Text. Add data blocks after the claim they support, never before it.",
  "Only show values that a tool result in this conversation returned. Never compute, round differently, extrapolate, or restate a number the tools did not return.",
  "Every label, category, and column name must come from the tool result or the user's own wording. Never invent an entity, period, or dimension.",
  "Keep parallel arrays aligned: categories and values, and labels and values, must be the same length and order.",
  "When results are empty, partial, truncated, stale, unavailable, or denied, leave the affected block out and say so in a Text or Callout instead of filling in values.",
  "When no verified result supports a number, answer with Heading, Text, and Bullets only. Never invent a Metric or a chart to look complete.",
  "Never put SQL, credentials, connection details, internal identifiers, analysis references, URLs, CSS, HTML, or SVG in a program.",
];

/** One complete answer showing the shape Tessera expects back. */
export const analysisPresentationExamples: readonly string[] = [
  [
    'User: "How did revenue trend by region last quarter?"',
    "",
    "```openui-lang",
    "root = Stack([title, summary, headline, trend, breakdown, caveat])",
    'title = Heading("Revenue by region, last quarter")',
    'summary = Text("Revenue rose in all three reporting regions, led by AMER. The window covers 2026-04-01 to 2026-06-30.")',
    'headline = Metric("Total revenue", "$1.24M", "+8.3% vs prior quarter", "Paid invoices only")',
    'trend = LineChart("Monthly revenue", ["Apr", "May", "Jun"], [392000, 402000, 446000], "USD", "Sum of paid invoices")',
    'breakdown = Table("Revenue by region", ["Region", "Revenue", "Share"], [["AMER", "$440K", "35%"], ["EMEA", "$420K", "34%"], ["APAC", "$380K", "31%"]], "12,480 invoices across three regions")',
    'caveat = Callout("warning", "Coverage", "One region was excluded because the join returned no rows.")',
    "```",
  ].join("\n"),
  [
    'User: "How many rows are in orders?"',
    "",
    "```openui-lang",
    "root = Stack([title, summary, caveat])",
    'title = Heading("Orders row count", "No relation selected")',
    'summary = Text("I cannot count this yet: no relation is selected in the workspace, and the connection exposes 260 tables. Tell me which table you mean and I will run the count.")',
    'caveat = Callout("warning", "Not run", "No query was executed, so no number is shown.")',
    "```",
  ].join("\n"),
];

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
  // No `preamble` and no `inlineMode`: OpenUI's own opener then states that the
  // entire response must be a program, which is the shape Tessera renders.
  const contract = analysisLibrary.prompt({
    additionalRules: [...analysisPresentationRules],
    examples: [...analysisPresentationExamples],
  });

  return `<analysis_view>
${contract}
</analysis_view>`;
}
