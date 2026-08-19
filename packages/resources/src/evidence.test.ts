import { describe, expect, test } from "bun:test";
import { validateEvidenceAndClaims, type EvidenceValidationInput } from "./index";

describe("evidence and claim validation", () => {
  test("requires recognized causal validation and prevents sensitivity downgrade", () => {
    const input: EvidenceValidationInput = {
      resources: {
        r1: {
          resourceId: "r1",
          schemaId: "schema",
          schemaVersion: 1,
          schemaHash: "schema-hash",
          codec: { id: "json", version: "1" },
          mediaType: "application/json",
          contentHash: "content-hash",
          scopeRef: "scope",
          sensitivity: "sensitive",
        },
      },
      evidence: {
        e1: {
          evidenceId: "e1",
          schemaId: "schema",
          schemaVersion: 1,
          schemaHash: "schema-hash",
          sourceRefs: [{ kind: "resource", id: "r1", contentHash: "content-hash" }],
          activityRefs: ["experiment-1"],
          contentHash: "content-hash",
          scopeRef: "scope",
          recordedAt: "2026-08-15T00:00:00.000Z",
          validationIds: ["correlation-only"],
          sensitivity: "private",
        },
      },
      claims: {
        c1: { claimId: "c1", nodeId: "n1", evidenceIds: ["e1"], qualifier: "causal" },
      },
      nodes: { n1: { evidence: ["e1"] } },
      causalValidationIds: ["randomized-controlled-trial"],
      now: "2026-08-15T00:00:00.000Z",
    };
    const result = validateEvidenceAndClaims(input);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("evidence.sensitivity-lowered");
    expect(result.diagnostics.map((item) => item.code)).toContain("claim.causal-unsubstantiated");
  });
});
