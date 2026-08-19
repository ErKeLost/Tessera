import { describe, expect, test } from "bun:test";
import { defaultCompilerCatalog } from "../packages/compiler/src/index";
import {
  createEvaluationManifest,
  evaluateReleaseGates,
} from "../packages/evals/src/index";
import manifestInput from "../packages/evals/manifests/local-reference-v1.json";

describe("versioned evaluation manifest", () => {
  test("is pinned to the current contract graph and cannot claim missing samples", () => {
    const manifest = createEvaluationManifest(manifestInput);
    expect(manifest.contractFingerprint).toBe(defaultCompilerCatalog.contractFingerprint);

    const report = evaluateReleaseGates(manifest, []);
    expect(report.passed).toBe(false);
    expect(report.gates.every(({ status }) => status === "insufficient-data")).toBe(true);
    expect(report.gates.find(({ gate }) => gate === "structure")?.reasons.join(" ")).toContain("4000");
  });
});
