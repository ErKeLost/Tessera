"use client";

import type { CohortArtifact as CohortArtifactData } from "@open-tessera/schema";
import { Grid3X3Icon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import {
  Artifact,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactStatus,
  ArtifactTitle,
} from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

function heatStyle(value: number | null) {
  if (value == null) return undefined;
  const percentage = Math.max(0, Math.min(100, value));
  const opacity = 0.1 + (percentage / 100) * 0.5;
  return {
    background: `color-mix(in oklab, var(--chart-2) ${Math.round(opacity * 100)}%, var(--background))`,
    color: percentage >= 60 ? "var(--background)" : "var(--foreground)",
  };
}

export function CohortArtifact({
  artifact,
  locale = "en-US",
}: {
  artifact: CohortArtifactData;
  locale?: string;
}) {
  const emit = useArtifactAction(artifact);
  return (
    <Artifact className="de-cohort-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={Grid3X3Icon}>Cohort</ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent className="p-4">
        <div className="de-table-viewport overflow-x-auto">
          <div className="de-cohort-table de-table-shell">
            <table className="w-full min-w-[40rem] text-[13px]">
              <caption className="sr-only">
                {artifact.metricLabel} by cohort and elapsed period
              </caption>
              <thead>
                <tr className="de-field text-left font-mono text-[11px] tracking-tight text-muted-foreground">
                  <th
                    className="sticky left-0 z-10 min-w-28 bg-muted px-3 py-2.5 sm:px-4"
                    scope="col"
                  >
                    Cohort
                  </th>
                  <th className="w-20 px-2 py-2.5 text-right" scope="col">
                    Size
                  </th>
                  {artifact.periods.map((period) => (
                    <th
                      className="min-w-16 px-1.5 py-2.5 text-center"
                      key={period}
                      scope="col"
                    >
                      {period}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {artifact.cohorts.map((cohort) => (
                  <tr className="border-b de-row last:border-0" key={cohort.id}>
                    <th
                      className="sticky left-0 z-10 bg-background px-3 py-2.5 text-left font-medium sm:px-4"
                      scope="row"
                    >
                      {cohort.label}
                    </th>
                    <td className="px-2 py-2.5 text-right font-mono text-muted-foreground tabular-nums">
                      {cohort.size.toLocaleString(locale)}
                    </td>
                    {cohort.values.map((value, periodIndex) => (
                      <td
                        className="p-1"
                        key={`${cohort.id}-${artifact.periods[periodIndex]}`}
                      >
                        <button
                          aria-label={`${cohort.label}, ${artifact.periods[periodIndex]}: ${value == null ? "not available" : `${value.toFixed(1)}%`}`}
                          className={cn(
                            "de-cohort-cell h-9 w-full border font-mono text-[11px] font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:cursor-default",
                            shape.indicator,
                          )}
                          disabled={value == null}
                          onClick={
                            value == null
                              ? undefined
                              : () =>
                                  void emit("cohort-cell-select", {
                                    cohortId: cohort.id,
                                    periodIndex,
                                    value,
                                  })
                          }
                          style={heatStyle(value)}
                          type="button"
                        >
                          {value == null ? "-" : `${value.toFixed(1)}%`}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="de-field mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl px-3.5 py-2.5 text-[11px] text-muted-foreground">
          <span>{artifact.metricLabel}</span>
          <span className="inline-flex items-center gap-1.5">
            <span>Lower</span>
            {[18, 36, 54, 72, 90].map((value) => (
              <span
                aria-hidden="true"
                className={cn("size-3", shape.indicator)}
                key={value}
                style={heatStyle(value)}
              />
            ))}
            <span>Higher</span>
          </span>
        </div>
        {artifact.insight && (
          <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
            {artifact.insight}
          </p>
        )}
      </ArtifactContent>
    </Artifact>
  );
}
