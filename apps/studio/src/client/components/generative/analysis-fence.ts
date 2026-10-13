/**
 * Splits an assistant message into prose and the analysis view program.
 *
 * The model is told to emit at most one `openui-lang` fenced block. Everything
 * outside it stays Markdown for the chat surface; everything inside it is the
 * program handed to the analysis renderer. An unterminated trailing fence is
 * treated as a program still streaming in.
 */
const OPENING_FENCE = /^[ \t]*```([A-Za-z0-9_-]*)[ \t]*$/u;
const CLOSING_FENCE = /^[ \t]*```[ \t]*$/u;

export const ANALYSIS_FENCE_LANGUAGE = "openui-lang";

export type AnalysisFenceSplit = Readonly<{ prose: string; code: string }>;

export function splitAnalysisFence(text: string): AnalysisFenceSplit {
  const prose: string[] = [];
  const code: string[] = [];
  let insideAnalysis = false;
  let skipBlank = false;

  for (const line of text.split("\n")) {
    if (insideAnalysis) {
      if (CLOSING_FENCE.test(line)) {
        insideAnalysis = false;
        // The blank line that separated the fence from the prose is not prose.
        skipBlank = true;
        continue;
      }
      code.push(line);
      continue;
    }

    if (skipBlank) {
      skipBlank = false;
      if (line.trim().length === 0) continue;
    }

    const opening = OPENING_FENCE.exec(line);
    if (opening !== null && (opening[1] ?? "").toLocaleLowerCase("en-US") === ANALYSIS_FENCE_LANGUAGE) {
      insideAnalysis = true;
      continue;
    }

    prose.push(line);
  }

  return { prose: prose.join("\n").trim(), code: code.join("\n").trim() };
}
