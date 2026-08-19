import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CONTRACT_FINGERPRINT,
  ArtifactCatalog,
  artifactContracts,
  artifactManifests,
  canonicalJson,
  createArtifactToolDescription,
  defineArtifactContract,
  defaultArtifactCatalog,
  getCalculator,
  normalizeCalculatorValues,
  sha256,
} from "./index";
import { z } from "zod";

describe("trusted artifact catalog", () => {
  test("describes positive and negative selection guidance", () => {
    const description = createArtifactToolDescription(artifactManifests[0]!);
    expect(description).toContain("Use when:");
    expect(description).toContain("Do not use when:");
    expect(description).toContain("Never provide JSX");
  });

  test("only resolves registered calculators", () => {
    expect(getCalculator("compound-interest")?.id).toBe("compound-interest");
    expect(getCalculator("eval-user-formula")).toBeUndefined();
  });

  test("clamps model-provided initial values", () => {
    const calculator = getCalculator("compound-interest")!;
    const values = normalizeCalculatorValues(calculator, { rate: 900 });
    expect(values.rate).toBe(20);
    expect(values.principal).toBe(10_000);
  });

  test("registers a manifest and concrete schema for every artifact kind", () => {
    expect(artifactManifests.map(({ kind }) => kind)).toEqual([
      "query",
      "calculator",
      "metric",
      "comparison",
      "trend",
      "anomaly",
      "forecast",
      "funnel",
      "data-quality",
      "insight",
      "breakdown",
      "distribution",
      "cohort",
      "experiment",
      "driver",
      "ranking",
      "target",
      "timeline",
    ]);
    expect(defaultArtifactCatalog.manifests()).toHaveLength(18);
    expect(defaultArtifactCatalog.has("data-quality")).toBe(true);
    expect(defaultArtifactCatalog.has("ranking")).toBe(true);
    expect(defaultArtifactCatalog.has("target")).toBe(true);
    expect(defaultArtifactCatalog.has("timeline")).toBe(true);
    expect(artifactContracts.map(({ kind }) => kind)).toEqual(artifactManifests.map(({ kind }) => kind));
  });

  test("generates a complete provider schema and deterministic fingerprint", () => {
    const providerSchema = defaultArtifactCatalog.toJSONSchema();
    expect(providerSchema.oneOf).toBeArrayOfSize(18);
    expect(JSON.stringify(providerSchema)).toContain('"kind"');
    expect(JSON.stringify(providerSchema)).toContain('"driver"');
    expect(JSON.stringify(providerSchema)).toContain('"ranking"');
    expect(JSON.stringify(providerSchema)).toContain('"target"');
    expect(JSON.stringify(providerSchema)).toContain('"timeline"');
    expect(ARTIFACT_CONTRACT_FINGERPRINT).toBe(defaultArtifactCatalog.fingerprint());
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(canonicalJson({ z: 1, a: [true, null] })).toBe('{"a":[true,null],"z":1}');
  });

  test("extends the catalog with a namespaced custom contract", () => {
    const customSchema = z.object({
      protocolVersion: z.literal("1.0"),
      kind: z.literal("acme.heatmap"),
      id: z.string(),
      title: z.string(),
      cells: z.array(z.number()),
    }).strict();
    const custom = defineArtifactContract({
      kind: "acme.heatmap",
      version: 1,
      schema: customSchema,
      manifest: {
        kind: "acme.heatmap",
        name: "Heatmap",
        description: "Render a custom heatmap.",
        whenToUse: ["Values form a matrix."],
        whenNotToUse: ["There is only one value."],
        interactionModel: "read-only",
      },
      prompt: {
        summary: "Render a custom heatmap.",
        useWhen: ["Values form a matrix."],
        avoidWhen: ["There is only one value."],
      },
      category: "custom",
      interactionModel: "read-only",
      commitPolicy: "atomic",
      eventPorts: { select: z.object({ cell: z.number().int().nonnegative() }).strict() },
      renderer: { bindingId: "acme.react.heatmap", exportName: "HeatmapArtifact" },
      distribution: {
        registryName: "acme-heatmap",
        entryFile: "heatmap.tsx",
        targetFile: "@components/acme/heatmap.tsx",
        clientBoundary: true,
        styleFiles: [],
      },
    });
    const catalog = defaultArtifactCatalog.extend([custom]);
    expect(catalog.parse({ protocolVersion: "1.0", kind: "acme.heatmap", id: "h", title: "H", cells: [1] }).kind).toBe("acme.heatmap");
    expect(catalog.parseEvent("acme.heatmap", "select", { cell: 0 })).toEqual({ cell: 0 });
    expect((catalog.toJSONSchema().oneOf as unknown[]).length).toBe(19);
    expect(() => new ArtifactCatalog().register({ ...custom, kind: "heatmap", manifest: { ...custom.manifest, kind: "heatmap" } } as never)).toThrow("namespaced");
  });

  test("catalog parses a new declarative artifact and rejects extra executable fields", () => {
    const safe = {
      protocolVersion: "1.0",
      kind: "insight",
      id: "insight-1",
      title: "Activation improved",
      insights: [{ id: "activation", headline: "Activation improved", detail: "Up after onboarding changed." }],
    };
    expect(defaultArtifactCatalog.parse(safe).kind).toBe("insight");
    expect(() => defaultArtifactCatalog.parse({ ...safe, script: "eval(userInput)" })).toThrow();
  });

  test("new manifests preserve positive and negative selection guidance", () => {
    for (const manifest of artifactManifests.slice(4)) {
      const description = createArtifactToolDescription(manifest);
      expect(manifest.whenToUse.length).toBeGreaterThan(0);
      expect(manifest.whenNotToUse.length).toBeGreaterThan(0);
      expect(description).toContain("Only provide validated structured data.");
      expect(description).toContain("executable formulas");
    }
  });

  test("exposes typed selection ports only for interactive semantic artifacts", () => {
    expect(Object.keys(defaultArtifactCatalog.get("ranking")!.eventPorts)).toEqual(["ranking-item-select"]);
    expect(Object.keys(defaultArtifactCatalog.get("timeline")!.eventPorts)).toEqual(["timeline-item-select"]);
    expect(Object.keys(defaultArtifactCatalog.get("target")!.eventPorts)).toEqual([]);
    expect(defaultArtifactCatalog.parseEvent("ranking", "ranking-item-select", {
      itemId: "north-america",
      rank: 1,
    })).toEqual({ itemId: "north-america", rank: 1 });
    expect(defaultArtifactCatalog.parseEvent("timeline", "timeline-item-select", {
      eventId: "production-rollout",
    })).toEqual({ eventId: "production-rollout" });
  });
});
