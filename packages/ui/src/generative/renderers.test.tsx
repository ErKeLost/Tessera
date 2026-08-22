import { describe, expect, test } from "bun:test";
import {
  createOfficialCatalog,
  officialComponentFixtures,
} from "@open-generative/components";
import {
  canonicalNodeSchema,
  type JsonObject,
  type JsonValue,
} from "@open-generative/protocol";
import type {
  RendererInput,
  RenderedSlots,
} from "@open-generative/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createOfficialRendererRegistrations } from "./registry";

describe("official renderer conformance", () => {
  test("SSR renders every resolved component fixture through its exact renderer", async () => {
    const catalog = await createOfficialCatalog();
    const registrations = createOfficialRendererRegistrations(catalog);

    for (const fixture of officialComponentFixtures) {
      const contract = catalog.componentContracts.find((candidate) => candidate.ref.componentType === fixture.componentType)!;
      const registration = registrations.find((candidate) => candidate.contract.componentType === fixture.componentType)!;
      const input = rendererInput(contract, asObject(fixture.resolvedProps), "read-only-preview");
      const markup = renderToStaticMarkup(createElement(registration.renderer, input));
      expect(markup).toContain(`data-og-component="${fixture.componentType}"`);
      expect(markup).not.toContain("open-tessera");
      expect(markup).not.toContain("data-slot=\"artifact\"");
    }
  });

  test("event controls require the exact committed node port", async () => {
    const catalog = await createOfficialCatalog();
    const queryFixture = officialComponentFixtures.find((fixture) => fixture.componentType === "data.query-details")!;
    const queryContract = catalog.components.dataQueryDetails;
    const registration = createOfficialRendererRegistrations(catalog).find((candidate) => candidate.contract.componentType === "data.query-details")!;

    const preview = renderToStaticMarkup(createElement(
      registration.renderer,
      rendererInput(queryContract, asObject(queryFixture.resolvedProps), "read-only-preview", ["export"]),
    ));
    const committed = renderToStaticMarkup(createElement(
      registration.renderer,
      rendererInput(queryContract, asObject(queryFixture.resolvedProps), "committed", ["export"]),
    ));
    const unrelated = renderToStaticMarkup(createElement(
      registration.renderer,
      rendererInput(queryContract, asObject(queryFixture.resolvedProps), "committed", ["dismiss"]),
    ));

    expect(preview).not.toContain('aria-label="Copy query"');
    expect(preview).not.toContain('aria-label="Export format"');
    expect(committed).not.toContain('aria-label="Copy query"');
    expect(committed).toContain('aria-label="Export format"');
    expect(unrelated).not.toContain('aria-label="Copy query"');
    expect(unrelated).not.toContain('aria-label="Export format"');
  });

  test("table SSR includes its host window, sort state, and bounded pagination", async () => {
    const catalog = await createOfficialCatalog();
    const fixture = officialComponentFixtures.find((candidate) => candidate.componentType === "data.table")!;
    const registration = createOfficialRendererRegistrations(catalog).find((candidate) => candidate.contract.componentType === "data.table")!;
    const markup = renderToStaticMarkup(createElement(
      registration.renderer,
      rendererInput(catalog.components.dataTable, asObject(fixture.resolvedProps), "committed", ["export"]),
    ));

    expect(markup).toContain("2026");
    expect(markup).toContain("$128,400");
    expect(markup).toContain("Page 1 of 1");
    expect(markup).toContain('aria-label="Export format"');
  });
});

type CatalogContract = Awaited<ReturnType<typeof createOfficialCatalog>>["componentContracts"][number];

function rendererInput(
  contract: CatalogContract,
  resolvedProps: JsonObject,
  mode: "committed" | "read-only-preview",
  eventPorts: readonly string[] = [],
): RendererInput {
  const slots = Object.freeze(Object.fromEntries(
    Object.keys(contract.slots).map((slotName) => [slotName, [<span key={slotName}>Slot</span>]]),
  )) as RenderedSlots;
  const common = {
    node: canonicalNodeSchema.parse({
      contract: contract.ref,
      props: {},
      slots: {},
      events: Object.fromEntries(eventPorts.map((port) => [port, `action.${port}`])),
      evidence: [],
    }),
    contract,
    resolvedProps,
    slots,
    stateBindings: {},
    resourceBindings: {},
    placement: { kind: "inline" as const, width: 800, height: 600 },
  };
  return mode === "committed"
    ? {
      ...common,
      projectionMode: "committed",
      emit: async () => undefined as never,
    }
    : { ...common, projectionMode: "read-only-preview" };
}

function asObject(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected fixture props to be a JSON object.");
  }
  return value;
}
