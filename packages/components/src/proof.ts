import { z } from "zod";
import type { HashProvider } from "@open-generative/protocol";
import { officialChartAccessibilityFixtures, officialChartSpecFixtures, officialRendererExpectationFixtures } from "./chart-fixtures";
import { officialChartRecipeDefinitions } from "./chart-recipes";
import { officialComponentTypes, officialComponentTypeSchema } from "./fixtures";
import { hashNamespacedCanonical } from "./integrity";
import { deepFreeze } from "./schema";

export const TESSERA_PROOF_VERSION = "2026-08-22" as const;

export const proofTaskFamilies = [
  "kpi-overview",
  "time-trend",
  "category-comparison",
  "distribution",
  "detail-inspection",
  "filter-exploration",
  "empty-or-restricted",
  "query-audit",
  "streaming-create",
  "incremental-edit",
  "host-intent",
  "recovery-conflict",
] as const;
export const proofTaskFamilySchema = z.enum(proofTaskFamilies);
export type ProofTaskFamily = z.infer<typeof proofTaskFamilySchema>;

const proofAssertionTokens = [
  "accessible-equivalent-view",
  "empty-reason-explicit",
  "evidence-preserved",
  "host-intent-only",
  "last-good-preserved",
  "no-fabricated-reference",
  "no-inline-payload",
  "primary-view-correct",
  "resource-semantics-preserved",
  "responsive-layout",
  "selection-scope-preserved",
  "snapshot-operation-parity",
] as const;
export const proofAssertionTokenSchema = z.enum(proofAssertionTokens);

const modelSafeColumnSchema = z.object({
  columnId: z.string().regex(/^[a-z][a-z0-9._-]*$/),
  label: z.string().trim().min(1).max(128),
  valueType: z.enum(["string", "number", "date", "boolean"]),
  sensitivity: z.enum(["public", "private", "sensitive"]),
}).strict();

export const goldenResourceDescriptorSchema = z.object({
  bindingId: z.string().regex(/^binding\.[a-z0-9.-]+$/),
  offerHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evidenceId: z.string().regex(/^evidence\.[a-z0-9.-]+$/),
  evidenceOfferHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  kind: z.enum(["dataset", "record"]),
  label: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(512),
  columns: z.array(modelSafeColumnSchema).min(1).max(16),
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
    components: z.array(officialComponentTypeSchema).min(1).max(officialComponentTypes.length),
    assertions: z.array(proofAssertionTokenSchema).min(3).max(proofAssertionTokens.length),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!value.expected.components.includes(value.expected.primaryView)) {
    context.addIssue({ code: "custom", path: ["expected", "primaryView"], message: "Primary view must be in the expected component set." });
  }
  if (new Set(value.expected.components).size !== value.expected.components.length) {
    context.addIssue({ code: "custom", path: ["expected", "components"], message: "Expected components must be unique." });
  }
  if (new Set(value.expected.assertions).size !== value.expected.assertions.length) {
    context.addIssue({ code: "custom", path: ["expected", "assertions"], message: "Assertions must be unique." });
  }
});
export type GoldenPromptCase = z.infer<typeof goldenPromptCaseSchema>;

type TaskDefinition = Readonly<{
  family: ProofTaskFamily;
  primaryView: z.infer<typeof officialComponentTypeSchema>;
  components: readonly z.infer<typeof officialComponentTypeSchema>[];
  assertions: readonly z.infer<typeof proofAssertionTokenSchema>[];
  questions: readonly string[];
}>;

