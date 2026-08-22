"use client";

import type {
  ChartCellValue,
  DataMetricProps,
  DataQueryDetailsProps,
  DataTableProps,
} from "@open-generative/components";
import type { RendererInput } from "@open-generative/react";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Clipboard,
  Download,
  Minus,
} from "lucide-react";
import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { canEmit, emitEvent, officialRendererEventPorts } from "./events";
import { formatValue } from "./format";
import {
  Badge,
  Button,
  IconButton,
  Select,
  Surface,
  classes,
} from "./primitives";

type ExportFormat = "csv" | "json" | "xlsx";

export function DataMetricRenderer(input: RendererInput<DataMetricProps>) {
  const { resolvedProps, slots } = input;
  const interactive = canEmit(input, officialRendererEventPorts.select);
  const comparisonTone = metricComparisonTone(resolvedProps);
  const activate = () => emitEvent(input, officialRendererEventPorts.select, {});
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };
  return (
    <Surface
      aria-label={resolvedProps.label}
      className={classes(
        "og-metric",
        interactive && "og-metric-interactive",
        resolvedProps.tone && `og-tone-${resolvedProps.tone.replace(".", "-")}`,
      )}
      data-og-component="data.metric"
      onClick={interactive ? activate : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
      role="group"
      tabIndex={interactive ? 0 : undefined}
    >
      <span className="og-metric-label">{resolvedProps.label}</span>
      <strong className="og-metric-value">{formatValue(resolvedProps.value, resolvedProps.format)}</strong>
      {resolvedProps.comparison ? (
        <span className={classes("og-metric-comparison", `og-metric-comparison-${comparisonTone}`)}>
          <ComparisonIcon tone={comparisonTone} />
          <span>{formatValue(resolvedProps.comparison.value, resolvedProps.comparison.format)}</span>
          {resolvedProps.comparison.label ? <span className="og-metric-comparison-label">{resolvedProps.comparison.label}</span> : null}
        </span>
      ) : null}
      {slots.details?.length ? <div className="og-metric-details">{slots.details}</div> : null}
    </Surface>
  );
}

function ComparisonIcon({ tone }: { tone: "positive" | "negative" | "neutral" }) {
  const Icon = tone === "positive" ? ArrowUp : tone === "negative" ? ArrowDown : Minus;
  return <Icon aria-hidden="true" size={14} strokeWidth={2} />;
}

function metricComparisonTone(props: DataMetricProps): "positive" | "negative" | "neutral" {
  const comparison = props.comparison;
  if (comparison === undefined || comparison.direction === "neutral" || typeof comparison.value !== "number" || comparison.value === 0) {
    return "neutral";
  }
  const favorable = comparison.direction === "higher-is-better"
    ? comparison.value > 0
    : comparison.value < 0;
  return favorable ? "positive" : "negative";
}

