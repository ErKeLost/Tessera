/**
 * The Agent-facing answer contract for the Studio's OpenUI library.
 *
 * The library that renders an answer in the browser and the contract the Agent
 * is taught come from one place
 * (`src/client/components/generative/shadcn-genui`), so a component can never
 * be taught without being renderable. The contract text is compiled by
 * `scripts/generate-openui-prompt.ts` rather than computed here, which keeps
 * the Agent bundle free of React and every design-system dependency.
 *
 * Two compiled variants exist. The host picks the one that matches the live
 * access mode: a read-only Studio must never teach a write tool, and a
 * read-write Studio needs the governed action tool to offer a change the
 * reader triggers and the server approves.
 */
import {
  OPENUI_ACTION_SYSTEM_PROMPT,
  OPENUI_SYSTEM_PROMPT,
} from "./openui-system-prompt.generated";

/** Root component of every generated answer. */
export const ANALYSIS_ROOT = "Card";

export type AnalysisPresentationOptions = Readonly<{
  /** True when the Studio can execute governed database actions for this runtime. */
  databaseActions?: boolean;
}>;

/**
 * The block of agent instructions that teaches the answer language. Appended to
 * the Agent's static policy as the host-owned presentation contract.
 */
export function buildAnalysisPresentationPrompt(
  options: AnalysisPresentationOptions = {},
): string {
  const prompt = options.databaseActions === true
    ? OPENUI_ACTION_SYSTEM_PROMPT
    : OPENUI_SYSTEM_PROMPT;
  return `<analysis_view>\n${prompt}\n</analysis_view>`;
}
