/**
 * The Answer Data Plane: the server-side surface an OpenUI answer talks to.
 *
 * Layers:
 * - `contracts` — wire schemas, result types, and the domain error (no side effects)
 * - `read`      — `relation_preview` / `relation_metrics` execution and SQL compilation
 * - `write`     — catalog-envelope composition and governed mutation submission
 *
 * `server.ts` owns transport and error mapping; the prompt tool specs are derived
 * from `contracts` in `generative/openui-answer-tools.ts`.
 */
export * from "./contracts";
export {
  answerPreviewCell,
  compileRelationMetricsSql,
  executeRelationMetrics,
  executeRelationPreview,
  findCatalogTable,
  type CompiledRelationMetrics,
  type CompileRelationMetricsInput,
  type ExecuteRelationMetricsInput,
  type ExecuteRelationPreviewInput,
} from "./read";
export {
  composeAnswerDatabaseAction,
  submitAnswerDatabaseAction,
  type AnswerActionCatalog,
  type SubmitAnswerDatabaseActionInput,
} from "./write";