export function DataTableRenderer(input: RendererInput<DataTableProps>) {
  const { resolvedProps, slots } = input;
  const canExport = canEmit(input, officialRendererEventPorts.export);
  const canPage = canEmit(input, officialRendererEventPorts.pageChange);
  const canSelectRows = canEmit(input, officialRendererEventPorts.rowSelect);
  const canSort = canEmit(input, officialRendererEventPorts.sortChange);
  const selectionGroupName = useId();
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const { rows, totalRows, hasMore } = resolvedProps.data;
  const page = resolvedProps.pagination?.page ?? 0;
  const pageSize = resolvedProps.pagination?.pageSize ?? Math.max(rows.length, 1);
  const knownPages = totalRows === undefined ? undefined : Math.max(1, Math.ceil(totalRows / pageSize));
  const canGoBack = canPage && page > 0;
  const canGoForward = canPage && (knownPages === undefined ? hasMore : page + 1 < knownPages);
  const selectedIds = resolvedProps.selection?.selectedRowIds ?? [];

  return (
    <Surface className="og-table-surface" data-og-component="data.table" role="region">
      {slots.toolbar?.length || canExport ? (
        <div className="og-data-toolbar">
          <div className="og-data-toolbar-slot">{slots.toolbar}</div>
          {canExport ? (
            <div className="og-export-control">
              <Select
                aria-label="Export format"
                onChange={(event) => setExportFormat(event.currentTarget.value as ExportFormat)}
                value={exportFormat}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="xlsx">Excel</option>
              </Select>
              <IconButton
                icon={Download}
                label={`Export ${exportFormat.toUpperCase()}`}
                onClick={() => emitEvent(input, officialRendererEventPorts.export, { format: exportFormat })}
                variant="outline"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="og-table-viewport">
        <table className={classes("og-table", `og-table-${resolvedProps.density}`)}>
          <caption className="og-sr-only">Data table</caption>
          <thead>
            <tr>
              {resolvedProps.selection?.mode !== "none" && resolvedProps.selection !== undefined ? (
                <th className="og-selection-column" scope="col"><span className="og-sr-only">Select row</span></th>
              ) : null}
              {resolvedProps.columns.map((column) => {
                const activeSort = resolvedProps.sort?.keys.find((key) => key.column === column.column);
                return (
                  <th
                    className={`og-column-${column.width}`}
                    data-align={column.align}
                    key={column.column}
                    scope="col"
                  >
                    {column.sortable && canSort ? (
                      <button
                        aria-label={`Sort ${column.label} ${activeSort?.direction === "ascending" ? "descending" : "ascending"}`}
                        className="og-sort-button"
                        onClick={() => emitEvent(input, officialRendererEventPorts.sortChange, {
                          column: column.column,
                          direction: activeSort?.direction === "ascending" ? "descending" : "ascending",
                        })}
                        type="button"
                      >
                        {column.label}
                        <SortIcon direction={activeSort?.direction} />
                      </button>
                    ) : column.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="og-table-empty" colSpan={resolvedProps.columns.length + (resolvedProps.selection?.mode !== "none" ? 1 : 0)}>
                  No rows in this window.
                </td>
              </tr>
            ) : rows.map((row, rowIndex) => {
              const rowId = getRowId(resolvedProps, row, rowIndex);
              const selectable = canSelectRows && rowId !== undefined && resolvedProps.selection?.mode !== "none";
              const selected = rowId !== undefined && selectedIds.some((candidate) => Object.is(candidate, rowId));
              return (
                <tr
                  aria-selected={resolvedProps.selection?.mode !== "none" ? selected : undefined}
                  className={selectable ? "og-table-row-selectable" : undefined}
                  data-selected={selected || undefined}
                  key={rowId === undefined ? rowIndex : `${typeof rowId}:${rowId}`}
                  onClick={selectable ? () => emitEvent(input, officialRendererEventPorts.rowSelect, { rowId }) : undefined}
                >
                  {resolvedProps.selection?.mode !== "none" && resolvedProps.selection !== undefined ? (
                    <td className="og-selection-column">
                      <input
                        aria-label={`Select row ${rowIndex + 1}`}
                        checked={selected}
                        disabled={!selectable}
                        name={resolvedProps.selection.mode === "single" ? `og-table-${selectionGroupName}` : undefined}
                        onChange={() => {
                          if (rowId !== undefined) emitEvent(input, officialRendererEventPorts.rowSelect, { rowId });
                        }}
                        onClick={(event: MouseEvent<HTMLInputElement>) => event.stopPropagation()}
                        type={resolvedProps.selection.mode === "single" ? "radio" : "checkbox"}
                      />
                    </td>
                  ) : null}
                  {resolvedProps.columns.map((column) => (
                    <td data-align={column.align} key={column.column} title={formatValue(row[column.column], column.format)}>
                      {formatValue(row[column.column], column.format)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {resolvedProps.pagination ? (
        <div className="og-pagination">
          <span>
            {rows.length === 0 ? 0 : page * pageSize + 1}-{page * pageSize + rows.length}
            {totalRows === undefined ? " rows" : ` of ${totalRows}`}
          </span>
          <div className="og-pagination-actions">
            <IconButton
              disabled={!canGoBack}
              icon={ArrowLeft}
              label="Previous page"
              onClick={() => emitEvent(input, officialRendererEventPorts.pageChange, { page: page - 1 })}
              variant="ghost"
            />
            <span aria-live="polite">Page {page + 1}{knownPages === undefined ? "" : ` of ${knownPages}`}</span>
            <IconButton
              disabled={!canGoForward}
              icon={ArrowRight}
              label="Next page"
              onClick={() => emitEvent(input, officialRendererEventPorts.pageChange, { page: page + 1 })}
              variant="ghost"
            />
          </div>
        </div>
      ) : null}
    </Surface>
  );
}

function SortIcon({ direction }: { direction?: "ascending" | "descending" }) {
  const Icon = direction === "ascending" ? ArrowUp : direction === "descending" ? ArrowDown : ArrowDownUp;
  return <Icon aria-hidden="true" size={14} />;
}

function getRowId(
  props: DataTableProps,
  row: Readonly<Record<string, ChartCellValue>>,
  rowIndex: number,
): string | number | undefined {
  if (props.selection?.mode === "none" || props.selection?.rowIdColumn === undefined) return undefined;
  const candidate = row[props.selection.rowIdColumn];
  if (typeof candidate === "string" || typeof candidate === "number") return candidate;
  return undefined;
}

export function DataQueryDetailsRenderer(input: RendererInput<DataQueryDetailsProps>) {
  const { resolvedProps, slots } = input;
  const { details } = resolvedProps;
  const canCopy = canEmit(input, officialRendererEventPorts.copy);
  const canExport = canEmit(input, officialRendererEventPorts.export);
  const tabsId = useId();
  const [section, setSection] = useState(resolvedProps.defaultSection);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");

  useEffect(() => {
    if (!resolvedProps.sections.includes(section)) setSection(resolvedProps.defaultSection);
  }, [resolvedProps.defaultSection, resolvedProps.sections, section]);

  return (
    <Surface aria-label={`Query ${details.queryId} details`} className="og-query-details" data-og-component="data.query-details">
      <header className="og-query-header">
        <div>
          <span className="og-query-eyebrow">Query details</span>
          <strong>{details.queryId}</strong>
        </div>
        <Badge tone={queryStatusTone(details.status)}>{details.status}</Badge>
      </header>
      <div aria-label="Query detail sections" className="og-tabs" role="tablist">
        {resolvedProps.sections.map((candidate) => (
          <button
            aria-controls={`${tabsId}-${candidate}`}
            aria-selected={candidate === section}
            className="og-tab"
            id={`${tabsId}-${candidate}-tab`}
            key={candidate}
            onClick={() => setSection(candidate)}
            role="tab"
            tabIndex={candidate === section ? 0 : -1}
            type="button"
          >
            {sectionLabel(candidate)}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${tabsId}-${section}-tab`}
        className="og-tab-panel"
        id={`${tabsId}-${section}`}
        role="tabpanel"
      >
        {renderQuerySection(section, resolvedProps)}
      </div>
      {slots.actions?.length || canCopy || canExport ? (
        <div className="og-query-actions">
          <div>{slots.actions}</div>
          {canCopy || canExport ? (
            <div className="og-export-control">
              {details.sql && canCopy ? (
                <IconButton
                  icon={Clipboard}
                  label="Copy query"
                  onClick={() => emitEvent(input, officialRendererEventPorts.copy, {})}
                  variant="ghost"
                />
              ) : null}
              {canExport ? (
                <>
                  <Select
                    aria-label="Export format"
                    onChange={(event) => setExportFormat(event.currentTarget.value as ExportFormat)}
                    value={exportFormat}
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                    <option value="xlsx">Excel</option>
                  </Select>
                  <IconButton
                    icon={Download}
                    label={`Export ${exportFormat.toUpperCase()}`}
                    onClick={() => emitEvent(input, officialRendererEventPorts.export, { format: exportFormat })}
                    variant="outline"
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Surface>
  );
}

function renderQuerySection(
  section: DataQueryDetailsProps["sections"][number],
  props: DataQueryDetailsProps,
) {
  const details = props.details;
  if (section === "summary") {
    return (
      <dl className="og-query-summary">
        <div><dt>Status</dt><dd>{details.status}</dd></div>
        <div><dt>Duration</dt><dd>{details.durationMs === undefined ? "-" : `${formatValue(details.durationMs)} ms`}</dd></div>
        <div><dt>Rows</dt><dd>{formatValue(details.rowCount)}</dd></div>
        <div><dt>Evidence</dt><dd>{details.evidence.length}</dd></div>
      </dl>
    );
  }
  if (section === "sql") {
    return details.sql ? <pre className="og-sql"><code>{details.sql}</code></pre> : <p className="og-unavailable">SQL was not disclosed by the host.</p>;
  }
  if (section === "lineage") {
    return details.lineage.length ? (
      <ol className="og-lineage">
        {details.lineage.map((item, index) => (
          <li key={`${index}:${item.kind}:${item.label}`}>
            <Badge>{item.kind}</Badge>
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
    ) : <p className="og-unavailable">No lineage was disclosed.</p>;
  }
  if (section === "freshness") {
    return details.freshness ? (
      <div className="og-freshness">
        <Badge tone={details.freshness.status === "fresh" ? "positive" : details.freshness.status === "stale" ? "warning" : "default"}>
          {details.freshness.status}
        </Badge>
        <time dateTime={details.freshness.observedAt}>{formatValue(details.freshness.observedAt, { kind: "datetime", dateStyle: "medium", timeStyle: "short" })}</time>
      </div>
    ) : <p className="og-unavailable">Freshness is unknown.</p>;
  }
  return details.evidence.length ? (
    <ul className="og-evidence-list">
      {details.evidence.map((item, index) => (
        <li key={`${index}:${item.label}`}><strong>{item.label}</strong><p>{item.summary}</p></li>
      ))}
    </ul>
  ) : <p className="og-unavailable">No evidence was disclosed.</p>;
}

function queryStatusTone(status: DataQueryDetailsProps["details"]["status"]): "positive" | "negative" | "default" {
  return status === "succeeded" ? "positive" : status === "failed" ? "negative" : "default";
}

function sectionLabel(section: DataQueryDetailsProps["sections"][number]): string {
  return section === "sql" ? "SQL" : `${section[0]!.toUpperCase()}${section.slice(1)}`;
}
