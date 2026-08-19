import { describe, expect, test } from "bun:test";
import {
  createDocumentPolicy,
  prepareInformationFlow,
} from "./information-flow";
import { CompilerDiagnosticError } from "./diagnostics";
import { compilePrompt, compilerSchemaProfile } from "./prompt";
import type {
  InformationFlowLabel,
  LabeledModelInput,
  ModelVisibleCapability,
} from "./types";

const publicLabel: InformationFlowLabel = {
  scopeRef: "tenant:acme",
  sensitivity: "public",
  persistence: "session",
  allowedSinks: ["model-generation", "model-repair", "renderer"],
};

describe("information-flow preparation", () => {
  test("filters denied inputs and computes a conservative deterministic join", () => {
    const policy = createDocumentPolicy({
      policyId: "acme-sensitive",
      scopeRef: "tenant:acme",
      sensitivity: "sensitive",
      persistence: "none",
      allowedSinks: ["model-generation", "model-repair"],
    });
    const inputs: LabeledModelInput[] = [
      { provenanceRef: "b", kind: "message", content: "private", label: { ...publicLabel, sensitivity: "private", persistence: "none" } },
      { provenanceRef: "a", kind: "tool-result", content: { value: 4 }, label: publicLabel },
      { provenanceRef: "excluded", kind: "resource", content: "host-only", label: { ...publicLabel, allowedSinks: ["renderer"] } },
    ];
    const first = prepareInformationFlow(inputs, policy);
    const second = prepareInformationFlow([...inputs].reverse(), policy);
    expect(first.included).toHaveLength(2);
    expect(first.excluded.map(({ provenanceRef }) => provenanceRef)).toEqual(["excluded"]);
    expect(first.joinedLabel.sensitivity).toBe("private");
    expect(first.joinedLabel.persistence).toBe("none");
    expect(first.generationTaintHash).toBe(second.generationTaintHash);
  });

  test("fails before generation when scopes do not intersect", () => {
    const policy = createDocumentPolicy({
      policyId: "acme",
      scopeRef: "tenant:acme",
      sensitivity: "sensitive",
      persistence: "none",
      allowedSinks: ["model-generation"],
    });
    expect(() => prepareInformationFlow([
      { provenanceRef: "a", kind: "message", content: "a", label: publicLabel },
      { provenanceRef: "b", kind: "message", content: "b", label: { ...publicLabel, scopeRef: "tenant:other" } },
    ], policy)).toThrow(CompilerDiagnosticError);
  });
});

describe("prompt compilation", () => {
  const capability: ModelVisibleCapability = {
    capabilityId: "acme.refresh",
    grantVersion: 2,
    schemaProfile: compilerSchemaProfile,
    kind: "resource-read",
    summary: "Refresh an authorized Acme resource.",
    inputSchemaId: "acme.refresh.input",
    inputSchemaVersion: 1,
    inputSchema: { type: "object", additionalProperties: false },
    inputSchemaHash: "input-hash",
    outputSchemaId: "acme.refresh.output",
    outputSchemaVersion: 1,
    outputSchemaHash: "output-hash",
    requiresApproval: false,
  };

  test("compiles deterministic prompt and provider schema from the same slice", () => {
    const input = {
      generationTaintHash: "taint",
      profile: "analysis" as const,
      requestedNodeTypes: ["artifact.trend"],
      task: "Show the revenue trend over time",
      capabilityDescriptors: [capability],
    };
    const first = compilePrompt(input);
    const second = compilePrompt({ ...input, capabilityDescriptors: [...input.capabilityDescriptors].reverse() });
    expect(first.promptBundleHash).toBe(second.promptBundleHash);
    expect(first.system).toContain("artifact.trend@1");
    expect(first.system).not.toContain("artifact.query@1");
    expect(JSON.stringify(first.providerSchema)).toContain("acme.refresh");
    expect(first.contractFingerprint).toBe(first.catalogSlice.contractFingerprint);
  });

  test("reuses compiled provider schemas without sharing mutable objects", () => {
    const input = {
      generationTaintHash: "taint",
      profile: "analysis" as const,
      requestedNodeTypes: ["artifact.metric"],
      task: "Show a compact KPI",
    };
    const first = compilePrompt(input);
    first.providerSchema.title = "mutated by caller";

    const second = compilePrompt(input);
    expect(second.providerSchema.title).toBe("Data Elements Artifact Proposal");
    expect(second.promptBundleHash).toBe(first.promptBundleHash);
  });

  test("governed preset always compiles strict rendering", () => {
    const bundle = compilePrompt({
      generationTaintHash: "taint",
      preset: "governed",
      renderMode: "progressive",
      requestedNodeTypes: ["artifact.experiment"],
    });
    expect(bundle.renderMode).toBe("strict");
  });

  test("rejects descriptors from a different schema profile", () => {
    expect(() => compilePrompt({
      generationTaintHash: "taint",
      capabilityDescriptors: [{
        ...capability,
        schemaProfile: { ...compilerSchemaProfile, profileHash: "wrong" },
      }],
    })).toThrow(CompilerDiagnosticError);
  });
});
