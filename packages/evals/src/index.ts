import { jsonValueSchema, type JsonValue } from "@data-elements/runtime";
import { z } from "zod";

export const evaluationSuites = [
  "structure",
  "selection",
  "security",
  "compatibility",
  "distribution",
] as const;

export const evaluationSuiteSchema = z.enum(evaluationSuites);

export const evaluationManifestSchema = z.object({
  evaluationProtocol: z.literal("data-elements.eval/1.0"),
  manifestId: z.string().min(1),
  manifestVersion: z.number().int().positive(),
  contractFingerprint: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  statisticalMethod: z.object({
    interval: z.literal("wilson-score"),
    confidenceLevel: z.literal(0.95),
    sided: z.literal("two-sided"),
    zScore: z.literal(1.959963984540054),
  }).strict(),
  samplePlans: z.array(z.object({
    id: z.string().min(1),
    suite: evaluationSuiteSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    profile: z.string().min(1),
    targetSampleSize: z.number().int().positive(),
    minimumEligibleSamples: z.number().int().positive(),
    parameters: jsonValueSchema,
    exclusions: z.array(z.string().min(1)),
  }).strict()).min(1),
  gates: z.object({
    structure: z.object({
      firstPassWilsonLowerBound: z.number().min(0).max(1),
      repairedWilsonLowerBound: z.number().min(0).max(1),
      repairedZeroFailureMinimum: z.number().int().min(4_000),
    }).strict(),
    selection: z.object({
      macroAccuracy: z.number().min(0).max(1),
      criticalSliceAccuracy: z.number().min(0).max(1),
    }).strict(),
    security: z.object({ tolerance: z.literal(0) }).strict(),
    compatibility: z.object({ requiredPassRate: z.literal(1) }).strict(),
    distribution: z.object({ requiredPassRate: z.literal(1) }).strict(),
  }).strict(),
}).strict();

export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type EvaluationManifestInput = z.input<typeof evaluationManifestSchema>;
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;

export function createEvaluationManifest(input: EvaluationManifestInput): Readonly<EvaluationManifest> {
  const manifest = evaluationManifestSchema.parse(input);
  const ids = manifest.samplePlans.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Evaluation sample plan ids must be unique.");
  for (const suite of evaluationSuites) {
    if (!manifest.samplePlans.some((plan) => plan.suite === suite)) {
      throw new Error(`Evaluation manifest requires a "${suite}" sample plan.`);
    }
  }
  for (const plan of manifest.samplePlans) {
    if (plan.minimumEligibleSamples > plan.targetSampleSize) {
      throw new Error(`Sample plan "${plan.id}" has a minimum larger than its fixed target.`);
    }
  }
  return deepFreeze(manifest);
}

export function wilsonLowerBound(
  successes: number,
  total: number,
  zScore = 1.959963984540054,
): number {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || total < 0 || successes < 0 || successes > total) {
    throw new TypeError("Wilson inputs must be integer counts with 0 <= successes <= total.");
  }
  if (!Number.isFinite(zScore) || zScore <= 0) throw new TypeError("Wilson z-score must be positive.");
  if (total === 0) return 0;
  const proportion = successes / total;
  const z2 = zScore ** 2;
  const denominator = 1 + z2 / total;
  const center = proportion + z2 / (2 * total);
  const margin = zScore * Math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

export type EvaluationCaseResult = {
  id: string;
  samplePlanId: string;
  suite: EvaluationSuite;
  eligible: boolean;
  passed: boolean;
  firstPassValid?: boolean;
  validAfterRepair?: boolean;
  expectedKind?: string;
  actualKind?: string;
  criticalSlice?: string;
  failureCode?: string;
};

export type EvaluationGateResult = Readonly<{
  gate: EvaluationSuite;
  status: "passed" | "failed" | "insufficient-data";
  eligible: number;
  passed: number;
  metrics: Readonly<Record<string, number>>;
  reasons: readonly string[];
}>;

