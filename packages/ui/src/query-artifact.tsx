"use client";

import type { QueryArtifact as QueryArtifactData } from "@open-tessera/schema";
import * as Tabs from "@radix-ui/react-tabs";
import {
  ChartNoAxesCombinedIcon,
  CheckIcon,
  Code2Icon,
  CopyIcon,
  DatabaseIcon,
  DownloadIcon,
  GitBranchIcon,
  Table2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  useArtifactAction,
  useArtifactActionAvailability,
  useArtifactUI,
} from "./bridge";
import { DataChart } from "./data-chart";
import { DataTable } from "./data-table";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

function downloadCsv(artifact: QueryArtifactData) {
  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [
    artifact.columns.map((column) => escape(column.label)).join(","),
    ...artifact.rows.map((row) =>
      artifact.columns.map((column) => escape(row[column.key])).join(","),
    ),
  ].join("\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${artifact.title.replaceAll(/\s+/g, "-").toLowerCase()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function hasRenderableChart(artifact: QueryArtifactData) {
  const chart = artifact.chart;
  if (!chart || artifact.rows.length === 0) return false;

  const columnByKey = new Map(
    artifact.columns.map((column) => [column.key, column]),
  );
  if (!columnByKey.has(chart.xKey)) return false;
  if (!chart.yKeys.every((key) => columnByKey.get(key)?.type === "number")) {
    return false;
  }

  return artifact.rows.some(
    (row) =>
      row[chart.xKey] != null &&
      chart.yKeys.some(
        (key) => typeof row[key] === "number" && Number.isFinite(row[key]),
      ),
  );
}

export function QueryArtifact({
  artifact,
  locale = "en-US",
  defaultView,
}: {
  artifact: QueryArtifactData;
  locale?: string;
  defaultView?: "chart" | "table" | "sql" | "lineage";
}) {
  const [copied, setCopied] = useState(false);
  const emit = useArtifactAction(artifact);
  const canExport = useArtifactActionAvailability(artifact, "export-query", {
    brokered: true,
  });
  const { isLegacyActionBridge } = useArtifactUI();
  const hasChart = hasRenderableChart(artifact);
  const initialView = defaultView === "chart" && !hasChart
    ? "table"
    : defaultView ?? (hasChart ? "chart" : "table");
  const timestamp = useMemo(
    () =>
      artifact.queriedAt
        ? new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(artifact.queriedAt))
        : undefined,
    [artifact.queriedAt, locale],
  );
  const copySql = async () => {
    await navigator.clipboard.writeText(artifact.sql);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const exportCsv = () => {
    if (isLegacyActionBridge) downloadCsv(artifact);
    void emit("export-query", { format: "csv" }, { brokered: true });
  };

  const triggerClass = cn(
    "de-control de-tab-trigger inline-flex h-7 items-center gap-1.5 px-3 text-[13px] font-medium",
    shape.control,
  );
  return (
    <Artifact className="de-query-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={DatabaseIcon}>Read-only</ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
        {canExport && (
          <ArtifactActions>
            <ArtifactAction
              icon={DownloadIcon}
              label="Download CSV"
              onClick={exportCsv}
            />
          </ArtifactActions>
        )}
      </ArtifactHeader>
      <div className="de-field flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 font-mono text-[11px] tracking-tight font-medium text-muted-foreground sm:px-4">
        <span className="tabular-nums">
          {artifact.rowCount.toLocaleString(locale)} rows
          {artifact.truncated ? " · truncated" : ""}
        </span>
        {artifact.durationMs != null && (
          <span className="tabular-nums">
            {artifact.durationMs.toLocaleString(locale)} ms
          </span>
        )}
        {timestamp && <span className="font-sans">{timestamp}</span>}
        {artifact.sourceTables.length > 0 && (
          <span className="flex min-w-0 items-center gap-1.5">
            <DatabaseIcon
              aria-hidden="true"
              className="size-3 shrink-0 text-muted-foreground"
            />
            <span className="truncate">{artifact.sourceTables.join(", ")}</span>
          </span>
        )}
      </div>
      <ArtifactContent>
        <Tabs.Root
          defaultValue={initialView}
        >
          <div className="overflow-x-auto px-4 pt-3 sm:px-4">
            <Tabs.List
              aria-label="Query result view"
              className={cn(
                "de-field flex w-max items-center gap-1 p-1",
                shape.field,
              )}
            >
              {hasChart && (
                <Tabs.Trigger className={triggerClass} value="chart">
                  <ChartNoAxesCombinedIcon
                    aria-hidden="true"
                    className="size-3.5"
                  />
                  Chart
                </Tabs.Trigger>
              )}
              <Tabs.Trigger className={triggerClass} value="table">
                <Table2Icon aria-hidden="true" className="size-3.5" />
                Table
              </Tabs.Trigger>
              <Tabs.Trigger className={triggerClass} value="sql">
                <Code2Icon aria-hidden="true" className="size-3.5" />
                SQL
              </Tabs.Trigger>
              <Tabs.Trigger className={triggerClass} value="lineage">
                <GitBranchIcon aria-hidden="true" className="size-3.5" />
                Lineage
              </Tabs.Trigger>
            </Tabs.List>
          </div>
          {hasChart && (
            <Tabs.Content
              className="px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4 sm:py-4"
              value="chart"
            >
              <DataChart
                chart={artifact.chart}
                locale={locale}
                rows={artifact.rows}
              />
            </Tabs.Content>
          )}
          <Tabs.Content
            className="py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20"
            value="table"
          >
            <DataTable artifact={artifact} locale={locale} />
          </Tabs.Content>
          <Tabs.Content
            className="px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4 sm:py-4"
            value="sql"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="font-mono text-[11px] tracking-tight text-muted-foreground">
                Validated query · read-only transaction
              </p>
              <button
                className="de-control inline-flex h-7 touch-manipulation items-center gap-1.5 px-3 text-[13px] font-medium"
                onClick={copySql}
                type="button"
              >
                {copied ? (
                  <CheckIcon
                    aria-hidden="true"
                    className="de-positive size-3.5"
                  />
                ) : (
                  <CopyIcon aria-hidden="true" className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              className={cn(
                "de-field overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6",
                shape.field,
              )}
            >
              <code>
                {artifact.sql || "-- SQL was not included in this artifact."}
              </code>
            </pre>
          </Tabs.Content>
          <Tabs.Content
            className="space-y-4 px-4 py-4 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:px-4 sm:py-4"
            value="lineage"
          >
            <div>
              <p className="text-[13px] font-medium text-muted-foreground">
                Metric definition
              </p>
              <p className="mt-1.5 leading-6">
                {artifact.metricDefinition || "No metric definition provided."}
              </p>
            </div>
            <div className="de-divider grid gap-4 border-y py-4 sm:grid-cols-2">
              <div>
                <p className="text-[13px] font-medium text-muted-foreground">
                  Business timezone
                </p>
                <p className="mt-1.5 font-mono text-[13px]">
                  {artifact.timeZone}
                </p>
              </div>
              <div>
                <p className="text-[13px] font-medium text-muted-foreground">
                  Filters
                </p>
                <p className="mt-1.5 text-[13px]">
                  {artifact.filters.length
                    ? artifact.filters.join(" · ")
                    : "No additional filters"}
                </p>
              </div>
            </div>
            {artifact.warnings.map((warning) => (
              <p
                className="de-warning-callout flex gap-2 border-l-2 px-3 py-2 text-[13px]"
                key={warning}
              >
                <TriangleAlertIcon
                  aria-hidden="true"
                  className="de-warning mt-px size-3.5 shrink-0"
                />
                {warning}
              </p>
            ))}
            <div className="de-source-list">
              {artifact.sourceTables.map((table) => (
                <div className="flex items-center gap-3" key={table}>
                  <span
                    className={cn(
                      "de-field grid size-7 place-items-center text-muted-foreground",
                      shape.inner,
                    )}
                  >
                    <DatabaseIcon aria-hidden="true" className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="break-words font-mono text-[13px]">{table}</p>
                    <p className="text-[13px] text-muted-foreground">
                      Approved catalog source
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </ArtifactContent>
    </Artifact>
  );
}
