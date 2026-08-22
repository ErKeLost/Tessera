import { describe, expect, test } from "bun:test";
import {
  actionIdSchema,
  documentContentSchema,
  eventPortSchema,
  requestIdSchema,
  resourceBindingIdSchema,
  stateIdSchema,
  surfaceSessionIdSchema,
  valueExprSchema,
  type JsonValue,
} from "@open-generative/protocol";
import { reduceSurfaceLocalAction } from "./local-state";
import { createDocumentContent, testHash } from "./test-fixtures";
import {
  collectValueExprDependencies,
  evaluateValueExprCondition,
  materializeNodeProps,
  materializeValueExpr,
  scopeValueMaterializationContext,
} from "./values";

describe("strict ValueExpr materialization", () => {
  test("uses canonical equality without coercion", () => {
    const expression = valueExprSchema.parse({
      kind: "condition",
      op: "eq",
      args: [
        { kind: "literal", value: "1" },
        { kind: "literal", value: 1 },
      ],
    });
    expect(evaluateValueExprCondition(expression, {})).toEqual({ ok: true, value: false });

    const comparison = valueExprSchema.parse({
      kind: "condition",
      op: "lt",
      args: [
        { kind: "literal", value: "2" },
        { kind: "literal", value: 10 },
      ],
    });
    const result = materializeValueExpr(comparison, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic.code).toBe("condition.invalid-operands");
  });

  test("traverses only own properties and never coerces path segment types", () => {
    const inherited = Object.create({ hidden: 42 }) as Record<string, JsonValue>;
    const state = Object.create({ inheritedState: { hidden: 42 } }) as Record<any, JsonValue>;
    state.ownState = inherited;

    const inheritedState = valueExprSchema.parse({ kind: "state-ref", stateId: "inheritedState" });
    expect(materializeValueExpr(inheritedState, { state }).ok).toBe(false);

    const inheritedProperty = valueExprSchema.parse({
      kind: "state-ref",
      stateId: "ownState",
      path: ["hidden"],
    });
    expect(materializeValueExpr(inheritedProperty, { state }).ok).toBe(false);

    const stringArrayIndex = valueExprSchema.parse({
      kind: "resource-ref",
      bindingId: "rows",
      path: ["0"],
    });
    expect(materializeValueExpr(stringArrayIndex, {
      resources: { ["rows" as any]: ["first"] },
    }).ok).toBe(false);

    const numericArrayIndex = valueExprSchema.parse({
      kind: "resource-ref",
      bindingId: "rows",
      path: [0],
    });
    expect(materializeValueExpr(numericArrayIndex, {
      resources: { ["rows" as any]: ["first"] },
    })).toEqual({ ok: true, value: "first" });
  });

  test("materializes canonical identities without reading state values or resource payloads", () => {
    const stateId = stateIdSchema.parse("filter.region");
    const bindingId = resourceBindingIdSchema.parse("dataset.sales");
    const expression = valueExprSchema.parse({
      kind: "object",
      entries: {
        stateId: { kind: "state-id-ref", stateId },
        bindingId: { kind: "resource-id-ref", bindingId },
      },
    });

    expect(materializeValueExpr(expression, {})).toEqual({
      ok: true,
      value: { stateId: "filter.region", bindingId: "dataset.sales" },
    });
    const dependencies = collectValueExprDependencies(expression);
    expect(dependencies.stateIds.map(String)).toEqual(["filter.region"]);
    expect(dependencies.resourceBindingIds.map(String)).toEqual(["dataset.sales"]);
    expect(dependencies.eventPorts).toEqual([]);
    expect(dependencies.contextKeys).toEqual([]);
  });

  test("extracts deterministic dependencies and scopes node materialization", () => {
    const base = createDocumentContent();
    const root = base.nodes[base.rootNodeId]!;
    const node = {
      ...root,
      props: {
        count: { kind: "state-ref" as const, stateId: stateIdSchema.parse("count") },
        locale: { kind: "context-ref" as const, key: "locale" as const },
      },
    };
    const dependencies = collectValueExprDependencies(node.props);
    expect(dependencies.stateIds.map(String)).toEqual(["count"]);
    expect(dependencies.contextKeys).toEqual(["locale"]);
    const scoped = scopeValueMaterializationContext(dependencies, {
      state: {
        [stateIdSchema.parse("count")]: 4,
        [stateIdSchema.parse("secret")]: "not-scoped",
      },
      context: { locale: "zh-CN", timezone: "Asia/Shanghai" },
    });
    expect(Object.keys(scoped.state ?? {})).toEqual(["count"]);
    expect(scoped.context).toEqual({ locale: "zh-CN" });
    expect(materializeNodeProps(node, scoped)).toEqual({
      ok: true,
      value: { count: 4, locale: "zh-CN" },
    });
  });

  test("treats a props map containing a kind property as a map", () => {
    const base = createDocumentContent();
    const root = base.nodes[base.rootNodeId]!;
    const filterStateId = stateIdSchema.parse("filter.value");
    const node = {
      ...root,
      props: {
        kind: { kind: "literal" as const, value: "select" },
        value: { kind: "state-ref" as const, stateId: filterStateId },
      },
    };

    expect(collectValueExprDependencies(node.props).stateIds.map(String)).toEqual(["filter.value"]);
    expect(materializeNodeProps(node, { state: { [filterStateId]: "north" } })).toEqual({
      ok: true,
      value: { kind: "select", value: "north" },
    });
  });
});