function eligibleFor(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
  suite: EvaluationSuite,
): {
  plans: EvaluationManifest["samplePlans"];
  rows: EvaluationCaseResult[];
  reasons: string[];
} {
  const plans = manifest.samplePlans.filter((plan) => plan.suite === suite);
  const planIds = new Set(plans.map(({ id }) => id));
  const rows = results.filter((result) => result.suite === suite && result.eligible && planIds.has(result.samplePlanId));
  const reasons: string[] = [];
  for (const plan of plans) {
    const count = rows.filter(({ samplePlanId }) => samplePlanId === plan.id).length;
    if (count < plan.minimumEligibleSamples) {
      reasons.push(`Sample plan "${plan.id}" has ${count}/${plan.minimumEligibleSamples} eligible samples.`);
    }
  }
  return { plans, rows, reasons };
}

export function evaluateStructureGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): EvaluationGateResult {
  const { plans, rows, reasons } = eligibleFor(manifest, results, "structure");
  const firstPass = rows.filter(({ firstPassValid }) => firstPassValid === true).length;
  const repaired = rows.filter(({ validAfterRepair }) => validAfterRepair === true).length;
  const firstLower = wilsonLowerBound(firstPass, rows.length, manifest.statisticalMethod.zScore);
  const repairedLower = wilsonLowerBound(repaired, rows.length, manifest.statisticalMethod.zScore);
  const metrics: Record<string, number> = {
    firstPassRate: rows.length ? firstPass / rows.length : 0,
    firstPassWilsonLowerBound: firstLower,
    repairedRate: rows.length ? repaired / rows.length : 0,
    repairedWilsonLowerBound: repairedLower,
  };
  for (const plan of plans) {
    const planRows = rows.filter(({ samplePlanId }) => samplePlanId === plan.id);
    const planFirstPass = planRows.filter(({ firstPassValid }) => firstPassValid === true).length;
    const planRepaired = planRows.filter(({ validAfterRepair }) => validAfterRepair === true).length;
    const planFirstLower = wilsonLowerBound(planFirstPass, planRows.length, manifest.statisticalMethod.zScore);
    const planRepairedLower = wilsonLowerBound(planRepaired, planRows.length, manifest.statisticalMethod.zScore);
    metrics[`plan.${plan.id}.firstPassWilsonLowerBound`] = planFirstLower;
    metrics[`plan.${plan.id}.repairedWilsonLowerBound`] = planRepairedLower;
    if (planFirstLower < manifest.gates.structure.firstPassWilsonLowerBound) {
      reasons.push(`Sample plan "${plan.id}" first-pass Wilson lower bound is below the gate.`);
    }
    if (planRepairedLower < manifest.gates.structure.repairedWilsonLowerBound) {
      reasons.push(`Sample plan "${plan.id}" repaired Wilson lower bound is below the gate.`);
    }
    if (
      planRepaired === planRows.length
      && planRows.length < manifest.gates.structure.repairedZeroFailureMinimum
    ) {
      reasons.push(`Sample plan "${plan.id}" zero-failure repaired validity requires at least ${manifest.gates.structure.repairedZeroFailureMinimum} eligible samples.`);
    }
  }
  return gateResult("structure", rows, reasons, metrics);
}

export function evaluateSelectionGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): EvaluationGateResult {
  const { plans, rows, reasons } = eligibleFor(manifest, results, "selection");
  const { macroAccuracy, criticalMinimum } = selectionMetrics(rows);
  if (macroAccuracy < manifest.gates.selection.macroAccuracy) reasons.push("Selection macro accuracy is below the gate.");
  if (criticalMinimum < manifest.gates.selection.criticalSliceAccuracy) reasons.push("A critical selection slice is below the gate.");
  const metrics: Record<string, number> = { macroAccuracy, criticalSliceMinimum: criticalMinimum };
  for (const plan of plans) {
    const planMetrics = selectionMetrics(rows.filter(({ samplePlanId }) => samplePlanId === plan.id));
    metrics[`plan.${plan.id}.macroAccuracy`] = planMetrics.macroAccuracy;
    metrics[`plan.${plan.id}.criticalSliceMinimum`] = planMetrics.criticalMinimum;
    if (planMetrics.macroAccuracy < manifest.gates.selection.macroAccuracy) {
      reasons.push(`Sample plan "${plan.id}" selection macro accuracy is below the gate.`);
    }
    if (planMetrics.criticalMinimum < manifest.gates.selection.criticalSliceAccuracy) {
      reasons.push(`Sample plan "${plan.id}" has a critical selection slice below the gate.`);
    }
  }
  return gateResult("selection", rows, reasons, metrics);
}

