import { defineFunction } from "@openuidev/react-lang";
import { z } from "zod";

/**
 * Deterministic helpers the model can call inside a program.
 *
 * The point is arithmetic the model is bad at: shares and period-over-period
 * change are computed here, formatted once, and rendered as text, so a number
 * in an answer can never be a hallucinated ratio. Every function degrades to
 * the string "n/a" instead of throwing, because a throw would surface as a
 * runtime error on every streamed chunk.
 */
const UNKNOWN = "n/a";

export const percentFunction = defineFunction({
  name: "Percent",
  description:
    'Format a part of a total as a whole-number percentage, e.g. @Percent(3, 4) -> "75%". Use it for share-of-total labels instead of computing the ratio yourself.',
  params: z.object({ part: z.number(), total: z.number() }),
  returns: z.string(),
  fn: ({ part, total }) => {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) return UNKNOWN;
    return `${Math.round((part / total) * 100)}%`;
  },
});

export const deltaFunction = defineFunction({
  name: "Delta",
  description:
    'Format the change from an earlier value to the current one as a signed percentage, e.g. @Delta(112, 100) -> "+12%". Use it for period-over-period trends. Returns "n/a" when the earlier value is zero.',
  params: z.object({ current: z.number(), previous: z.number() }),
  returns: z.string(),
  fn: ({ current, previous }) => {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return UNKNOWN;
    const change = ((current - previous) / Math.abs(previous)) * 100;
    const rounded = Math.round(change * 10) / 10;
    return `${rounded > 0 ? "+" : ""}${rounded}%`;
  },
});

export const formatNumberFunction = defineFunction({
  name: "FormatNumber",
  description:
    'Format a number with thousands separators, e.g. @FormatNumber(1670) -> "1,670". Optional decimals between 0 and 3 (default 0).',
  params: z.object({
    value: z.number(),
    decimals: z.number().int().min(0).max(3).optional(),
  }),
  returns: z.string(),
  fn: ({ value, decimals }) => {
    if (!Number.isFinite(value)) return UNKNOWN;
    const digits = decimals ?? 0;
    return value.toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  },
});

/** Every function the answer library exposes to the model. */
export const answerFunctions = [percentFunction, deltaFunction, formatNumberFunction];