describe("atomic surface-local state reduction", () => {
  test("applies sequential transitions atomically and deterministically", async () => {
    const document = localStateDocument("surface");
    const input = {
      surfaceSessionId: surfaceSessionIdSchema.parse("surface-local"),
      requestId: requestIdSchema.parse("request-local"),
      actionId: actionIdSchema.parse("update-local"),
      document,
      state: {},
      event: { port: eventPortSchema.parse("change"), payload: null },
    };
    const validation = { validateSurfaceStateValue: () => [] };
    const first = await reduceSurfaceLocalAction(input, validation);
    const second = await reduceSurfaceLocalAction(input, validation);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;
    expect(first.state[stateIdSchema.parse("count")]?.value).toBe(1);
    expect(first.state[stateIdSchema.parse("mirror")]?.value).toBe(1);
    expect(first.changes).toHaveLength(2);
    expect(first.focusNodeIds.map(String)).toEqual(["root"]);
  });

  test("returns no partial state when a later transition fails validation", async () => {
    const document = localStateDocument("surface");
    const original = {};
    const result = await reduceSurfaceLocalAction({
      surfaceSessionId: surfaceSessionIdSchema.parse("surface-local"),
      requestId: requestIdSchema.parse("request-failure"),
      actionId: actionIdSchema.parse("update-local"),
      document,
      state: original,
      event: { port: eventPortSchema.parse("change"), payload: null },
    }, {
      validateSurfaceStateValue: ({ stateId }) => stateId === "mirror"
        ? [{ code: "state.rejected", message: "Mirror rejected." }]
        : [],
    });
    expect(result.ok).toBe(false);
    expect(original).toEqual({});
  });

  test("cannot escalate a local transition into a document-state write", async () => {
    const document = localStateDocument("document");
    const result = await reduceSurfaceLocalAction({
      surfaceSessionId: surfaceSessionIdSchema.parse("surface-local"),
      requestId: requestIdSchema.parse("request-forbidden"),
      actionId: actionIdSchema.parse("update-local"),
      document,
      state: {},
      event: { port: eventPortSchema.parse("change"), payload: null },
    }, { validateSurfaceStateValue: () => [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe("local-state.scope-forbidden");
  });
});

function localStateDocument(scope: "surface" | "document") {
  const base = createDocumentContent();
  const definition = (initial: number) => ({
    schema: true,
    schemaHash: testHash(initial === 0 ? "4" : "5"),
    initial,
    sensitivity: "public",
    modelVisibility: "value",
    retention: "retain",
    scope,
    persistence: scope === "surface" ? "none" : "host",
  });
  return documentContentSchema.parse({
    ...base,
    stateDefinitions: {
      count: definition(0),
      mirror: definition(1),
    },
    actions: {
      "update-local": {
        kind: "local-transition",
        transitions: [
          { type: "state.set", stateId: "count", value: { kind: "literal", value: 1 } },
          { type: "state.set", stateId: "mirror", value: { kind: "state-ref", stateId: "count" } },
          { type: "node.focus", nodeId: "root" },
        ],
      },
    },
  });
}