const taskDefinitions: readonly TaskDefinition[] = [
  {
    family: "kpi-overview",
    primaryView: "data.metric",
    components: ["layout.stack", "layout.grid", "layout.section", "content.text", "data.metric", "data.query-details"],
    assertions: ["primary-view-correct", "evidence-preserved", "no-fabricated-reference", "no-inline-payload", "responsive-layout"],
    questions: [
      "Summarize current monthly recurring revenue, growth, and active accounts for the executive review.",
      "Show this quarter's gross margin, revenue, and operating cost with clear comparisons to last quarter.",
      "Give me a compact overview of daily active users, conversion, and churn for the product meeting.",
      "Present bookings, pipeline coverage, and win rate for the weekly sales review.",
      "Summarize support volume, first response time, and resolution rate for operations.",
      "Show inventory value, stockout rate, and fulfillment time as a scannable overview.",
      "Present ad spend, attributed revenue, and return on ad spend without hiding the query evidence.",
      "Give me net retention, expansion revenue, and contraction revenue for the board update.",
      "Summarize orders, average order value, and repeat purchase rate for yesterday.",
      "Show cash collected, overdue invoices, and days sales outstanding for finance.",
    ],
  },
  {
    family: "time-trend",
    primaryView: "data.chart",
    components: ["layout.stack", "layout.section", "content.text", "data.metric", "data.chart", "data.table", "data.query-details"],
    assertions: ["primary-view-correct", "accessible-equivalent-view", "resource-semantics-preserved", "evidence-preserved", "no-inline-payload"],
    questions: [
      "Plot weekly revenue for the last six months and keep the exact weekly values available.",
      "Show daily signups and activations over the last 30 days, highlighting whether the trend changed.",
      "Compare monthly churn and expansion rates across the past year with an equivalent table.",
      "Visualize hourly checkout failures for the last seven days and preserve the source snapshot.",
      "Show the trend in median query latency by week and include the underlying aggregate values.",
      "Plot quarterly gross margin since 2024 and explain the latest movement without inventing causes.",
      "Show daily support backlog and resolved tickets over the last eight weeks.",
      "Visualize monthly active teams and seats per team with accessible exact values.",
      "Plot refund rate by day around the latest product release and retain query details.",
      "Show new versus returning customer revenue by month for the current year.",
    ],
  },
  {
    family: "category-comparison",
    primaryView: "data.chart",
    components: ["layout.stack", "layout.section", "content.text", "data.chart", "data.table", "content.callout"],
    assertions: ["primary-view-correct", "accessible-equivalent-view", "resource-semantics-preserved", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Compare revenue by region and show the ranking with exact values.",
      "Rank product plans by active subscriptions and monthly churn.",
      "Compare acquisition channels by spend, customers, and payback period.",
      "Show support issue volume by category and rank the largest categories.",
      "Compare warehouses by fulfillment time and late shipment rate.",
      "Rank account segments by net retention and expansion revenue.",
      "Compare device platforms by sessions, conversion, and crash rate.",
      "Show gross margin by product family without using misleading dual axes.",
      "Compare sales representatives by qualified pipeline and closed revenue.",
      "Rank countries by active users while preserving the exact aggregate table.",
    ],
  },
  {
    family: "distribution",
    primaryView: "data.chart",
    components: ["layout.stack", "layout.section", "content.text", "data.metric", "data.chart", "data.table", "content.callout"],
    assertions: ["primary-view-correct", "accessible-equivalent-view", "resource-semantics-preserved", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Show the distribution of order values using the provided buckets and summarize the median.",
      "Visualize query latency buckets and call out the long tail supported by the data.",
      "Show customer account sizes by seat-count bucket without treating raw records as aggregates.",
      "Present delivery times by duration bucket and include the exact bucket counts.",
      "Visualize session duration distribution and summarize the central range.",
      "Show invoice aging buckets with totals and an accessible table equivalent.",
      "Present deal sizes by provided revenue bands and identify concentration without fabricating detail.",
      "Show support resolution time buckets and preserve the query evidence.",
      "Visualize product usage frequency bands for active accounts.",
      "Show refund amounts by supplied bucket and summarize the observed skew.",
    ],
  },
  {
    family: "detail-inspection",
    primaryView: "data.table",
    components: ["layout.stack", "layout.section", "content.text", "data.table", "data.query-details", "control.filter", "control.group"],
    assertions: ["primary-view-correct", "resource-semantics-preserved", "evidence-preserved", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Let me inspect the latest failed payments with sortable columns and query details.",
      "Show the governed customer accounts behind the churn alert with pagination.",
      "List overdue invoices and let me sort by amount and due date.",
      "Inspect recent high-latency queries while keeping SQL visibility policy-controlled.",
      "Show open support cases with owner, priority, age, and current status.",
      "List orders delayed more than two days using the supplied result window.",
      "Inspect expansion opportunities with account, owner, value, and renewal date.",
      "Show recent product errors with release, platform, count, and last observed time.",
      "List inventory items below reorder level without loading all records into the document.",
      "Inspect campaign conversions with source, campaign, cost, and attributed revenue.",
    ],
  },
  {
    family: "filter-exploration",
    primaryView: "control.filter",
    components: ["layout.stack", "layout.grid", "layout.section", "control.group", "control.filter", "data.metric", "data.chart", "data.table"],
    assertions: ["primary-view-correct", "resource-semantics-preserved", "host-intent-only", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Add a governed region filter so I can explore revenue and orders by region.",
      "Let me filter churn metrics by plan and customer segment using offered options only.",
      "Add a date range control for the acquisition dashboard and re-resolve the resource on apply.",
      "Let me filter support performance by team, priority, and channel.",
      "Add warehouse and carrier filters to the fulfillment comparison.",
      "Let me explore product usage by platform and app version.",
      "Add sales owner and stage filters to the pipeline analysis.",
      "Let me filter invoice aging by legal entity and account owner.",
      "Add campaign and channel controls to the marketing efficiency view.",
      "Let me filter reliability metrics by service and deployment environment.",
    ],
  },
  {
    family: "empty-or-restricted",
    primaryView: "content.empty",
    components: ["layout.stack", "layout.section", "content.empty", "content.callout"],
    assertions: ["primary-view-correct", "empty-reason-explicit", "no-fabricated-reference", "no-inline-payload", "last-good-preserved"],
    questions: [
      "Show the analysis result when the current filters return no matching records.",
      "Explain that this dataset is unavailable because the resource grant expired.",
      "Present the denied query result without leaking restricted column metadata.",
      "Show a retryable unavailable state for a temporary resource failure.",
      "Explain that the requested resource version is no longer retained.",
      "Present an empty state when the selected date range contains no observations.",
      "Show a schema-incompatible state without substituting generated sample data.",
      "Explain that a revoked grant prevents this analysis from being displayed.",
      "Present a not-found state for a removed governed resource.",
      "Show an unconfigured state when the host did not offer a required binding.",
    ],
  },
  {
    family: "query-audit",
    primaryView: "data.query-details",
    components: ["layout.stack", "layout.section", "content.text", "content.callout", "data.query-details", "data.table"],
    assertions: ["primary-view-correct", "evidence-preserved", "resource-semantics-preserved", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Show how this revenue result was produced, including allowed SQL, lineage, freshness, and evidence.",
      "Let me audit the source and observation time behind the churn metric.",
      "Present query duration, row count, lineage, and snapshot evidence for this chart.",
      "Show the policy-visible query details behind the inventory alert.",
      "Explain the freshness and evidence chain for the support backlog result.",
      "Let me inspect the query and source tables behind this pipeline total.",
      "Show whether this margin result is fresh and what evidence snapshot supports it.",
      "Present the query audit trail for the failed payment analysis.",
      "Show lineage and evidence for the acquisition attribution result.",
      "Let me verify the resource snapshot used by the reliability report.",
    ],
  },
  {
    family: "streaming-create",
    primaryView: "layout.stack",
    components: ["layout.stack", "layout.section", "content.text", "data.metric", "data.chart", "data.table"],
    assertions: ["primary-view-correct", "last-good-preserved", "snapshot-operation-parity", "resource-semantics-preserved", "no-inline-payload"],
    questions: [
      "Build the revenue overview progressively while keeping data components atomic until resolved.",
      "Stream a product health analysis without exposing interactive controls in preview nodes.",
      "Create the support operations view one complete entity at a time.",
      "Build the fulfillment analysis progressively and preserve the previous committed surface on failure.",
      "Stream the acquisition dashboard using complete operations rather than partial props.",
      "Create the churn analysis with a readable layout before governed data nodes commit.",
      "Stream the finance overview while keeping the exact table atomic.",
      "Build the pipeline review progressively with deterministic preview replacement.",
      "Create the reliability report while preserving last-good through an interrupted stream.",
      "Stream the inventory overview and invalidate the whole preview if final validation fails.",
    ],
  },
  {
    family: "incremental-edit",
    primaryView: "layout.section",
    components: ["layout.stack", "layout.grid", "layout.section", "content.text", "content.callout", "data.metric", "data.chart", "data.table"],
    assertions: ["primary-view-correct", "selection-scope-preserved", "snapshot-operation-parity", "last-good-preserved", "no-inline-payload"],
    questions: [
      "Add an exact-value table beneath the selected revenue chart without replacing the rest of the surface.",
      "Change the selected comparison section to a horizontal bar view and preserve its evidence.",
      "Add a warning callout to the selected churn section using the current revision precondition.",
      "Reorder the selected KPI grid without changing metric identities.",
      "Replace only the selected trend chart with an area representation of the same resource.",
      "Add query details to the selected analysis section without widening the write scope.",
      "Remove the selected explanatory caption and leave the data nodes untouched.",
      "Add a second metric to the selected overview using a new transaction-local identity.",
      "Update the selected section title while preserving all child node identities.",
      "Insert a governed filter group before the selected breakdown section.",
    ],
  },
  {
    family: "host-intent",
    primaryView: "data.table",
    components: ["layout.stack", "layout.section", "content.empty", "control.group", "control.filter", "data.table", "data.query-details"],
    assertions: ["primary-view-correct", "host-intent-only", "evidence-preserved", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Let me export the governed table as CSV through the host action.",
      "Add an XLSX export command for the current query result without creating a download URL in props.",
      "Let me retry the unavailable resource through the declared retry intent.",
      "Add an explicit apply action for the current filter group.",
      "Let me export the policy-visible query details as JSON.",
      "Trigger a row selection intent without executing arbitrary browser code.",
      "Let me apply the date range filter with state revision preconditions.",
      "Add a retry action to the temporary unavailable state.",
      "Let me request the next table window through the host resource capability.",
      "Add a governed sort change intent for the revenue column.",
    ],
  },
  {
    family: "recovery-conflict",
    primaryView: "content.callout",
    components: ["layout.stack", "layout.section", "content.text", "content.callout", "content.empty"],
    assertions: ["primary-view-correct", "last-good-preserved", "snapshot-operation-parity", "no-fabricated-reference", "no-inline-payload"],
    questions: [
      "Recover the surface after a sequence gap by requesting a trusted snapshot.",
      "Keep the last committed analysis visible when an edit conflicts with a newer revision.",
      "Resume after disconnect using the actor-bound cursor without treating it as a grant.",
      "Discard the preview when the stream epoch changes and restore the trusted snapshot.",
      "Show a conflict state when the branch head precondition no longer matches.",
      "Recover from an expired cursor with a fresh authorized snapshot.",
      "Preserve last-good when a transaction times out before finalize.",
      "Reject a replayed event whose payload hash differs from the remembered event.",
      "Request resynchronization when buffered events exceed the declared sequence gap.",
      "Clear the whole preview overlay after an abort and keep the committed surface interactive.",
    ],
  },
] as const;

