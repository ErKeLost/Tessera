import type { OpenGenerativeDatasetResource } from "@open-generative/mastra";

const DEFAULT_MAX_PRESENTATION_RESOURCE_CONTEXTS = 16;
const MAX_CACHED_RESOURCES_PER_CONTEXT = 4;
const MAX_CACHED_ROWS_PER_RESOURCE = 1_000;
const MAX_CACHED_BYTES_PER_CONTEXT = 4 * 1024 * 1024;
const EMPTY_PRESENTATION_RESOURCES = freezeValue([] as OpenGenerativeDatasetResource[]);
const EMPTY_DATASET_ROWS = freezeValue([] as OpenGenerativeDatasetResource["dataset"]["rows"]);
const CHART_PRESENTATION_PATTERN = /(?:\b(?:bar|line|area|pie|radar|scatter|heatmap|funnel)\s+chart\b|\b(?:chart|graph|visualization)\b|(?:\u56fe\u8868|\u67f1\u72b6\u56fe|\u6761\u5f62\u56fe|\u6298\u7ebf\u56fe|\u9762\u79ef\u56fe|\u997c\u56fe|\u96f7\u8fbe\u56fe|\u6563\u70b9\u56fe|\u70ed\u529b\u56fe|\u6f0f\u6597\u56fe|\u53ef\u89c6\u5316))/u;

export type TesseraPresentationResourceSidecar = Readonly<{
  resourcesFor(input: Readonly<{
    resourceId: string;
    threadId: string;
    current: readonly OpenGenerativeDatasetResource[];
    /** True once this turn attempts a governed analysis or read query. */
    dataAttempted: boolean;
    allowCached: boolean;
  }>): readonly OpenGenerativeDatasetResource[];
}>;

/**
 * Keeps the latest verified presentation resources outside Mastra state and
 * durable Memory. The owning Studio Agent serializes each scope's turns.
 */
export function createTesseraPresentationResourceSidecar(
  options: Readonly<{ maxContexts?: number }> = {},
): TesseraPresentationResourceSidecar {
  const maxContexts = options.maxContexts ?? DEFAULT_MAX_PRESENTATION_RESOURCE_CONTEXTS;
  if (!Number.isSafeInteger(maxContexts) || maxContexts < 1) {
    throw new TypeError("Presentation resource maxContexts must be a positive safe integer.");
  }
  const entries = new Map<string, readonly OpenGenerativeDatasetResource[]>();

  return freezeValue({
    resourcesFor(input) {
      const key = presentationResourceScopeKey(input.resourceId, input.threadId);
      if (input.dataAttempted) {
        if (input.current.length === 0) {
          entries.delete(key);
          return EMPTY_PRESENTATION_RESOURCES;
        }
        const snapshot = boundedResourceSnapshot(input.current);
        entries.delete(key);
        if (snapshot.length > 0) {
          entries.set(key, snapshot);
          evictOldest(entries, maxContexts);
        }
        return input.current;
      }
      if (!input.allowCached) return EMPTY_PRESENTATION_RESOURCES;

      const cached = entries.get(key);
      if (!cached) return EMPTY_PRESENTATION_RESOURCES;
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    },
  });
}

