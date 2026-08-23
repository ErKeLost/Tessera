import type { HashProvider } from "@open-generative/protocol";
import { z } from "zod";
import {
  officialChartAccessibilityFixtures,
  officialChartSpecFixtures,
  officialRendererExpectationFixtures,
} from "./chart-fixtures";
import { officialChartRecipeDefinitions } from "./chart-recipes";
import { chartRecipeSchema, chartRecipes } from "./chart-spec";
import { officialComponentTypes, officialComponentTypeSchema } from "./fixtures";
import { hashNamespacedCanonical } from "./integrity";
import { deepFreeze } from "./schema";

export const TESSERA_PROOF_VERSION = "2026-08-22" as const;
export const proofTaskFamilies = chartRecipes;
export const proofTaskFamilySchema = chartRecipeSchema;
export type ProofTaskFamily = z.infer<typeof proofTaskFamilySchema>;

export const proofAssertionTokens = [
  "accessible-equivalent-view",
  "exact-recipe",
  "no-inline-payload",
  "resource-semantics-preserved",
] as const;
export const proofAssertionTokenSchema = z.enum(proofAssertionTokens);

const modelSafeColumnSchema = z.object({
  columnId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/),
  label: z.string().trim().min(1).max(256),
  valueType: z.enum(["boolean", "date", "datetime", "number", "string"]),
}).strict();

export const goldenResourceDescriptorSchema = z.object({
  bindingId: z.string().regex(/^binding\.[a-z0-9.-]+$/),
  offerHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  kind: z.literal("dataset"),
  label: z.string().trim().min(1).max(256),
  columns: z.array(modelSafeColumnSchema).min(1).max(32),
  estimatedItems: z.number().int().nonnegative(),
}).strict();

export const goldenPromptCaseSchema = z.object({
  caseId: z.string().regex(/^golden\.[0-9]{3}\.[a-z0-9-]+$/),
  proofVersion: z.literal(TESSERA_PROOF_VERSION),
  family: proofTaskFamilySchema,
  prompt: z.string().trim().min(12).max(1_024),
  resource: goldenResourceDescriptorSchema,
  expected: z.object({
    primaryView: officialComponentTypeSchema,
    components: z.tuple([officialComponentTypeSchema]),
    recipe: chartRecipeSchema,
    assertions: z.array(proofAssertionTokenSchema).length(proofAssertionTokens.length),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.family !== value.expected.recipe) {
    context.addIssue({ code: "custom", path: ["expected", "recipe"], message: "The expected recipe must match the task family." });
  }
});
export type GoldenPromptCase = z.infer<typeof goldenPromptCaseSchema>;

function fixedHash(seed: number): `sha256:${string}` {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

export const officialGoldenPromptCases = deepFreeze(officialChartSpecFixtures.map((fixture, index) => (
  goldenPromptCaseSchema.parse({
    caseId: `golden.${String(index + 1).padStart(3, "0")}.${fixture.recipeName}`,
    proofVersion: TESSERA_PROOF_VERSION,
    family: fixture.recipeName,
    prompt: `Render the governed dataset as the ${fixture.recipeName} Data Chart recipe.`,
    resource: {
      bindingId: `binding.${fixture.recipeName}`,
      offerHash: fixedHash(index + 1),
      kind: "dataset",
      label: fixture.spec.title,
      columns: fixture.dataset.columns,
      estimatedItems: fixture.dataset.totalRows ?? fixture.dataset.rows.length,
    },
    expected: {
      primaryView: "data.chart",
      components: ["data.chart"],
      recipe: fixture.recipeName,
      assertions: [...proofAssertionTokens],
    },
  })
)));

export const noPayloadChannels = ["prompt", "tool-result", "wire-history", "message-history", "observability"] as const;
export const noPayloadChannelSchema = z.enum(noPayloadChannels);
export const noPayloadFixtureSchema = z.object({
  fixtureId: z.string().regex(/^no-payload\.[a-z-]+$/),
  channel: noPayloadChannelSchema,
  value: z.unknown(),
}).strict();

export const officialNoPayloadFixtures = deepFreeze([
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.prompt",
    channel: "prompt",
    value: officialGoldenPromptCases.map(({ caseId, prompt, resource }) => ({ caseId, prompt, resource })),
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.tool-result",
    channel: "tool-result",
    value: { status: "published", bindingId: "binding.chart", descriptor: { estimatedItems: 24 } },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.wire-history",
    channel: "wire-history",
    value: { documentId: "document-proof", revisionId: "revision-proof", resourceBindingIds: ["binding.chart"] },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.message-history",
    channel: "message-history",
    value: { role: "assistant", text: "The governed chart is available.", surfaceRevisionRef: "revision-proof" },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.observability",
    channel: "observability",
    value: { event: "surface.revision-committed", contentHash: fixedHash(9_999), itemCount: 24 },
  }),
]);