const columnProfiles: Readonly<Record<ProofTaskFamily, readonly z.infer<typeof modelSafeColumnSchema>[]>> = {
  "kpi-overview": [column("metric", "Metric", "string"), column("current", "Current", "number"), column("comparison", "Comparison", "number")],
  "time-trend": [column("period", "Period", "date"), column("primary", "Primary measure", "number"), column("comparison", "Comparison measure", "number")],
  "category-comparison": [column("category", "Category", "string"), column("value", "Value", "number"), column("rank", "Rank", "number")],
  distribution: [column("bucket", "Bucket", "string"), column("count", "Count", "number"), column("share", "Share", "number")],
  "detail-inspection": [column("record_id", "Record", "string", "private"), column("status", "Status", "string"), column("amount", "Amount", "number")],
  "filter-exploration": [column("dimension", "Dimension", "string"), column("measure", "Measure", "number"), column("period", "Period", "date")],
  "empty-or-restricted": [column("status", "Status", "string")],
  "query-audit": [column("query_id", "Query", "string", "private"), column("observed_at", "Observed at", "date"), column("duration_ms", "Duration", "number")],
  "streaming-create": [column("period", "Period", "date"), column("value", "Value", "number")],
  "incremental-edit": [column("dimension", "Dimension", "string"), column("value", "Value", "number")],
  "host-intent": [column("record_id", "Record", "string", "private"), column("value", "Value", "number")],
  "recovery-conflict": [column("status", "Status", "string")],
};

