import { generateSystemPrompt } from "@openuidev/lang-core";
import {
  shadcnChatLibrary,
  shadcnPromptOptions,
} from "../client/components/generative/shadcn-genui";
import {
  answerDatabaseActionPromptRules,
  answerDatabaseActionToolExamples,
  answerDatabaseActionToolSpec,
  answerReadOnlyPromptRules,
  answerReadPromptRules,
  answerReadToolExamples,
  answerRelationMetricsToolSpec,
  answerRelationPreviewToolSpec,
} from "./openui-answer-tools";

/**
 * Compiles the two answer contracts from one library and one tool set.
 *
 * - `base`: read-only. It teaches `relation_preview` and `relation_metrics` and
 *   explicitly forbids mutations, so a Studio that cannot change data never
 *   teaches a write tool.
 * - `actions`: read-write. It adds the governed `database_action` tool.
 *
 * The build script and the sync test both call this, so a library change that
 * was not recompiled fails the test instead of shipping a stale contract.
 */
export type CompiledAnswerPrompts = Readonly<{ base: string; actions: string }>;

export function compileAnswerPrompts(): CompiledAnswerPrompts {
  const library = shadcnChatLibrary.toSpec();
  const readRules = [
    ...(shadcnPromptOptions.additionalRules ?? []),
    ...answerReadPromptRules(),
  ];
  const readTools = [
    answerRelationPreviewToolSpec(),
    answerRelationMetricsToolSpec(),
  ];
  const readExamples = answerReadToolExamples();

  return {
    base: generateSystemPrompt({
      library,
      promptOptions: {
        ...shadcnPromptOptions,
        additionalRules: [...readRules, ...answerReadOnlyPromptRules()],
        tools: readTools,
        toolExamples: readExamples,
      },
    }),
    actions: generateSystemPrompt({
      library,
      promptOptions: {
        ...shadcnPromptOptions,
        additionalRules: [...readRules, ...answerDatabaseActionPromptRules()],
        tools: [...readTools, answerDatabaseActionToolSpec()],
        toolExamples: [...readExamples, ...answerDatabaseActionToolExamples()],
      },
    }),
  };
}
