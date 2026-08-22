"use client";

import type { TargetArtifact as TargetArtifactData } from "@open-tessera/schema";
import { CircleCheckIcon, CircleXIcon, GaugeIcon, TargetIcon, TriangleAlertIcon } from "lucide-react";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn, formatNumber } from "./utils";

const statusStyles = {
  "on-track": { icon: GaugeIcon, label: "On track", className: "de-positive" },
  "at-risk": { icon: TriangleAlertIcon, label: "At risk", className: "de-warning" },
  "off-track": { icon: CircleXIcon, label: "Off track", className: "de-negative" },
  achieved: { icon: CircleCheckIcon, label: "Achieved", className: "de-positive" },
} as const;

function targetProgress(artifact: TargetArtifactData): { label: string; value: number } | undefined {
  const { actual, baseline, direction, target } = artifact;
  let ratio: number;
  if (baseline != null) {
    if (baseline === target) return undefined;
    ratio = direction === "higher-is-better"
      ? (actual - baseline) / (target - baseline)
      : (baseline - actual) / (baseline - target);
    return {
      label: "Progress from baseline",
      value: Math.min(100, Math.max(0, Number.isFinite(ratio) ? ratio * 100 : 0)),
    };
  }

  // A zero-origin attainment ratio is only meaningful for positive targets.
  // Zero and negative goals need an explicit baseline to avoid inventing progress.
  if (target > 0) {
    ratio = direction === "higher-is-better"
      ? actual / target
      : actual <= target ? 1 : target / actual;
    return {
      label: "Target attainment",
      value: Math.min(100, Math.max(0, Number.isFinite(ratio) ? ratio * 100 : 0)),
    };
  }

  return undefined;
}

function formatDeadline(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value));
}

export function TargetArtifact({ artifact, locale = "en-US" }: { artifact: TargetArtifactData; locale?: string }) {
  const numberOptions = { format: artifact.format, currency: artifact.currency, locale } as const;
  const progress = targetProgress(artifact);
  const status = statusStyles[artifact.status];
  const StatusIcon = status.icon;
  const gap = artifact.direction === "higher-is-better" ? artifact.target - artifact.actual : artifact.actual - artifact.target;
  const directionLabel = artifact.direction === "higher-is-better" ? "Higher is better" : "Lower is better";

  return <Artifact className="de-target-artifact">
    <ArtifactHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><ArtifactTitle>{artifact.title}</ArtifactTitle><ArtifactStatus className={status.className} icon={StatusIcon}>{status.label}</ArtifactStatus></div>
        <ArtifactDescription>{artifact.description}</ArtifactDescription>
      </div>
    </ArtifactHeader>
    <ArtifactContent className="p-4 sm:p-4">
      <div className={cn("de-field flex flex-wrap items-end justify-between gap-4 px-4 py-3", shape.field)}>
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground">{artifact.metricLabel}</p>
          <p className="mt-1 font-mono text-3xl font-semibold tabular-nums">{formatNumber(artifact.actual, numberOptions)}</p>
        </div>
        <div className="text-right">
          <p className="text-[13px] text-muted-foreground">Target</p>
          <p className="mt-1 font-mono text-lg font-semibold tabular-nums">{formatNumber(artifact.target, numberOptions)}</p>
        </div>
      </div>

      {progress && <div className="py-4">
        <div className="mb-2 flex items-center justify-between gap-3 text-[11px]">
          <span className="font-medium text-muted-foreground">{progress.label}</span>
          <span className="font-mono font-semibold tabular-nums">{progress.value.toFixed(0)}%</span>
        </div>
        <div aria-label={`${artifact.metricLabel} target progress ${progress.value.toFixed(0)} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={progress.value} className="de-progress-track" role="progressbar">
          <div className="de-progress-value" style={{ width: `${progress.value}%` }} />
        </div>
      </div>}

      <div className="de-stat-grid gap-px sm:grid-cols-2">
        {artifact.baseline != null && <div className="de-stat-cell"><p className="de-metadata">Baseline</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{formatNumber(artifact.baseline, numberOptions)}</p></div>}
        <div className="de-stat-cell"><p className="de-metadata">{gap > 0 ? "Gap to target" : gap < 0 ? "Beyond target" : "Target gap"}</p><p className="mt-1 font-mono text-[13.5px] font-semibold tabular-nums">{formatNumber(Math.abs(gap), numberOptions)}</p></div>
        <div className="de-stat-cell"><p className="de-metadata">Direction</p><p className="mt-1 text-[13.5px] font-medium">{directionLabel}</p></div>
        {artifact.deadline && <div className="de-stat-cell"><p className="de-metadata">Deadline</p><p className="mt-1 text-[13.5px] font-medium">{formatDeadline(artifact.deadline, locale)}</p></div>}
      </div>

      {artifact.insight && <p className="mt-4 flex gap-2 border-t de-divider pt-4 text-[13px] leading-5 text-muted-foreground"><TargetIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{artifact.insight}</p>}
    </ArtifactContent>
  </Artifact>;
}