function column(
  columnId: string,
  label: string,
  valueType: z.infer<typeof modelSafeColumnSchema>["valueType"],
  sensitivity: z.infer<typeof modelSafeColumnSchema>["sensitivity"] = "public",
) {
  return modelSafeColumnSchema.parse({ columnId, label, valueType, sensitivity });
}

function fixedHash(seed: number): `sha256:${string}` {
  return `sha256:${seed.toString(16).padStart(64, "0")}`;
}

const goldenCases = taskDefinitions.flatMap((definition, familyIndex) => (
  definition.questions.map((prompt, questionIndex) => {
    const ordinal = familyIndex * 10 + questionIndex + 1;
    const suffix = `${definition.family}-${questionIndex + 1}`;
    return goldenPromptCaseSchema.parse({
      caseId: `golden.${String(ordinal).padStart(3, "0")}.${suffix}`,
      proofVersion: TESSERA_PROOF_VERSION,
      family: definition.family,
      prompt,
      resource: {
        bindingId: `binding.${suffix}`,
        offerHash: fixedHash(ordinal),
        evidenceId: `evidence.${suffix}`,
        evidenceOfferHash: fixedHash(ordinal + 1_000),
        kind: definition.family === "query-audit" || definition.family === "empty-or-restricted" || definition.family === "recovery-conflict"
          ? "record"
          : "dataset",
        label: `${definition.family.replaceAll("-", " ")} governed result ${questionIndex + 1}`,
        description: "Model-safe schema and aggregate metadata for a host-governed query resource.",
        columns: columnProfiles[definition.family],
        estimatedItems: definition.family === "empty-or-restricted" ? 0 : (questionIndex + 1) * 25,
      },
      expected: {
        primaryView: definition.primaryView,
        components: definition.components,
        assertions: definition.assertions,
      },
    });
  })
));

