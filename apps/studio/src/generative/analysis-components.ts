/**
 * Presentation vocabulary shared by the Tessera Agent prompt and the Studio
 * renderer.
 *
 * This module is intentionally framework-free: it holds zod prop contracts and
 * prose descriptions only, so the Studio server can compile the model contract
 * while the browser builds the matching React renderers. Every component is a
 * pure presentation primitive — no data access, no SQL, no URLs, no arbitrary
 * markup, no callbacks.
 */
import { z } from "zod";

export type AnalysisComponentSpec = Readonly<{
  name: string;
  description: string;
  props: z.ZodObject<z.ZodRawShape>;
}>;

/** Tones shared by every tone-aware component. */
export const analysisTones = ["neutral", "positive", "warning", "critical"] as const;
export type AnalysisTone = (typeof analysisTones)[number];

const tone = z.enum(analysisTones);
/** Models write an explicit `null` for a skipped positional argument, so optional enums accept it. */
const optionalTone = tone.nullable().optional();
const requiredTone = tone.nullable();
const gap = z.enum(["tight", "normal", "loose"]);

/**
 * Layout primitives accept any analysis block, so their `children` schema is
 * built from the leaf component refs by the library factory.
 */
export function buildAnalysisLayoutSpecs(block: z.ZodType): readonly AnalysisComponentSpec[] {
  return [
    {
      name: "Stack",
      description: "The root container. Lays blocks out vertically in reading order.",
      props: z.object({
        children: z.array(block).describe("Ordered analysis blocks."),
        gap: gap.optional(),
      }),
    },
    {
      name: "Grid",
      description: "Lays sibling blocks out in a responsive grid. Use for a row of metrics.",
      props: z.object({
        children: z.array(block).describe("Analysis blocks shown side by side."),
        columns: z.number().int().min(1).max(4).optional().describe("Preferred column count, 1 to 4. Defaults to 2."),
      }),
    },
    {
      name: "Section",
      description: "A titled group of blocks that belong to one part of the answer.",
      props: z.object({
        title: z.string(),
        children: z.array(block).describe("Analysis blocks inside this section."),
        description: z.string().optional().describe("One line explaining what the section covers."),
      }),
    },
  ];
}

/** Leaf blocks. Order here is the order shown in the generated model contract. */
export const analysisLeafSpecs = [
  {
    name: "Metric",
    description:
      "One headline number with an optional change indicator and a short caption. Use for a single verified value, not for a list.",
    props: z.object({
      label: z.string().describe("What the number measures."),
      value: z.string().describe("The formatted value exactly as returned by a tool result."),
      delta: z.string().optional().describe("Change versus the comparison period, including its basis, e.g. \"+8.3% vs Q1\"."),
      hint: z.string().optional().describe("One short line of scope or caveat."),
      tone: optionalTone.describe("Emphasis for the value. Defaults to neutral."),
    }),
  },
  {
    name: "Table",
    description:
      "A comparison table. Use when the answer is a set of records with two or more attributes, or as the accessible equivalent of a chart.",
    props: z.object({
      title: z.string(),
      columns: z.array(z.string()).describe("Header labels in display order."),
      rows: z.array(z.array(z.string())).describe("Row values. Every row must have exactly one entry per column."),
      note: z.string().optional().describe("Scope, filter, or limitation for the whole table."),
    }),
  },
  {
    name: "Ranking",
    description:
      "An ordered list of items scored by one measure. Use for top-N or bottom-N questions. Pass labels and values as two parallel arrays in the same order.",
    props: z.object({
      title: z.string(),
      labels: z.array(z.string()).describe("Item names, highest first."),
      values: z.array(z.number()).describe("Numeric measure per label, same order and length as labels."),
      unit: z.string().optional().describe("Short unit suffix, e.g. \"orders\" or \"%\"."),
      note: z.string().optional(),
    }),
  },
  {
    name: "BarChart",
    description:
      "Vertical bars for one measure across categorical buckets. Use for a small number of discrete categories. Pass categories and values as two parallel arrays.",
    props: z.object({
      title: z.string(),
      categories: z.array(z.string()).describe("Bucket labels in display order."),
      values: z.array(z.number()).describe("Numeric value per category, same order and length as categories."),
      unit: z.string().optional().describe("Short unit suffix for the axis, e.g. \"USD\" or \"count\"."),
      note: z.string().optional(),
    }),
  },
  {
    name: "LineChart",
    description:
      "A line for one measure over an ordered time bucket. Use for trends. Pass categories and values as two parallel arrays.",
    props: z.object({
      title: z.string(),
      categories: z.array(z.string()).describe("Ordered bucket labels such as dates or months, earliest first."),
      values: z.array(z.number()).describe("Numeric value per bucket, same order and length as categories."),
      unit: z.string().optional(),
      note: z.string().optional(),
    }),
  },
  {
    name: "Insight",
    description:
      "A short written interpretation of verified results. Use after the data blocks to state what the numbers mean.",
    props: z.object({
      title: z.string(),
      summary: z.string().describe("One or two sentences. Only claims supported by tool results."),
      points: z.array(z.string()).optional().describe("Supporting observations, one per list item."),
      tone: optionalTone,
    }),
  },
  {
    name: "Callout",
    description:
      "A single emphasized message. Use for limitations, empty results, partial or truncated coverage, denied access, and unresolved ambiguity.",
    props: z.object({
      tone: requiredTone.describe("Use warning or critical for anything that limits the answer."),
      title: z.string(),
      body: z.string(),
    }),
  },
] as const satisfies readonly AnalysisComponentSpec[];

/** Order shown in the generated model contract. */
export const analysisComponentGroups = [
  { name: "Layout", components: ["Stack", "Grid", "Section"] },
  { name: "Data", components: ["Metric", "Table", "Ranking", "BarChart", "LineChart"] },
  { name: "Narrative", components: ["Insight", "Callout"] },
] as const;

/** Root component of every generated analysis view. */
export const ANALYSIS_ROOT_COMPONENT = "Stack";

export const analysisComponentSpec = (name: string): AnalysisComponentSpec | undefined =>
  analysisLeafSpecs.find((spec) => spec.name === name);
