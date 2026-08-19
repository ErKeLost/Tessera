"use client";

import type { MetricArtifact as MetricArtifactData } from "@data-elements/schema";
import { ArrowDownRightIcon, ArrowUpRightIcon, GaugeIcon, MinusIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

export function MetricArtifact({ artifact, locale = "en-US" }: { artifact: MetricArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const gridClassName = artifact.metrics.length === 1 ? "de-metric-grid de-metric-grid-single" : "de-metric-grid";
  return (
    <Artifact className="de-metric-artifact">
      <ArtifactHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactTitle>{artifact.title}</ArtifactTitle>
            <ArtifactStatus icon={GaugeIcon}>Snapshot</ArtifactStatus>
          </div>
          <ArtifactDescription>{artifact.description}</ArtifactDescription>
        </div>
      </ArtifactHeader>
      <ArtifactContent>
        <div className={`${gridClassName} grid`}>
          {artifact.metrics.map((metric) => {
            const up = metric.change != null && metric.change > 0;
            const down = metric.change != null && metric.change < 0;
            const changeClassName = up
              ? "de-positive"
              : down
                ? "de-negative"
                : "text-muted-foreground";

            return (
              <button
                className={cn("de-quiet-button group min-w-0 touch-manipulation p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20", shape.field)}
                key={metric.id}
                onClick={() => void emit("metric-select", { metricId: metric.id })}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-muted-foreground">{metric.label}</span>
                  {up ? <TrendingUpIcon aria-hidden="true" className="de-positive size-3.5" /> : down ? <TrendingDownIcon aria-hidden="true" className="de-negative size-3.5" /> : <MinusIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />}
                </div>
                <p className="de-metric-value mt-3 font-mono font-semibold tabular-nums">
                  {formatNumber(metric.value, { format: metric.format === "number" ? "number" : metric.format, currency: metric.currency, locale })}
                </p>
                {metric.change != null && (
                  <p className={`mt-1.5 flex items-start gap-1 text-[11px] font-medium ${changeClassName}`}>
                    {up ? <ArrowUpRightIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" /> : down ? <ArrowDownRightIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" /> : null}
                    {metric.change > 0 ? "+" : ""}{metric.change.toFixed(1)}%{metric.changeLabel ? ` · ${metric.changeLabel}` : ""}
                  </p>
                )}
              </button>
            );
          })}
        </div>
        {artifact.footnote && <p className="px-4 py-3 text-[13px] text-muted-foreground sm:px-4">{artifact.footnote}</p>}
      </ArtifactContent>
    </Artifact>
  );
}
