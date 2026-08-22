import { describe, expect, test } from "bun:test";
import {
  createOfficialCatalog,
  hashNamespacedCanonical,
} from "@open-generative/components";
import {
  canonicalStringify,
  eventPortSchema,
  idempotencyKeySchema,
  nodeIdSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  sha256HashSchema,
  type JsonValue,
  type ValueExpr,
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
import {
  GALLERY_COLUMN_POLICY_HASH,
  GALLERY_ROW_POLICY_HASH,
  createGenerativeGalleryProofCase,
  expectedResourceContentHash,
} from "@/lib/generative-gallery-proof";

describe("Tessera Agent Generative UI documentation proof", () => {
  test("renders 12 Contracts, 70 recipes, and 3 Data Agent compositions through the trusted chain", async () => {
    expect(generativeGalleryConformanceDescriptors).toHaveLength(85);
    expect(generativeGalleryConformanceDescriptors.filter(entry => entry.kind === "component")).toHaveLength(12);
    expect(generativeGalleryConformanceDescriptors.filter(entry => entry.kind === "recipe")).toHaveLength(70);
    expect(generativeGalleryConformanceDescriptors.filter(entry => !["component", "recipe"].includes(entry.kind))).toHaveLength(3);
    const catalog = await createOfficialCatalog();

    for (const descriptor of generativeGalleryConformanceDescriptors) {
      const proof = await createGenerativeGalleryProofCase(descriptor);
      const fixture = await createGenerativeGalleryConformanceCase(descriptor, proof.event);
      try {
        expect(fixture.result.status).toBe("applied");
        expect(fixture.result.snapshot.status).toBe("ready");
        expect(fixture.event.payload.type).toBe("snapshot-published");
        if (fixture.event.payload.type !== "snapshot-published") {
          throw new Error("Expected a trusted snapshot-published event.");
        }

        const { revision, resources, resourceResolutionIdentities } = fixture.event.payload.snapshot;
        expect(fixture.registry.size).toBe(12);
        for (const registration of fixture.registry.entries()) {
          expect(registration.integrity).toBeDefined();
          expect(registration.integrity?.rendererCapabilityManifestHash).toBe(
            sha256HashSchema.parse(rendererManifest.manifestHash),
          );
        }

        const sourceByBinding = new Map(
          proof.resourceSources.map(source => [source.bindingId, source]),
        );
        const usedBindings = new Set<string>();
        for (const [nodeIdText, node] of Object.entries(revision.content.nodes)) {
          const nodeId = nodeIdSchema.parse(nodeIdText);
          const projection = fixture.controller.bindNode(nodeId);
          if (projection?.status !== "ready") {
            throw new Error(
              `${descriptor.kind}:${descriptor.value}:${nodeId} projected as ${projection?.status ?? "missing"}: ${projection?.diagnostics.map(issue => issue.message).join("; ") ?? "no diagnostics"}`,
            );
          }
          expect(projection.contract).toBeDefined();
          if (!projection.contract) throw new Error(`Missing projection Contract for ${nodeId}.`);
          expect(fixture.registry.resolve(projection.contract, generativeGalleryPlacement).status).toBe("ready");

          const contract = catalog.componentContracts.find(
            candidate => candidate.ref.componentType === node.contract.componentType,
          );
          expect(contract).toBeDefined();
          if (!contract) throw new Error(`Missing catalog Contract for ${node.contract.componentType}.`);
          for (const [pointer, policy] of Object.entries(contract.authoringBindings)) {
            const expression = expressionAtPointer(node.props, pointer);
            if (expression?.kind === "resource-ref") {
              usedBindings.add(expression.bindingId);
              const source = sourceByBinding.get(expression.bindingId);
              expect(source).toBeDefined();
              if (!source) throw new Error(`Missing proof source for ${expression.bindingId}.`);
              expect(String(source.componentType)).toBe(String(node.contract.componentType));
              expect(source.bindingPath).toBe(pointer);
              expect(expression.path).toBeUndefined();
              const declaration = revision.content.resourceBindings[expression.bindingId];
              expect(declaration).toBeDefined();
              if (!declaration) throw new Error(`Missing declaration for ${expression.bindingId}.`);
              expect(policy.resource?.kinds).toContain(declaration?.kind);
              expect(policy.resource?.schemaConstraints.some(
                constraint => constraint.schemaHash === declaration?.schemaConstraint.schemaHash,
              )).toBe(true);
              const sourceSchemas = new ResourceSchemaRegistry();
              const sourceConstraint = sourceSchemas.register({
                schemaId: `test.${source.bindingId}`,
                schemaRevision: 1,
                schema: source.schema,
              });
              expect(sourceConstraint.schemaHash).toBe(declaration?.schemaConstraint.schemaHash);
              expect(() => sourceSchemas.validate(sourceConstraint, source.sourceValue)).not.toThrow();
              const result = resources[expression.bindingId];
              expect(result?.status).toBe("resolved");
              if (result?.status === "resolved" && result.snapshot.payload.kind === "json") {
                const resolvedValue = result.snapshot.payload.value;
                expect(() => sourceSchemas.validate(sourceConstraint, resolvedValue)).not.toThrow();
              }
            }
            if (node.contract.componentType === "control.filter" && pointer === "/value") {
              expect(expression?.kind).toBe("state-ref");
            }
          }

          if (node.contract.componentType.startsWith("data.")) {
            expect(containsExpressionKind(node.props, "resource-ref")).toBe(true);
          }
          if (node.contract.componentType === "data.query-details") {
            expect(node.events.copy).toBeUndefined();
          }
          for (const actionId of Object.values(node.events)) {
            const action = revision.content.actions[actionId];
            if (action?.kind === "local-transition") {
              expect(action.transitions.some(transition => transition.type === "node.focus")).toBe(false);
            }
          }
        }
        expect([...usedBindings].sort()).toEqual([...sourceByBinding.keys()].sort());

        const resourceVersions = new Set<string>();
        for (const source of proof.resourceSources) {
          const bindingId = resourceBindingIdSchema.parse(source.bindingId);
          const declaration = revision.content.resourceBindings[bindingId];
          const result = resources[bindingId];
          const identity = resourceResolutionIdentities[bindingId];
          expect(declaration?.resolution.mode).toBe("pinned");
          expect(result?.status).toBe("resolved");
          expect(identity).toBeDefined();
          if (declaration?.resolution.mode !== "pinned" || result?.status !== "resolved" || !identity) {
            throw new Error(`Expected a pinned, resolved resource for ${bindingId}.`);
          }
          expect(identity.bindingId).toBe(bindingId);
          expect(identity.generation).toBe(0);
          expect(identity.expectedRevisionId).toBe(revision.envelope.revisionId);
          expect(identity.expectedResourceVersionId).toBe(declaration.resolution.versionId);
          expect(declaration.resolution.contentHash).toBe(
            await expectedResourceContentHash(source.sourceValue),
          );
          expect(declaration.resolution.versionId).toBe(result.snapshot.resourceVersionId);
          expect(declaration.resolution.contentHash).toBe(result.snapshot.contentHash);
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
          resourceVersions.add(result.snapshot.resourceVersionId);
          expect(containsCanonicalSubtree(revision.content, source.sourceValue)).toBe(false);
        }
        expect(resourceVersions.size).toBe(Object.keys(resources).length);
        expect(Object.keys(resourceResolutionIdentities).sort()).toEqual(Object.keys(resources).sort());
        const canonicalDocument = canonicalStringify(revision.content);
        expect(canonicalDocument).not.toContain('"rows"');
        expect(canonicalDocument).not.toContain("select month, sum(revenue)");
        expect(canonicalDocument).not.toContain("128400");

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

  test("uses filter state in Resource Gateway projection and returns different North and South windows", async () => {
    const descriptor = { kind: "filter", value: "filterable-breakdown" } as const;
    const [north, south] = await Promise.all([
      createGenerativeGalleryProofCase(descriptor, { filterValue: "north" }),
      createGenerativeGalleryProofCase(descriptor, { filterValue: "south" }),
    ]);
    if (north.event.payload.type !== "snapshot-published" || south.event.payload.type !== "snapshot-published") {
      throw new Error("Expected two filter snapshots.");
    }
    const filteredProofs = [
      { proof: north, selected: "north" as const, snapshot: north.event.payload.snapshot },
      { proof: south, selected: "south" as const, snapshot: south.event.payload.snapshot },
    ];
    for (const { proof, selected, snapshot } of filteredProofs) {
      const { revision, resources } = snapshot;
      for (const source of proof.resourceSources) {
        expect(String(revision.content.resourceBindings[resourceBindingIdSchema.parse(source.bindingId)]?.selector.filterStateRef)).toBe("filter.region");
      }
      for (const bindingId of ["fixture.chart.dataset", "table.monthly"]) {
        const result = resources[resourceBindingIdSchema.parse(bindingId)];
        if (result?.status !== "resolved" || result.snapshot.payload.kind !== "json") {
          throw new Error(`Expected resolved filtered dataset ${bindingId}.`);
        }
        const value = result.snapshot.payload.value as { rows?: Array<Record<string, JsonValue>> };
        expect(value.rows?.length).toBeGreaterThan(0);
        expect(value.rows?.every(row => row.region === selected)).toBe(true);
      }
    }
    const northTable = resolvedJson(north, "table.monthly");
    const southTable = resolvedJson(south, "table.monthly");
    expect(canonicalStringify(northTable)).not.toBe(canonicalStringify(southTable));
    expect(
      north.event.payload.snapshot.resources[resourceBindingIdSchema.parse("metric.revenue.value")]?.status,
    ).toBe("resolved");
    expect(
      canonicalStringify(north.event.payload.snapshot.resources),
    ).not.toBe(canonicalStringify(south.event.payload.snapshot.resources));
  });

  test("binds export to the triggering resource and applies filter changes as typed state transitions", async () => {
    const descriptor = { kind: "analysis", value: "analysis-overview" } as const;
    const proof = await createGenerativeGalleryProofCase(descriptor);
    const fixture = await createGenerativeGalleryConformanceCase(descriptor, proof.event);
    try {
      for (const [nodeId, expectedBinding] of [["table", "table.monthly"], ["query", "query.details"]] as const) {
        const projection = fixture.controller.bindNode(nodeIdSchema.parse(nodeId));
        expect(projection?.status).toBe("ready");
        const result = await projection?.commands?.emit?.(
          eventPortSchema.parse("export"),
          { format: "csv" },
          {
            requestId: requestIdSchema.parse(`request.export.${nodeId}`),
            idempotencyKey: idempotencyKeySchema.parse(`idempotency.export.${nodeId}`),
          },
        );
        expect(result?.kind).toBe("host-command");
        const command = fixture.commands.at(-1);
        expect(command?.payload.type).toBe("action-trigger-request");
        if (command?.payload.type !== "action-trigger-request") throw new Error("Expected action trigger command.");
        expect(Object.keys(command.payload.request.resourcePreconditions)).toEqual([expectedBinding]);
      }
    } finally {
      fixture.controller.dispose();
    }

    const filterDescriptor = { kind: "filter", value: "filterable-breakdown" } as const;
    const filterProof = await createGenerativeGalleryProofCase(filterDescriptor);
    const filterFixture = await createGenerativeGalleryConformanceCase(filterDescriptor, filterProof.event);
    try {
      const before = filterFixture.controller.bindNode(nodeIdSchema.parse("region"));
      expect(before?.resolvedProps?.value).toBe("north");
      const transition = await before?.commands?.emit?.(
        eventPortSchema.parse("change"),
        { filterId: "region", value: "south" },
        { requestId: requestIdSchema.parse("request.filter.change") },
      );
      expect(transition?.kind).toBe("local-transition");
      expect(filterFixture.controller.bindNode(nodeIdSchema.parse("region"))?.resolvedProps?.value).toBe("south");
    } finally {
      filterFixture.controller.dispose();
    }
  });
});

function expressionAtPointer(
  props: Readonly<Record<string, ValueExpr>>,
  pointer: string,
): ValueExpr | undefined {
  const segments = pointer.split("/").slice(1).map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: ValueExpr | undefined = props[segments[0] ?? ""];
  for (const segment of segments.slice(1)) {
    if (current?.kind === "object") current = current.entries[segment];
    else if (current?.kind === "array") current = current.items[Number(segment)];
    else return undefined;
  }
  return current;
}

function containsExpressionKind(input: unknown, kind: "resource-ref" | "state-ref"): boolean {
  if (Array.isArray(input)) return input.some(value => containsExpressionKind(value, kind));
  if (input === null || typeof input !== "object") return false;
  const object = input as Record<string, unknown>;
  if (object.kind === kind) return true;
  return Object.values(object).some(value => containsExpressionKind(value, kind));
}

function containsCanonicalSubtree(input: unknown, target: JsonValue): boolean {
  if (sameCanonicalValue(input, target)) return true;
  if (Array.isArray(input)) return input.some(value => containsCanonicalSubtree(value, target));
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

function resolvedJson(
  proof: Awaited<ReturnType<typeof createGenerativeGalleryProofCase>>,
  bindingId: string,
): JsonValue {
  if (proof.event.payload.type !== "snapshot-published") throw new Error("Expected snapshot event.");
  const result = proof.event.payload.snapshot.resources[resourceBindingIdSchema.parse(bindingId)];
  if (result?.status !== "resolved" || result.snapshot.payload.kind !== "json") {
    throw new Error(`Expected JSON resource ${bindingId}.`);
  }
  return result.snapshot.payload.value;
}