function boundedResourceSnapshot(
  resources: readonly OpenGenerativeDatasetResource[],
): readonly OpenGenerativeDatasetResource[] {
  const output: OpenGenerativeDatasetResource[] = [];
  let usedBytes = 2;
  for (const resource of resources.slice(0, MAX_CACHED_RESOURCES_PER_CONTEXT)) {
    const columns = freezeValue(resource.dataset.columns.map((column) => freezeValue({ ...column })));
    const totalRows = resource.dataset.totalRows ?? resource.dataset.rows.length;
    const base: OpenGenerativeDatasetResource = {
      ...resource,
      dataset: {
        ...resource.dataset,
        columns,
        rows: EMPTY_DATASET_ROWS,
        totalRows,
        hasMore: true,
      },
    };
    const separatorBytes = output.length === 0 ? 0 : 1;
    const baseBytes = serializedBytes(base);
    if (usedBytes + separatorBytes + baseBytes > MAX_CACHED_BYTES_PER_CONTEXT) continue;

    const rows: Record<string, string | number | boolean | null>[] = [];
    let resourceBytes = baseBytes;
    for (const sourceRow of resource.dataset.rows.slice(0, MAX_CACHED_ROWS_PER_RESOURCE)) {
      const row = freezeValue({ ...sourceRow });
      const rowBytes = serializedBytes(row) + (rows.length === 0 ? 0 : 1);
      if (usedBytes + separatorBytes + resourceBytes + rowBytes > MAX_CACHED_BYTES_PER_CONTEXT) break;
      rows.push(row);
      resourceBytes += rowBytes;
    }
    if (resource.dataset.rows.length > 0 && rows.length === 0) continue;

    const dataset = freezeValue({
      ...resource.dataset,
      columns,
      rows: freezeValue(rows),
      totalRows,
      hasMore: resource.dataset.hasMore || rows.length < resource.dataset.rows.length,
    });
    output.push(freezeValue({ ...resource, dataset }));
    usedBytes += separatorBytes + resourceBytes;
  }
  return freezeValue(output);
}

/** Only presentation transformations may reuse a prior turn's dataset. */
export function isTesseraPresentationFollowUp(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.length === 0) return false;

  const priorResult = /(?:\b(?:same|previous|prior|above|earlier|last|those|these)\s+(?:data|dataset|result|results|rows?)\b|\b(?:it|that)\s+(?:as|into)\b|(?:刚才|之前|上面|上一轮|这些|那些|这个|该)(?:的)?(?:数据|结果|查询结果|分析结果|图表)?)/u;
  const presentation = /(?:\b(?:bar|line|area|pie|radar|scatter|heatmap|funnel)\s+chart\b|\b(?:chart|graph|table|card|tabs?|dashboard|visualization)\b|(?:图表|柱状图|条形图|折线图|面积图|饼图|雷达图|散点图|热力图|漏斗图|表格|卡片|选项卡|标签页|仪表盘|可视化))/u;
  const transform = /(?:\b(?:continue|reuse|restyle|render|visualize|switch|change|convert|show)\b|\bshow\s+(?:it|that|them|the\s+(?:data|result|results))\s+as\b|(?:继续|接着|再|重新)(?:说|展示|显示|渲染|画)?|(?:换成|改成|做成|变成|转成|转换成|展示为|显示为|渲染为|画成|展示|显示|渲染|画|用))/u;
  const exactContinuation = /^(?:continue|go on|继续|继续说|接着|接着说)[.!。！]?$/u;
  if (exactContinuation.test(normalized)) return true;
  if (priorResult.test(normalized) && (presentation.test(normalized) || transform.test(normalized))) return true;
  if (!presentation.test(normalized) || !transform.test(normalized)) return false;

  const newDataRequest = /(?:\b(?:query|fetch|calculate|compute|count|search|find)\b|\bselect\b|\bfrom\s+[a-z0-9_.]+\b|(?:查询|查一下|查找|搜索|统计|计算|多少|数据库|数据表|从.{0,24}表|最近|今天|本周|上周|本月|过去.{0,16}(?:天|周|月|年)|分布|趋势|排名))/u;
  return !newDataRequest.test(normalized);
}

export function isTesseraChartPresentationRequest(message: string): boolean {
  return CHART_PRESENTATION_PATTERN.test(message.trim().toLowerCase());
}

function presentationResourceScopeKey(resourceId: string, threadId: string): string {
  if (resourceId.length === 0 || threadId.length === 0) {
    throw new TypeError("Presentation resource scope requires resourceId and threadId.");
  }
  return JSON.stringify([resourceId, threadId]);
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Presentation resources must be JSON serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

function freezeValue<T extends object>(value: T): T {
  return Object.freeze(value) as T;
}

function evictOldest(
  entries: Map<string, readonly OpenGenerativeDatasetResource[]>,
  maxContexts: number,
): void {
  while (entries.size > maxContexts) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
}
