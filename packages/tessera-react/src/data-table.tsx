"use client";

import type { QueryArtifact } from "@open-tessera/schema";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  ChevronUpIcon,
  SearchIcon,
} from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { useArtifactUI } from "./bridge";
import { control, field, layout, shape, typography } from "./tokens";
import { cn, formatDataValue } from "./utils";

export type DataTableProps = {
  artifact: QueryArtifact;
  locale?: string;
  pageSize?: number;
  searchable?: boolean;
};

type SortState = { key: string; direction: "asc" | "desc" } | undefined;

function isNumericColumn(type: QueryArtifact["columns"][number]["type"]) {
  return type === "number";
}

function compareValues(left: unknown, right: unknown) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  if (typeof left === "boolean" && typeof right === "boolean")
    return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function DataTable({
  artifact,
  locale = "en-US",
  pageSize = 10,
  searchable = true,
}: DataTableProps) {
  const { themeVariables } = useArtifactUI();
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>();

  const rows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    const filtered = normalizedQuery
      ? artifact.rows.filter((row) =>
          artifact.columns.some((column) =>
            String(row[column.key] ?? "")
              .toLocaleLowerCase(locale)
              .includes(normalizedQuery),
          ),
        )
      : artifact.rows;
    if (!sort) return filtered;
    return [...filtered].sort(
      (left, right) =>
        compareValues(left[sort.key], right[sort.key]) *
        (sort.direction === "asc" ? 1 : -1),
    );
  }, [artifact.columns, artifact.rows, locale, query, sort]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = rows.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  const toggleSort = (key: string) => {
    setSort((current) =>
      current?.key === key
        ? current.direction === "asc"
          ? { key, direction: "desc" }
          : undefined
        : { key, direction: "asc" },
    );
    setPage(0);
  };

  return (
    <div
      className="de-data-table de-theme-root min-w-0 overflow-hidden"
      data-slot="data-table"
      style={themeVariables}
    >
      {searchable && (
        <div
          className="de-data-table-toolbar flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          data-slot="data-table-toolbar"
        >
          <label className="relative min-w-48 flex-1 sm:max-w-xs">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <span className="sr-only">Search table rows</span>
            <input
              autoComplete="off"
              className={cn(
                control.input,
                "h-8 w-full pl-8 pr-3 text-[13px] placeholder:text-muted-foreground",
                shape.control,
              )}
              name="data-table-filter"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Filter rows…"
              type="search"
              value={query}
            />
          </label>
          <span
            aria-live="polite"
            className={cn(typography.metadata, "tabular-nums")}
          >
            {rows.length.toLocaleString(locale)} matching rows
          </span>
        </div>
      )}

      <div
        className="de-table-viewport max-h-[430px] overflow-auto"
        data-slot="data-table-viewport"
      >
        <table
          className="de-data-table-table w-full text-[13px]"
          data-slot="data-table-table"
          style={{
            "--de-data-table-column-count": artifact.columns.length,
          } as CSSProperties}
        >
          <caption className="sr-only">{artifact.title}</caption>
          <colgroup>
            {artifact.columns.map((column) => (
              <col
                className={cn(
                  "de-data-table-data-column",
                  isNumericColumn(column.type) && "is-numeric",
                )}
                key={column.key}
              />
            ))}
          </colgroup>
          <thead className={cn(field, "sticky top-0 z-10 backdrop-blur-md")}>
            <tr>
              {artifact.columns.map((column) => {
                const active = sort?.key === column.key;
                const SortIcon = !active
                  ? ChevronsUpDownIcon
                  : sort.direction === "asc"
                    ? ChevronUpIcon
                    : ChevronDownIcon;
                const numeric = isNumericColumn(column.type);
                return (
                  <th
                    className={cn(
                      "de-data-table-column border-b px-4 py-2.5 whitespace-nowrap",
                      numeric ? "text-right" : "text-left",
                      layout.divider,
                    )}
                    data-column-align={numeric ? "end" : "start"}
                    key={column.key}
                    scope="col"
                  >
                    <button
                      aria-label={`Sort by ${column.label}`}
                      className={cn(
                        control.iconButton,
                        "de-control group flex w-full min-w-0 max-w-full touch-manipulation items-center gap-1.5 text-muted-foreground hover:text-foreground",
                        numeric ? "justify-end text-right" : "justify-start text-left",
                      )}
                      onClick={() => toggleSort(column.key)}
                      type="button"
                    >
                      <span className="de-data-table-column-details">
                        <span
                          className={cn(
                            typography.metadata,
                            "de-data-table-column-label block font-semibold text-foreground",
                          )}
                        >
                          {column.label}
                        </span>
                        <span
                          className={cn(
                            typography.metadata,
                            "de-data-table-column-type block pt-0.5 font-normal text-muted-foreground",
                          )}
                        >
                          {column.type}
                        </span>
                      </span>
                      <SortIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3 shrink-0",
                          active
                            ? "text-foreground"
                            : "text-muted-foreground transition-colors group-hover:text-foreground",
                        )}
                      />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length > 0 ? (
              visibleRows.map((row, index) => (
                <tr
                  className={cn("border-b last:border-0", layout.tableRow)}
                  key={`${artifact.id}-${safePage}-${index}`}
                >
                  {artifact.columns.map((column) => {
                    const formatted = formatDataValue(row[column.key], locale);
                    return (
                      <td
                        className={cn(
                          typography.metadata,
                          "de-data-table-cell px-4 py-2.5 tabular-nums whitespace-nowrap text-foreground",
                          isNumericColumn(column.type)
                            ? "text-right"
                            : "text-left",
                        )}
                        data-column-align={
                          isNumericColumn(column.type) ? "end" : "start"
                        }
                        key={column.key}
                      >
                        <span className="de-data-table-cell-content" title={formatted}>
                          {formatted}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  className={cn(
                    typography.title,
                    "px-4 py-12 text-center text-muted-foreground",
                  )}
                  colSpan={artifact.columns.length}
                >
                  No rows match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div
        className={cn(
          typography.metadata,
          "de-data-table-footer flex items-center justify-between gap-3 border-t px-4 py-2.5",
          layout.divider,
        )}
        data-slot="data-table-footer"
      >
        <span>
          {visibleRows.length
            ? `${(safePage * pageSize + 1).toLocaleString(locale)}-${Math.min((safePage + 1) * pageSize, rows.length).toLocaleString(locale)}`
            : "0"}{" "}
          of {rows.length.toLocaleString(locale)}
        </span>
        <div className="flex items-center gap-1">
          <button
            aria-label="Previous page"
            className={cn(
              control.iconButton,
              "de-control grid size-8 touch-manipulation place-items-center text-foreground disabled:cursor-not-allowed disabled:opacity-40",
            )}
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            title="Previous page"
            type="button"
          >
            <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
          </button>
          <span className="min-w-20 text-center">
            Page {safePage + 1} of {pageCount}
          </span>
          <button
            aria-label="Next page"
            className={cn(
              control.iconButton,
              "de-control grid size-8 touch-manipulation place-items-center text-foreground disabled:cursor-not-allowed disabled:opacity-40",
            )}
            disabled={safePage >= pageCount - 1}
            onClick={() =>
              setPage((current) => Math.min(pageCount - 1, current + 1))
            }
            title="Next page"
            type="button"
          >
            <ChevronRightIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
