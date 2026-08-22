"use client";

import type { DataQualityArtifact as DataQualityArtifactData } from "@open-tessera/schema";
import { AlertTriangleIcon, CheckCircle2Icon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import { useArtifactAction } from "./bridge";
import { Artifact, ArtifactContent, ArtifactDescription, ArtifactHeader, ArtifactStatus, ArtifactTitle } from "./primitives";
import { shape } from "./tokens";
import { cn } from "./utils";

const checkStyle = {
  passed: { icon: CheckCircle2Icon, label: "Passed", className: "de-positive", surface: "de-positive-surface" },
  warning: { icon: AlertTriangleIcon, label: "Warning", className: "de-warning", surface: "de-warning-surface" },
  failed: { icon: XCircleIcon, label: "Failed", className: "de-negative", surface: "de-negative-surface" },
} as const;

export function DataQualityArtifact({ artifact, locale = "en-US" }: { artifact: DataQualityArtifactData; locale?: string }) {
  const emit = useArtifactAction(artifact);
  const updated = artifact.updatedAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(artifact.updatedAt)) : undefined;
  const score = Math.min(100, Math.max(0, artifact.score));
  const passedCount = artifact.checks.filter((check) => check.status === "passed").length;
  const attentionCount = artifact.checks.length - passedCount;

  return <Artifact>
    <ArtifactHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ArtifactTitle>{artifact.title}</ArtifactTitle>
          <ArtifactStatus icon={ShieldCheckIcon}>Quality</ArtifactStatus>
        </div>
        <ArtifactDescription>{artifact.description}</ArtifactDescription>
      </div>
    </ArtifactHeader>
    <ArtifactContent>
      <div className="de-field grid gap-5 px-4 py-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end sm:px-4">
        <div className="min-w-32">
          <p className="text-[13px] font-medium text-muted-foreground">Overall score</p>
          <p className="mt-1 text-4xl font-semibold leading-none tabular-nums">
            {artifact.score.toFixed(1)}
            <span className="ml-1 text-[13.5px] font-normal text-muted-foreground">/ 100</span>
          </p>
        </div>
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px]">
            <span><strong className="font-mono font-semibold text-foreground tabular-nums">{artifact.checks.length}</strong> <span className="text-muted-foreground">checks</span></span>
            <span><strong className="de-positive font-mono font-semibold tabular-nums">{passedCount}</strong> <span className="text-muted-foreground">passed</span></span>
            <span><strong className="de-warning font-mono font-semibold tabular-nums">{attentionCount}</strong> <span className="text-muted-foreground">need attention</span></span>
          </div>
          <div className="mb-1.5 flex justify-between text-[11px] tracking-tight font-medium text-muted-foreground"><span>Quality coverage</span><span className="tabular-nums">{score.toFixed(0)}%</span></div>
          <div aria-label={`Quality score ${score.toFixed(0)} percent`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={score} className="de-progress-track" role="progressbar">
            <div className="de-progress-value" style={{ width: `${score}%` }} />
          </div>
        </div>
      </div>

      <div className="de-list">
        {artifact.checks.map((check) => {
          const style = checkStyle[check.status];
          const Icon = style.icon;
          return <button className="de-quiet-button de-list-row grid w-full touch-manipulation grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 px-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/20 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:px-4" key={check.id} onClick={() => void emit("quality-check-select", { checkId: check.id })} type="button">
            <span className={cn("de-field grid size-8 shrink-0 place-items-center", shape.inner, style.surface, style.className)}>
              <Icon aria-hidden="true" className={`size-4 ${style.className}`} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{check.label}</span>
              <span className="mt-1 block text-pretty text-[13px] leading-5 text-muted-foreground">{check.detail}</span>
              <span className={`mt-2 inline-flex font-mono text-[11px] tracking-tight font-medium sm:hidden ${style.className}`}>{style.label}</span>
            </span>
            <span className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-start-auto sm:block sm:min-w-32 sm:text-right">
              <span className={`hidden font-mono text-[11px] tracking-tight font-medium sm:inline-flex ${style.className}`}>{style.label}</span>
              {check.observed != null && <span className="block font-mono text-[11px] tracking-tight tabular-nums text-muted-foreground sm:mt-2">Observed <strong className="font-medium text-foreground">{check.observed.toLocaleString(locale)}</strong>{check.threshold != null ? <> · limit <strong className="font-medium text-foreground">{check.threshold.toLocaleString(locale)}</strong></> : null}</span>}
            </span>
          </button>;
        })}
      </div>

      <div className="de-field flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[11px] text-muted-foreground sm:px-4">
        <span className="font-mono">{artifact.source}</span>
        {updated && <span>Updated {updated}</span>}
      </div>
    </ArtifactContent>
  </Artifact>;
}
