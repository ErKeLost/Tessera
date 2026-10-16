/**
 * Identities shared by the answer prompt, the browser tool provider, and the
 * server routes. They live in a React-free, dependency-free module so the build
 * script and the client agree on one name without pulling server code into the
 * browser bundle.
 */
export const ANSWER_RELATION_PREVIEW_TOOL = "relation_preview";
export const ANSWER_RELATION_METRICS_TOOL = "relation_metrics";
export const ANSWER_DATABASE_ACTION_TOOL = "database_action";
