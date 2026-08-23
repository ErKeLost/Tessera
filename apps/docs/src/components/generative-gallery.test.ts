import { describe, expect, test } from "bun:test";
import {
  createOfficialCatalog,
  hashNamespacedCanonical,
  officialChartSpecFixtures,
} from "@open-generative/components";
import {
  canonicalStringify,
  nodeIdSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  type JsonValue,
} from "@open-generative/protocol";
import { GenerativeSurface } from "@open-generative/react";
import { ResourceSchemaRegistry } from "@open-generative/resources";
import rendererManifest from "@open-generative/ui/renderer-manifest.json";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createGenerativeGalleryConformanceCase,
  generativeGalleryConformanceDescriptors,
  generativeGalleryPlacement,
} from "./generative-gallery";
import { parsePreviewDescriptor } from "./generative-gallery-model";
import {
  GALLERY_COLUMN_POLICY_HASH,
  GALLERY_ROW_POLICY_HASH,
  createGenerativeGalleryProofCase,
  expectedResourceContentHash,
} from "@/lib/generative-gallery-proof";

describe("Tessera Agent data.chart documentation proof", () => {
  test("renders all 17 official recipes through the trusted chain", async () => {
    expect(generativeGalleryConformanceDescriptors).toHaveLength(17);
    expect(generativeGalleryConformanceDescriptors.map(entry => entry.value)).toEqual(
      officialChartSpecFixtures.map(fixture => fixture.recipeName),
    );
    const catalog = await createOfficialCatalog();
    expect(catalog.componentContracts.map(contract => String(contract.ref.componentType)).sort())
      .toEqual([
        "analysis.insight",
        "analysis.report",
        "data.chart",
        "data.metric",
        "layout.grid",
        "layout.stack",
      ]);

    for (const descriptor of generativeGalleryConformanceDescriptors) {
      const proof = await createGenerativeGalleryProofCase(descriptor);
      const fixture = await createGenerativeGalleryConformanceCase(descriptor, proof.event);
      try {
        expect(fixture.result.status).toBe("applied");
        expect(fixture.result.snapshot.status).toBe("ready");
        expect(fixture.registry.size).toBe(6);
        const registration = fixture.registry.entries().find(
          entry => String(entry.contract.componentType) === "data.chart",
        );
        expect(registration?.integrity?.rendererCapabilityManifestHash).toBe(
          sha256HashSchema.parse(rendererManifest.manifestHash),
        );

        if (fixture.event.payload.type !== "snapshot-published") {
          throw new Error("Expected a trusted snapshot-published event.");
        }
        const { revision, resources, resourceResolutionIdentities } =
          fixture.event.payload.snapshot;
        expect(Object.keys(revision.content.nodes)).toEqual(["root"]);
        const node = revision.content.nodes[nodeIdSchema.parse("root")];
        expect(String(node?.contract.componentType)).toBe("data.chart");
        expect(node?.events).toEqual({});

        const projection = fixture.controller.bindNode(nodeIdSchema.parse("root"));
        if (projection?.status !== "ready") {
          throw new Error(
            `${descriptor.value} projected as ${projection?.status ?? "missing"}: ${projection?.diagnostics.map(issue => issue.message).join("; ") ?? "no diagnostics"}`,
          );
        }
        expect(String(projection.contract?.ref.componentType)).toBe("data.chart");
        if (projection.contract === undefined) {
          throw new Error("Missing resolved data.chart Contract.");
        }
        expect(fixture.registry.resolve(
          projection.contract,
          generativeGalleryPlacement,
        ).status).toBe("ready");

        const officialFixture = officialChartSpecFixtures.find(
          candidate => candidate.recipeName === descriptor.value,
        );
        if (officialFixture === undefined) {
          throw new Error(`Missing official fixture for ${descriptor.value}.`);
        }
        const resolvedProps = projection.resolvedProps as {
          spec?: unknown;
        };
        expect(canonicalStringify(resolvedProps.spec)).toBe(
          canonicalStringify(officialFixture.resolvedSpec),
        );

        expect(proof.resourceSources).toHaveLength(1);
        const source = proof.resourceSources[0]!;
        const bindingId = resourceBindingIdSchema.parse(source.bindingId);
        const declaration = revision.content.resourceBindings[bindingId];
        const result = resources[bindingId];
        const identity = resourceResolutionIdentities[bindingId];
        expect(source.componentType).toBe("data.chart");
        expect(source.bindingPath).toBe("/spec/data");
        expect(declaration?.resolution.mode).toBe("pinned");
        expect(result?.status).toBe("resolved");
        expect(identity?.bindingId).toBe(bindingId);
        expect(identity?.expectedRevisionId).toBe(revision.envelope.revisionId);
        if (declaration === undefined) {
          throw new Error(`Missing Resource Binding declaration for ${descriptor.value}.`);
        }

        const sourceSchemas = new ResourceSchemaRegistry();
        const sourceConstraint = sourceSchemas.register({
          schemaId: `test.${source.bindingId}.${descriptor.value}`,
          schemaRevision: 1,
          schema: source.schema,
        });
        expect(sourceConstraint.schemaHash).toBe(declaration.schemaConstraint.schemaHash);
        expect(() => sourceSchemas.validate(sourceConstraint, source.sourceValue)).not.toThrow();
        expect(declaration.resolution.mode === "pinned"
          ? declaration.resolution.contentHash
          : undefined).toBe(await expectedResourceContentHash(source.sourceValue));

        if (result?.status !== "resolved") {
          throw new Error(`Expected a resolved dataset for ${descriptor.value}.`);
        }
        expect(result.snapshot.schemaHash).toBe(declaration.schemaConstraint.schemaHash);
        expect(result.snapshot.projectionHash).toBe(await hashNamespacedCanonical(
          "open-generative.resource-projection",
          { selector: declaration.selector, selectedColumns: null },
        ));
        expect(result.snapshot.policyProjectionHash).toBe(await hashNamespacedCanonical(
          "open-generative.resource-policy-projection",
          {
            rowPolicyHash: GALLERY_ROW_POLICY_HASH,
            columnPolicyHash: GALLERY_COLUMN_POLICY_HASH,
            selectedColumns: null,
          },
        ));
        expect(containsCanonicalSubtree(revision.content, source.sourceValue)).toBe(false);
        expect(canonicalStringify(revision.content)).not.toContain('"rows"');

        const html = renderToStaticMarkup(createElement(GenerativeSurface, {
          controller: fixture.controller,
          placement: generativeGalleryPlacement,
          registry: fixture.registry,
        }));
        expect(html).toContain("data-og-component");
        expect(html).not.toContain('data-open-generative-system="error"');
        expect(html).not.toContain('data-open-generative-system="unsupported"');
      } finally {
        fixture.controller.dispose();
      }
    }
  }, 120_000);

  test("rejects every descriptor outside the official recipe set", () => {
    expect(() => parsePreviewDescriptor("component", "data.chart")).toThrow();
    expect(() => parsePreviewDescriptor("recipe", "chart-area-default")).toThrow();
    expect(() => parsePreviewDescriptor("recipe", null)).toThrow();
  });
});

function containsCanonicalSubtree(input: unknown, target: JsonValue): boolean {
  if (sameCanonicalValue(input, target)) return true;
  if (Array.isArray(input)) {
    return input.some(value => containsCanonicalSubtree(value, target));
  }
  if (input === null || typeof input !== "object") return false;
  return Object.values(input).some(value => containsCanonicalSubtree(value, target));
}

function sameCanonicalValue(input: unknown, target: JsonValue): boolean {
  try {
    return canonicalStringify(input) === canonicalStringify(target);
  } catch {
    return false;
  }
}
