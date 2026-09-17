import { expect, test } from "bun:test";
import { evaluateJev, jevEvaluationInputSchema } from "./jev-evaluation";

test("Jev uses the native evaluation protocol and returns only answers and usage", async () => {
  const input = jevEvaluationInputSchema.parse({
    state: { order: { status: "refunded" } },
    questions: {
      refunded: { type: "boolean", instructions: "Was a refund issued?" },
      route: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", support: "Other" } },
      quality: { type: "score", instructions: "Rate quality", criteria: ["poor", "good"] },
    },
  });
  let calls = 0;
  const result = await evaluateJev(input, {
    apiKey: "test-vercel-secret",
    fetch: Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-vercel-secret");
      expect(headers.get("ai-model-id")).toBe("typesafe-ai/jev");
      expect(JSON.parse(init?.body as string)).toMatchObject(input);
      return Response.json({
        answers: {
          refunded: { type: "boolean", probability: 0.99 },
          route: { type: "choice", choice: "billing", probabilities: { billing: 1, support: 0 } },
          quality: { type: "score", score: 1 },
        },
        usage: { inputTokens: 20, outputTokens: 5 },
        providerMetadata: { private: { key: "test-vercel-secret" } },
      });
    }, { preconnect: fetch.preconnect }),
  });
  expect(calls).toBe(1);
  expect(result.model).toBe("typesafe-ai/jev");
  expect(result.answers.refunded).toEqual({ type: "boolean", probability: 0.99 });
  expect(result.usage.inputTokens).toBe(20);
  expect(JSON.stringify(result)).not.toContain("test-vercel-secret");
  expect(result).not.toHaveProperty("response");
});

test("Jev input rejects empty questions, unsupported types and oversized state", () => {
  expect(jevEvaluationInputSchema.safeParse({ state: "hello", questions: {} }).success).toBe(false);
  expect(jevEvaluationInputSchema.safeParse({ state: "hello", questions: { a: { type: "text", instructions: "Explain" } } }).success).toBe(false);
  expect(jevEvaluationInputSchema.safeParse({ state: "x".repeat(32_001), questions: { a: { type: "boolean", instructions: "OK?" } } }).success).toBe(false);
});
