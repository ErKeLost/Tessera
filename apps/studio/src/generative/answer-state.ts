/** Browser state is kept separate from model memory and database authority. */
export type AnswerState = Record<string, unknown>;
export const MAX_ANSWER_STATE_BYTES = 32_768;

export function isAnswerState(value: unknown): value is AnswerState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > MAX_ANSWER_STATE_BYTES) return false;
    const visit = (node: unknown, depth: number): boolean => {
      if (depth > 12) return false;
      if (node === null || typeof node === "string" || typeof node === "boolean") return true;
      if (typeof node === "number") return Number.isFinite(node);
      if (Array.isArray(node)) return node.length <= 1_000 && node.every((item) => visit(item, depth + 1));
      return typeof node === "object" && Object.entries(node).every(([key, item]) =>
        key !== "__proto__" && key !== "constructor" && key !== "prototype" && visit(item, depth + 1));
    };
    return visit(value, 0);
  } catch { return false; }
}
