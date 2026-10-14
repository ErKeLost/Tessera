/**
 * The Agent-facing answer contract for the Studio's OpenUI library.
 *
 * The library that renders an answer in the browser and the contract the Agent
 * is taught come from one place
 * (`src/client/components/generative/shadcn-genui`), so a component can never
 * be taught without being renderable. The contract text is compiled by
 * `scripts/generate-openui-prompt.ts` rather than computed here, which keeps
 * the Agent bundle free of React and every design-system dependency.
 */
import { OPENUI_SYSTEM_PROMPT } from "./openui-system-prompt.generated";

/** Root component of every generated answer. */
export const ANALYSIS_ROOT = "Card";

/**
 * The block of agent instructions that teaches the answer language. Appended to
 * the Agent's static policy as the host-owned presentation contract.
 */
export function buildAnalysisPresentationPrompt(): string {
  return `<analysis_view>
${OPENUI_SYSTEM_PROMPT}
</analysis_view>`;
}