function selectionMetrics(rows: readonly EvaluationCaseResult[]): {
  macroAccuracy: number;
  criticalMinimum: number;
} {
  const byKind = new Map<string, EvaluationCaseResult[]>();
  for (const row of rows) {
    const key = row.expectedKind ?? "unspecified";
    byKind.set(key, [...(byKind.get(key) ?? []), row]);
  }
  const accuracies = [...byKind.values()].map((items) => items.filter(({ passed }) => passed).length / items.length);
  const macroAccuracy = accuracies.length ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length : 0;
  const critical = new Map<string, EvaluationCaseResult[]>();
  for (const row of rows.filter(({ criticalSlice }) => criticalSlice)) {
    critical.set(row.criticalSlice!, [...(critical.get(row.criticalSlice!) ?? []), row]);
  }
  const criticalMinimum = critical.size
    ? Math.min(...[...critical.values()].map((items) => items.filter(({ passed }) => passed).length / items.length))
    : 1;
  return { macroAccuracy, criticalMinimum };
}

export function evaluateSecurityGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): EvaluationGateResult {
  const { rows, reasons } = eligibleFor(manifest, results, "security");
  const violations = rows.filter(({ passed }) => !passed).length;
  if (violations > manifest.gates.security.tolerance) reasons.push(`${violations} security violations observed; tolerance is zero.`);
  return gateResult("security", rows, reasons, { violations }, violations > 0);
}

export function evaluateCompatibilityGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): EvaluationGateResult {
  return evaluatePerfectGate(manifest, results, "compatibility", manifest.gates.compatibility.requiredPassRate);
}

export function evaluateDistributionGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): EvaluationGateResult {
  return evaluatePerfectGate(manifest, results, "distribution", manifest.gates.distribution.requiredPassRate);
}

function evaluatePerfectGate(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
  suite: "compatibility" | "distribution",
  required: number,
): EvaluationGateResult {
  const { rows, reasons } = eligibleFor(manifest, results, suite);
  const passed = rows.filter((row) => row.passed).length;
  const rate = rows.length ? passed / rows.length : 0;
  if (rate < required) reasons.push(`${suite} pass rate is below the required ${required}.`);
  return gateResult(suite, rows, reasons, { passRate: rate }, passed < rows.length);
}

function gateResult(
  gate: EvaluationSuite,
  rows: readonly EvaluationCaseResult[],
  reasons: readonly string[],
  metrics: Record<string, number>,
  hardFailure = false,
): EvaluationGateResult {
  const insufficient = reasons.some((reason) => reason.includes("eligible samples") || reason.includes("Zero-failure"));
  return Object.freeze({
    gate,
    status: reasons.length === 0 ? "passed" : hardFailure ? "failed" : insufficient ? "insufficient-data" : "failed",
    eligible: rows.length,
    passed: rows.filter(({ passed }) => passed).length,
    metrics: Object.freeze({ ...metrics }),
    reasons: Object.freeze([...reasons]),
  });
}

export function evaluateReleaseGates(
  manifestInput: EvaluationManifest | EvaluationManifestInput,
  results: readonly EvaluationCaseResult[],
): Readonly<{ passed: boolean; gates: readonly EvaluationGateResult[] }> {
  const manifest = createEvaluationManifest(manifestInput);
  assertEvaluationResults(manifest, results);
  const gates = [
    evaluateStructureGate(manifest, results),
    evaluateSelectionGate(manifest, results),
    evaluateSecurityGate(manifest, results),
    evaluateCompatibilityGate(manifest, results),
    evaluateDistributionGate(manifest, results),
  ];
  return Object.freeze({ passed: gates.every(({ status }) => status === "passed"), gates: Object.freeze(gates) });
}

