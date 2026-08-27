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
 * durable Memory. The owning Agent serializes each scope's turns.
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

  const priorResult = /(?:\b(?:same|previous|prior|above|earlier|last|those|these)\s+(?:data|dataset|result|results|rows?)\b|\b(?:it|that)\s+(?:as|into)\b|(?:\u521a\u624d|\u4e4b\u524d|\u4e0a\u9762|\u4e0a\u4e00\u8f6e|\u8fd9\u4e9b|\u90a3\u4e9b|\u8fd9\u4e2a|\u8be5)(?:\u7684)?(?:\u6570\u636e|\u7ed3\u679c|\u67e5\u8be2\u7ed3\u679c|\u5206\u6790\u7ed3\u679c|\u56fe\u8868)?)/u;
  const presentation = /(?:\b(?:bar|line|area|pie|radar|scatter|heatmap|funnel)\s+chart\b|\b(?:chart|graph|table|card|tabs?|dashboard|visualization)\b|(?:\u56fe\u8868|\u67f1\u72b6\u56fe|\u6761\u5f62\u56fe|\u6298\u7ebf\u56fe|\u9762\u79ef\u56fe|\u997c\u56fe|\u96f7\u8fbe\u56fe|\u6563\u70b9\u56fe|\u70ed\u529b\u56fe|\u6f0f\u6597\u56fe|\u8868\u683c|\u5361\u7247|\u9009\u9879\u5361|\u6807\u7b7e\u9875|\u4eea\u8868\u76d8|\u53ef\u89c6\u5316))/u;
  const transform = /(?:\b(?:continue|reuse|restyle|render|visualize|switch|change|convert|show)\b|\bshow\s+(?:it|that|them|the\s+(?:data|result|results))\s+as\b|(?:\u7ee7\u7eed|\u63a5\u7740|\u518d|\u91cd\u65b0)(?:\u8bf4|\u5c55\u793a|\u663e\u793a|\u6e32\u67d3|\u753b)?|(?:\u6362\u6210|\u6539\u6210|\u505a\u6210|\u53d8\u6210|\u8f6c\u6210|\u8f6c\u6362\u6210|\u5c55\u793a\u4e3a|\u663e\u793a\u4e3a|\u6e32\u67d3\u4e3a|\u753b\u6210|\u5c55\u793a|\u663e\u793a|\u6e32\u67d3|\u753b|\u7528))/u;
  const exactContinuation = /^(?:continue|go on|\u7ee7\u7eed|\u7ee7\u7eed\u8bf4|\u63a5\u7740|\u63a5\u7740\u8bf4)[.!\u3002\uff01]?$/u;
  if (exactContinuation.test(normalized)) return true;
  if (priorResult.test(normalized) && (presentation.test(normalized) || transform.test(normalized))) return true;
  if (!presentation.test(normalized) || !transform.test(normalized)) return false;

  const newDataRequest = /(?:\b(?:query|fetch|calculate|compute|count|search|find)\b|\bselect\b|\bfrom\s+[a-z0-9_.]+\b|(?:\u67e5\u8be2|\u67e5\u4e00\u4e0b|\u67e5\u627e|\u641c\u7d22|\u7edf\u8ba1|\u8ba1\u7b97|\u591a\u5c11|\u6570\u636e\u5e93|\u6570\u636e\u8868|\u4ece.{0,24}\u8868|\u6700\u8fd1|\u4eca\u5929|\u672c\u5468|\u4e0a\u5468|\u672c\u6708|\u8fc7\u53bb.{0,16}(?:\u5929|\u5468|\u6708|\u5e74)|\u5206\u5e03|\u8d8b\u52bf|\u6392\u540d))/u;
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
