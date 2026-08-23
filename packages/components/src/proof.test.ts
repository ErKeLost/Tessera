import { describe, expect, test } from "bun:test";
import {
  createDeterministicProofReport,
  goldenPromptCaseSchema,
  officialGoldenPromptCases,
  officialNoPayloadFixtures,
  proofTaskFamilies,
  scanNoPayload,
  verifyDeterministicProofReport,
} from "./proof";
import { chartRecipes } from "./chart-spec";

describe("Tessera Data Chart proof manifest", () => {
  test("contains one payload-free golden case for every recipe", () => {
    expect(officialGoldenPromptCases).toHaveLength(17);
    expect(proofTaskFamilies).toEqual(chartRecipes);
    for (const golden of officialGoldenPromptCases) {
      expect(goldenPromptCaseSchema.parse(golden)).toEqual(golden);
      expect(scanNoPayload(golden)).toEqual([]);
      expect(golden.expected.components).toEqual(["data.chart"]);
    }
  });

  test("keeps durable channels payload-free", () => {
    expect(officialNoPayloadFixtures).toHaveLength(5);
    for (const fixture of officialNoPayloadFixtures) expect(scanNoPayload(fixture.value)).toEqual([]);
    expect(scanNoPayload({ rows: [{ secret: 1 }] })).toEqual([{ code: "prohibited-key", path: "$.rows" }]);
    expect(scanNoPayload({ authorization: "Bearer secret-token-value" })).toEqual([{ code: "credential-like-string", path: "$.authorization" }]);
  });

  test("generates and verifies one deterministic report", async () => {
    const [left, right] = await Promise.all([createDeterministicProofReport(), createDeterministicProofReport()]);
    expect(left).toEqual(right);
    expect(left.goldenCaseCount).toBe(17);
    expect(left.componentContractCount).toBe(1);
    await expect(verifyDeterministicProofReport(left)).resolves.toEqual(left);
    const tampered = { ...left, goldenCasesHash: `sha256:${"0".repeat(64)}` };
    await expect(verifyDeterministicProofReport(tampered)).rejects.toThrow("does not match");
  });
});
