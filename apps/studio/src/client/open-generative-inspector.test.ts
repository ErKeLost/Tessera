import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StudioOpenGenerativeInspection } from "./api/studio-api";
import {
  OPEN_GENERATIVE_INSPECTOR_TABS,
  OpenGenerativeInspectionView,
  OpenGenerativeInspector,
  openGenerativeInspectorSections,
  openGenerativeInspectorSummary,
} from "./open-generative-inspector";

const inspection = Object.freeze({
  authority: Object.freeze({
    actorBindingHash: `sha256:${"a".repeat(64)}`,
    tenantBindingHash: `sha256:${"b".repeat(64)}`,
    authorityPolicyRevision: "tessera-studio.v1",
  }),
  snapshot: Object.freeze({
    version: 2 as const,
    surfaceSessionId: "surface:inspection-test",
    ogl: Object.freeze({
      source: 'root = Stack("sm", [message])\nmessage = Text("Ready")\n',
      ast: Object.freeze([{ name: "root" }, { name: "message" }]),
    }),
    catalog: Object.freeze({
      sliceHash: `sha256:${"c".repeat(64)}`,
      components: Object.freeze([
        Object.freeze({ componentType: "layout.stack" }),
        Object.freeze({ componentType: "content.text" }),
      ]),
    }),
    resourceAuthorizations: Object.freeze([Object.freeze({ bindingId: "users", decision: "allowed" })]),
    events: Object.freeze([Object.freeze({ sequence: 1, type: "revision-committed" })]),
    receipts: Object.freeze([Object.freeze({ receiptId: "receipt-1", outcome: "succeeded" })]),
    rejections: Object.freeze([Object.freeze({ source: "policy" })]),
  }),
}) satisfies StudioOpenGenerativeInspection;

describe("Open Generative Inspector", () => {
  test("defines the complete seven-tab inspection surface", () => {
    expect(OPEN_GENERATIVE_INSPECTOR_TABS.map((tab) => tab.label)).toEqual([
      "OGL",
      "AST",
      "Catalog Slice",
      "Resource authorization",
      "Events",
      "Action receipts",
      "Rejections",
    ]);
  });

  test("projects every tab from one immutable inspection snapshot", () => {
    const sections = openGenerativeInspectorSections(inspection);

    expect(sections.ogl.value).toBe(inspection.snapshot.ogl.source);
    expect(sections.ast.value).toBe(inspection.snapshot.ogl.ast);
    expect(sections.catalog.value).toBe(inspection.snapshot.catalog);
    expect(sections.resources.value).toBe(inspection.snapshot.resourceAuthorizations);
    expect(sections.events.value).toBe(inspection.snapshot.events);
    expect(sections.receipts.value).toBe(inspection.snapshot.receipts);
    expect(sections.rejections.value).toBe(inspection.snapshot.rejections);
    expect(Object.fromEntries(OPEN_GENERATIVE_INSPECTOR_TABS.map((tab) => [
      tab.value,
      sections[tab.value].count,
    ]))).toEqual({
      ogl: 2,
      ast: 2,
      catalog: 2,
      resources: 1,
      events: 1,
      receipts: 1,
      rejections: 1,
    });
  });

  test("summarizes a committed snapshot without treating earlier denials as terminal", () => {
    expect(openGenerativeInspectorSummary(inspection)).toEqual({
      status: "committed",
      oglLines: 2,
      components: 2,
      resources: 1,
      events: 1,
      receipts: 1,
      rejections: 1,
    });
  });

  test("marks a noncommitted snapshot with rejection evidence as rejected", () => {
    const rejected = Object.freeze({
      ...inspection,
      snapshot: Object.freeze({
        ...inspection.snapshot,
        events: Object.freeze([Object.freeze({ sequence: 1, type: "rejected" })]),
      }),
    }) satisfies StudioOpenGenerativeInspection;

    expect(openGenerativeInspectorSummary(rejected).status).toBe("rejected");
  });

  test("renders a compact counted workspace with default wrapping, copy, and OGL line numbers", () => {
    const markup = renderToStaticMarkup(createElement(OpenGenerativeInspectionView, { inspection }));

    expect(markup).toContain("OGL lines");
    expect(markup).toContain('aria-label="Disable line wrapping"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Copy OGL"');
    expect(markup).toContain('aria-label="OGL source"');
    expect(markup).toContain('root = Stack(&quot;sm&quot;, [message])');
    expect(markup).toContain('message = Text(&quot;Ready&quot;)');
    expect(markup.match(/<li class=/g)).toHaveLength(2);
  });

  test("renders an explicit OGL empty state without workspace controls", () => {
    const empty = Object.freeze({
      ...inspection,
      snapshot: Object.freeze({
        ...inspection.snapshot,
        ogl: Object.freeze({}),
      }),
    }) satisfies StudioOpenGenerativeInspection;
    const markup = renderToStaticMarkup(createElement(OpenGenerativeInspectionView, { inspection: empty }));

    expect(markup).toContain("OGL source was not captured.");
    expect(markup).not.toContain('aria-label="Copy OGL"');
  });

  test("renders only the real icon trigger before the Dialog is opened", () => {
    const markup = renderToStaticMarkup(createElement(OpenGenerativeInspector, {
      hostDeployment: "demo",
      surfaceSessionId: inspection.snapshot.surfaceSessionId,
    }));

    expect(markup).toContain('aria-label="Open Surface inspector"');
    expect(markup).toContain("Inspect generated surface");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("Catalog Slice");
  });
});