export const officialGoldenPromptCases = deepFreeze(goldenCases);

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
    value: { status: "published", bindingId: "binding.query-result", evidenceId: "evidence.query-result", descriptor: { columns: ["period", "value"], estimatedItems: 24 } },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.wire-history",
    channel: "wire-history",
    value: { documentId: "document-proof", revisionId: "revision-proof", resourceBindingIds: ["binding.query-result"], evidenceIds: ["evidence.query-result"] },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.message-history",
    channel: "message-history",
    value: { role: "assistant", text: "The governed analysis is available.", surfaceRevisionRef: "revision-proof", resourceVersionRefs: ["resource-version-proof"] },
  }),
  noPayloadFixtureSchema.parse({
    fixtureId: "no-payload.observability",
    channel: "observability",
    value: { event: "surface.revision-committed", correlationId: "correlation-proof", contentHash: fixedHash(9_999), itemCount: 24 },
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
      if (prohibitedStringPatterns.some((pattern) => pattern.test(value))) {
        issues.push({ code: "credential-like-string", path });
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (ancestors.has(value)) throw new TypeError(`Cannot scan cyclic proof fixture at ${path}.`);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, ancestors));
        return;
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        const keyPath = `${path}.${key}`;
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
        if (prohibitedPayloadKeys.has(normalized)) issues.push({ code: "prohibited-key", path: keyPath });
        visit(nested, keyPath, ancestors);
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
  if (issues.length > 0) {
    throw new TypeError(`No-payload proof failed: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`);
  }
}

export const deterministicProofReportSchema = z.object({
  proofVersion: z.literal(TESSERA_PROOF_VERSION),
  goldenCaseCount: z.literal(120),
  taskFamilyCounts: z.record(proofTaskFamilySchema, z.literal(10)),
  componentContractCount: z.literal(12),
  chartRecipeCount: z.literal(70),
  rendererExpectationCount: z.literal(70),
  accessibilityFixtureCount: z.literal(70),
  noPayloadFixtureCount: z.literal(5),
  goldenCasesHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  chartCoverageHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  noPayloadFixturesHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
export type DeterministicProofReport = z.infer<typeof deterministicProofReportSchema>;

export async function createDeterministicProofReport(
  provider?: HashProvider,
): Promise<DeterministicProofReport> {
  for (const fixture of officialNoPayloadFixtures) assertNoPayload(fixture.value);
  const taskFamilyCounts = Object.fromEntries(proofTaskFamilies.map((family) => [
    family,
    officialGoldenPromptCases.filter((candidate) => candidate.family === family).length,
  ]));
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

export async function verifyDeterministicProofReport(
  input: unknown,
  provider?: HashProvider,
): Promise<DeterministicProofReport> {
  const report = deterministicProofReportSchema.parse(input);
  const expected = await createDeterministicProofReport(provider);
  if (JSON.stringify(report) !== JSON.stringify(expected)) {
    throw new TypeError("Deterministic proof report does not match the current versioned fixtures.");
  }
  return report;
}
