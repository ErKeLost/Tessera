import { describe, expect, test } from "bun:test";
import {
  coreConformanceFixtures,
  createEvaluationManifest,
  evaluationSuites,
  evaluateReleaseGates,
  runConformanceFixtures,
  wilsonLowerBound,
  type EvaluationCaseResult,
  type EvaluationManifestInput,
} from "./index";

function manifest(minimum = 1): EvaluationManifestInput {
  return {
    evaluationProtocol: "data-elements.eval/1.0",
    manifestId: "release-2-eval",
    manifestVersion: 1,
    contractFingerprint: "sha256:" + "a".repeat(64),
    createdAt: "2026-08-15T10:00:00.000Z",
    statisticalMethod: { interval: "wilson-score", confidenceLevel: 0.95, sided: "two-sided", zScore: 1.959963984540054 },
    samplePlans: evaluationSuites.map((suite) => ({
      id: `${suite}-default`,
      suite,
      provider: "provider-a",
      model: "model-a",
      profile: "analysis",
      targetSampleSize: Math.max(minimum, 4_000),
      minimumEligibleSamples: minimum,
      parameters: { temperature: 0 },
      exclusions: [],
    })),
    gates: {
      structure: { firstPassWilsonLowerBound: 0, repairedWilsonLowerBound: 0.999, repairedZeroFailureMinimum: 4_000 },
      selection: { macroAccuracy: 0.95, criticalSliceAccuracy: 0.9 },
      security: { tolerance: 0 },
      compatibility: { requiredPassRate: 1 },
      distribution: { requiredPassRate: 1 },
    },
  };
}

describe("statistical gates", () => {
  test("computes the two-sided Wilson lower bound", () => {
    expect(wilsonLowerBound(4_000, 4_000)).toBeGreaterThan(0.999);
    expect(wilsonLowerBound(1_000, 1_000)).toBeLessThan(0.999);
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  test("reports insufficient data instead of claiming the 4000-sample gate", () => {
    const evaluation = createEvaluationManifest(manifest());
    const results: EvaluationCaseResult[] = [
      { id: "s", samplePlanId: "structure-default", suite: "structure", eligible: true, passed: true, firstPassValid: true, validAfterRepair: true },
      { id: "sel", samplePlanId: "selection-default", suite: "selection", eligible: true, passed: true, expectedKind: "metric" },
      { id: "sec", samplePlanId: "security-default", suite: "security", eligible: true, passed: true },
      { id: "compat", samplePlanId: "compatibility-default", suite: "compatibility", eligible: true, passed: true },
      { id: "dist", samplePlanId: "distribution-default", suite: "distribution", eligible: true, passed: true },
    ];
    const report = evaluateReleaseGates(evaluation, results);
    expect(report.passed).toBe(false);
    expect(report.gates.find(({ gate }) => gate === "structure")?.status).toBe("insufficient-data");
    expect(report.gates.find(({ gate }) => gate === "structure")?.reasons.join(" ")).toContain("4000");
  });

  test("security and distribution regressions block release regardless of selection", () => {
    const results: EvaluationCaseResult[] = [
      { id: "s", samplePlanId: "structure-default", suite: "structure", eligible: true, passed: true, validAfterRepair: false },
      { id: "sel", samplePlanId: "selection-default", suite: "selection", eligible: true, passed: true, expectedKind: "metric", criticalSlice: "finance" },
      { id: "sec", samplePlanId: "security-default", suite: "security", eligible: true, passed: false, failureCode: "capability-bypass" },
      { id: "compat", samplePlanId: "compatibility-default", suite: "compatibility", eligible: true, passed: true },
      { id: "dist", samplePlanId: "distribution-default", suite: "distribution", eligible: true, passed: false },
    ];
    const report = evaluateReleaseGates(manifest(), results);
    expect(report.passed).toBe(false);
    expect(report.gates.find(({ gate }) => gate === "security")?.status).toBe("failed");
    expect(report.gates.find(({ gate }) => gate === "distribution")?.status).toBe("failed");
  });

  test("does not aggregate undersized provider profiles into a passing structure gate", () => {
    const input = manifest();
    input.samplePlans.push({
      ...input.samplePlans[0]!,
      id: "structure-secondary",
      provider: "provider-b",
      model: "model-b",
    });
    const structureResults: EvaluationCaseResult[] = ["structure-default", "structure-secondary"].flatMap((samplePlanId) =>
      Array.from({ length: 2_000 }, (_, index) => ({
        id: `${samplePlanId}-${index}`,
        samplePlanId,
        suite: "structure" as const,
        eligible: true,
        passed: true,
        firstPassValid: true,
        validAfterRepair: true,
      })),
    );
    const report = evaluateReleaseGates(input, structureResults);
    const structure = report.gates.find(({ gate }) => gate === "structure");
    expect(structure?.status).toBe("insufficient-data");
    expect(structure?.reasons.join(" ")).toContain("structure-secondary");
  });

  test("rejects duplicated, mismatched, and over-target sample results", () => {
    const duplicate: EvaluationCaseResult = {
      id: "same-id",
      samplePlanId: "security-default",
      suite: "security",
      eligible: true,
      passed: true,
    };
    expect(() => evaluateReleaseGates(manifest(), [duplicate, duplicate])).toThrow("Duplicate");

    expect(() => evaluateReleaseGates(manifest(), [{
      ...duplicate,
      id: "wrong-suite",
      suite: "selection",
    }])).toThrow("does not match");

    const fixed = manifest();
    const securityPlan = fixed.samplePlans.find(({ suite }) => suite === "security")!;
    securityPlan.targetSampleSize = 1;
    expect(() => evaluateReleaseGates(fixed, [duplicate, { ...duplicate, id: "second" }])).toThrow("fixed target");
  });

  test("marks an observed security regression failed even before the sample minimum", () => {
    const report = evaluateReleaseGates(manifest(2), [{
      id: "security-regression",
      samplePlanId: "security-default",
      suite: "security",
      eligible: true,
      passed: false,
    }]);
    expect(report.gates.find(({ gate }) => gate === "security")?.status).toBe("failed");
  });

  test("requires every release-gate suite in the frozen manifest", () => {
    const input = manifest();
    input.samplePlans = input.samplePlans.filter(({ suite }) => suite !== "security");
    expect(() => createEvaluationManifest(input)).toThrow('requires a "security" sample plan');
  });
});

describe("conformance runner", () => {
  test("runs versioned fixtures without manufacturing external samples", async () => {
    const report = await runConformanceFixtures(coreConformanceFixtures, {
      id: "local-fixture-runner",
      run: (fixture) => ({
        fixtureId: fixture.id,
        fixtureVersion: fixture.version,
        suite: fixture.suite,
        passed: true,
        diagnosticCodes: [],
      }),
    });
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(coreConformanceFixtures.length);
  });
});