function assertEvaluationResults(
  manifest: EvaluationManifest,
  results: readonly EvaluationCaseResult[],
): void {
  const plans = new Map(manifest.samplePlans.map((plan) => [plan.id, plan]));
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (const result of results) {
    if (!result.id.trim()) throw new TypeError("Evaluation result ids must be non-empty.");
    if (ids.has(result.id)) throw new Error(`Duplicate evaluation result id "${result.id}".`);
    ids.add(result.id);
    const plan = plans.get(result.samplePlanId);
    if (!plan) throw new Error(`Unknown evaluation sample plan "${result.samplePlanId}".`);
    if (plan.suite !== result.suite) {
      throw new Error(`Evaluation result "${result.id}" does not match sample plan suite "${plan.suite}".`);
    }
    const count = (counts.get(plan.id) ?? 0) + 1;
    if (count > plan.targetSampleSize) {
      throw new Error(`Sample plan "${plan.id}" exceeded its fixed target of ${plan.targetSampleSize}.`);
    }
    counts.set(plan.id, count);
  }
}

export type ConformanceFixture<TInput extends JsonValue = JsonValue, TExpected extends JsonValue = JsonValue> = Readonly<{
  fixtureProtocol: "data-elements.conformance/1.0";
  id: string;
  version: number;
  suite: EvaluationSuite;
  input: TInput;
  expected: TExpected;
}>;

export type ConformanceFixtureResult = Readonly<{
  fixtureId: string;
  fixtureVersion: number;
  suite: EvaluationSuite;
  passed: boolean;
  diagnosticCodes: readonly string[];
}>;

export interface ConformanceRunner {
  readonly id: string;
  run(fixture: ConformanceFixture): ConformanceFixtureResult | Promise<ConformanceFixtureResult>;
}

export async function runConformanceFixtures(
  fixtures: readonly ConformanceFixture[],
  runner: ConformanceRunner,
): Promise<Readonly<{ runnerId: string; passed: boolean; results: readonly ConformanceFixtureResult[] }>> {
  if (!runner.id.trim()) throw new TypeError("A conformance runner needs a stable id.");
  const identities = fixtures.map(({ id, version }) => `${id}@${version}`);
  if (new Set(identities).size !== identities.length) throw new Error("Conformance fixture identities must be unique.");
  const results: ConformanceFixtureResult[] = [];
  for (const fixture of fixtures) {
    if (fixture.fixtureProtocol !== "data-elements.conformance/1.0") throw new Error("Unsupported conformance fixture protocol.");
    const result = await runner.run(fixture);
    if (result.fixtureId !== fixture.id || result.fixtureVersion !== fixture.version || result.suite !== fixture.suite) {
      throw new Error(`Runner returned a mismatched result for fixture "${fixture.id}".`);
    }
    results.push(Object.freeze({ ...result, diagnosticCodes: Object.freeze([...new Set(result.diagnosticCodes)]) }));
  }
  return Object.freeze({
    runnerId: runner.id,
    passed: results.every(({ passed }) => passed),
    results: Object.freeze(results),
  });
}

export const coreConformanceFixtures: readonly ConformanceFixture[] = Object.freeze([
  Object.freeze({
    fixtureProtocol: "data-elements.conformance/1.0" as const,
    id: "security-executable-content",
    version: 1,
    suite: "security" as const,
    input: { type: "content.text", props: { script: "alert(1)" } },
    expected: { accepted: false, diagnosticCode: "node.invalid_props" },
  }),
  Object.freeze({
    fixtureProtocol: "data-elements.conformance/1.0" as const,
    id: "compat-v1-projection",
    version: 1,
    suite: "compatibility" as const,
    input: { protocolVersion: "1.0", kind: "metric" },
    expected: { envelopeIdentityInProps: false },
  }),
  Object.freeze({
    fixtureProtocol: "data-elements.conformance/1.0" as const,
    id: "distribution-fresh-install",
    version: 1,
    suite: "distribution" as const,
    input: { packageManager: "bun", framework: "vite" },
    expected: { install: true, typecheck: true, productionBuild: true },
  }),
]);

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
