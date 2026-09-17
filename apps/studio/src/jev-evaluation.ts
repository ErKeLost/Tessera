import { createGateway, experimental_evaluate as evaluate } from "ai";
import { z } from "zod";

const text = z.string().trim().min(1).max(4_000);
const question = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions: text, criteria: z.object({ true: text, false: text }).optional() }).strict(),
  z.object({ type: z.literal("choice"), instructions: text, criteria: z.record(text, text).refine((v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 20) }).strict(),
  z.object({ type: z.literal("score"), instructions: text, criteria: z.array(text).min(2).max(20) }).strict(),
]);

export const jevEvaluationInputSchema = z.object({
  state: z.union([z.string().trim().min(1).max(32_000), z.record(z.string(), z.json()), z.array(z.json())])
    .refine((v) => JSON.stringify(v).length <= 32_000),
  questions: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), question)
    .refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 20),
}).strict();

/** Evaluation has its own SDK protocol; never send it to chat/completions. */
export async function evaluateJev(
  input: z.infer<typeof jevEvaluationInputSchema>,
  options: { apiKey: string; signal?: AbortSignal; fetch?: NonNullable<Parameters<typeof createGateway>[0]>["fetch"] },
) {
  const gateway = createGateway({ apiKey: options.apiKey, fetch: options.fetch });
  const timeout = AbortSignal.timeout(30_000);
  const result = await evaluate({
    model: gateway.evaluationModel("typesafe-ai/jev"),
    ...input,
    maxRetries: 0,
    abortSignal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  // Exclude raw provider metadata, response headers and request details.
  return { model: "typesafe-ai/jev", answers: result.answers, usage: result.usage };
}
