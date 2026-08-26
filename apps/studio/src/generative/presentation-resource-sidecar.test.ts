import { describe, expect, test } from "bun:test";
import type { OpenGenerativeDatasetResource } from "@open-generative/mastra";
import {
  createTesseraPresentationResourceSidecar,
  isTesseraChartPresentationRequest,
  isTesseraPresentationFollowUp,
} from "./presentation-resource-sidecar";

describe("Tessera presentation resource sidecar", () => {
  test("isolates cached resources by session resource and thread", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    const cached = resource("cached");
    sidecar.resourcesFor(scope("session-a", "thread-a", [cached], true));

    expect(sidecar.resourcesFor(scope("session-a", "thread-a", [], false, true))).toEqual([cached]);
    expect(sidecar.resourcesFor(scope("session-a", "thread-b", [], false, true))).toEqual([]);
    expect(sidecar.resourcesFor(scope("session-b", "thread-a", [], false, true))).toEqual([]);
  });

  test("prefers and retains the current verified resource over cached data", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    const previous = resource("previous");
    const current = resource("current");
    const currentBatch = [current];
    sidecar.resourcesFor(scope("session", "thread", [previous], true));

    expect(sidecar.resourcesFor(scope("session", "thread", currentBatch, true))).toBe(currentBatch);
    expect(sidecar.resourcesFor(scope("session", "thread", [], false, true))).toEqual([current]);
  });

  test("never invents data and clears stale data after an empty current result", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    expect(sidecar.resourcesFor(scope("session", "thread", [], false, true))).toEqual([]);

    sidecar.resourcesFor(scope("session", "thread", [resource("previous")], true));
    expect(sidecar.resourcesFor(scope("session", "thread", [], true, true))).toEqual([]);
    expect(sidecar.resourcesFor(scope("session", "thread", [], false, true))).toEqual([]);
  });

  test("does not expose cached data without a presentation follow-up", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    sidecar.resourcesFor(scope("session", "thread", [resource("cached")], true));

    expect(sidecar.resourcesFor(scope("session", "thread", [], false, false))).toEqual([]);
    expect(sidecar.resourcesFor(scope("session", "thread", [], false, true))).toHaveLength(1);
  });

  test("evicts the least recently used scope at the configured bound", () => {
    const sidecar = createTesseraPresentationResourceSidecar({ maxContexts: 2 });
    sidecar.resourcesFor(scope("session", "thread-a", [resource("a")], true));
    sidecar.resourcesFor(scope("session", "thread-b", [resource("b")], true));
    sidecar.resourcesFor(scope("session", "thread-a", [], false, true));
    sidecar.resourcesFor(scope("session", "thread-c", [resource("c")], true));

    expect(sidecar.resourcesFor(scope("session", "thread-a", [], false, true))).toHaveLength(1);
    expect(sidecar.resourcesFor(scope("session", "thread-b", [], false, true))).toEqual([]);
    expect(sidecar.resourcesFor(scope("session", "thread-c", [], false, true))).toHaveLength(1);
  });

  test("returns full current data while bounding the cached snapshot", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    const rows = Array.from({ length: 1_100 }, (_, index) => ({ value: index }));
    const current = [resource("large", rows)];

    expect(sidecar.resourcesFor(scope("session", "thread", current, true))).toBe(current);
    const cached = sidecar.resourcesFor(scope("session", "thread", [], false, true));
    expect(cached[0]?.dataset.rows).toHaveLength(1_000);
    expect(cached[0]?.dataset.totalRows).toBe(1_100);
    expect(cached[0]?.dataset.hasMore).toBeTrue();
  });

  test("keeps each cached context below the byte and resource budgets", () => {
    const sidecar = createTesseraPresentationResourceSidecar();
    const largeValue = "x".repeat(16_000);
    const current = Array.from({ length: 5 }, (_, index) => resource(
      `large-${index}`,
      Array.from({ length: 300 }, () => ({ value: largeValue })),
    ));
    sidecar.resourcesFor(scope("session", "thread", current, true));

    const cached = sidecar.resourcesFor(scope("session", "thread", [], false, true));
    expect(cached.length).toBeLessThanOrEqual(4);
    expect(Buffer.byteLength(JSON.stringify(cached), "utf8")).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(cached.some((item) => item.dataset.hasMore)).toBeTrue();
  });
});

test("recognizes conservative presentation transformations without routing new queries to cache", () => {
  expect(isTesseraPresentationFollowUp("继续说")).toBeTrue();
  expect(isTesseraPresentationFollowUp("给我展示柱状图")).toBeTrue();
  expect(isTesseraPresentationFollowUp("把刚才的数据换成表格")).toBeTrue();
  expect(isTesseraPresentationFollowUp("Show the previous result as a dashboard")).toBeTrue();
  expect(isTesseraPresentationFollowUp("查询注册用户数据并展示柱状图")).toBeFalse();
  expect(isTesseraPresentationFollowUp("用柱状图展示最近一周注册用户分布")).toBeFalse();
  expect(isTesseraPresentationFollowUp("How many users registered today?")).toBeFalse();
  expect(isTesseraPresentationFollowUp("你好")).toBeFalse();
  expect(isTesseraChartPresentationRequest("给我展示柱状图")).toBeTrue();
  expect(isTesseraChartPresentationRequest("把刚才的数据换成表格")).toBeFalse();
});

function scope(
  resourceId: string,
  threadId: string,
  current: readonly OpenGenerativeDatasetResource[],
  dataAttempted: boolean,
  allowCached = false,
) {
  return { resourceId, threadId, current, dataAttempted, allowCached };
}

function resource(
  id: string,
  rows: Record<string, string | number | boolean | null>[] = [{ value: id.length }],
): OpenGenerativeDatasetResource {
  return {
    bindingId: `query-${id}`,
    label: id,
    dataset: {
      columns: [{ columnId: "value", label: "Value", valueType: "number" }],
      rows,
      totalRows: rows.length,
      hasMore: false,
    },
    classification: "internal",
    sensitivity: "internal",
  };
}