const prohibitedPayloadKeys = new Set([
  "accesstoken",
  "credential",
  "grant",
  "grantid",
  "password",
  "payload",
  "rawresult",
  "records",
  "resourcekey",
  "rows",
  "samplerows",
  "servercursor",
]);
const prohibitedStringPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:postgres|postgresql|mysql|mongodb):\/\//i,
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
] as const;

export type NoPayloadIssue = Readonly<{
  code: "prohibited-key" | "credential-like-string";
  path: string;
}>;

export function scanNoPayload(input: unknown): readonly NoPayloadIssue[] {
  const issues: NoPayloadIssue[] = [];
  const visit = (value: unknown, path: string, ancestors: Set<object>) => {
    if (typeof value === "string") {
      if (prohibitedStringPatterns.some((pattern) => pattern.test(value))) issues.push({ code: "credential-like-string", path });
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw new TypeError(`Cannot scan cyclic proof fixture at ${path}.`);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, ancestors));
      } else {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          const keyPath = `${path}.${key}`;
          const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
          if (prohibitedPayloadKeys.has(normalized)) issues.push({ code: "prohibited-key", path: keyPath });
          visit(nested, keyPath, ancestors);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  };
  visit(input, "$", new Set());
  return deepFreeze(issues);
}

export function assertNoPayload(input: unknown): void {
  const issues = scanNoPayload(input);
  if (issues.length > 0) throw new TypeError(`No-payload proof failed: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`);
}

export const deterministicProofReportSchema = z.object({
  proofVersion: z.literal(TESSERA_PROOF_VERSION),
  goldenCaseCount: z.literal(17),
  taskFamilyCounts: z.record(proofTaskFamilySchema, z.literal(1)),
  componentContractCount: z.literal(1),
  chartRecipeCount: z.literal(17),
  rendererExpectationCount: z.literal(17),
  accessibilityFixtureCount: z.literal(17),
  noPayloadFixtureCount: z.literal(5),
  goldenCasesHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  chartCoverageHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  noPayloadFixturesHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type DeterministicProofReport = z.infer<typeof deterministicProofReportSchema>;

export async function createDeterministicProofReport(provider?: HashProvider): Promise<DeterministicProofReport> {
  for (const fixture of officialNoPayloadFixtures) assertNoPayload(fixture.value);
  const taskFamilyCounts = Object.fromEntries(proofTaskFamilies.map((family) => [family, 1]));
  return deepFreeze(deterministicProofReportSchema.parse({
    proofVersion: TESSERA_PROOF_VERSION,
    goldenCaseCount: officialGoldenPromptCases.length,
    taskFamilyCounts,
    componentContractCount: officialComponentTypes.length,
    chartRecipeCount: officialChartRecipeDefinitions.length,
    rendererExpectationCount: officialRendererExpectationFixtures.length,
    accessibilityFixtureCount: officialChartAccessibilityFixtures.length,
    noPayloadFixtureCount: officialNoPayloadFixtures.length,
    goldenCasesHash: await hashNamespacedCanonical("open-generative.proof.golden-cases", officialGoldenPromptCases, provider),
    chartCoverageHash: await hashNamespacedCanonical("open-generative.proof.chart-coverage", {
      definitions: officialChartRecipeDefinitions,
      specs: officialChartSpecFixtures,
      renderers: officialRendererExpectationFixtures,
      accessibility: officialChartAccessibilityFixtures,
    }, provider),
    noPayloadFixturesHash: await hashNamespacedCanonical("open-generative.proof.no-payload", officialNoPayloadFixtures, provider),
  }));
}

export async function verifyDeterministicProofReport(input: unknown, provider?: HashProvider): Promise<DeterministicProofReport> {
  const report = deterministicProofReportSchema.parse(input);
  const expected = await createDeterministicProofReport(provider);
  if (JSON.stringify(report) !== JSON.stringify(expected)) throw new TypeError("Deterministic proof report does not match the current versioned fixtures.");
  return report;
}
